"""Background analysis service for the web app.

Stockfish and Maia are single instances, so all analyses run one at a time on a
single worker thread. Finished game reviews are cached as JSON under data/.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import chess

from ..engine import PROJECT_ROOT, Stockfish
from ..explain import after
from ..facts import position_facts, review_json
from ..importers import chesscom_raw_games, chesscom_summary, parse_pgn
from ..llm import LLMError, explain, narrate
from ..practical import Players, Searcher, Settings
from ..review import game_players, review_game
from ..winprob import format_cp


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error
    message: str = "In coda"
    fraction: float = 0.0
    result: dict | None = None
    error: str | None = None
    started: float = 0.0

    def public(self) -> dict:
        out = {k: getattr(self, k) for k in ("id", "kind", "status", "message", "fraction", "result", "error")}
        out["elapsed"] = round(time.time() - self.started, 1) if self.started else 0.0
        return out


@dataclass
class Service:
    data_dir: Path = PROJECT_ROOT / "data"
    model: str = "maia3-23m"
    threads: int = 8
    depth: int = 12
    settings: Settings = field(default_factory=Settings)

    def __post_init__(self):
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analysis")
        self._jobs: dict[str, Job] = {}
        self._review_jobs: dict[str, str] = {}  # game id -> job id
        self._games: dict[str, dict] = {}  # game id -> raw Chess.com game
        self._lock = threading.Lock()
        self._engine: Stockfish | None = None
        self._human = None
        (self.data_dir / "reviews").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "games").mkdir(parents=True, exist_ok=True)

    # -- engines --------------------------------------------------------------

    def _engines(self):
        if self._engine is None:
            from ..human import Maia3

            self._engine = Stockfish(threads=self.threads, depth=self.depth)
            self._human = Maia3(self.model)
        return self._engine, self._human

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        if self._engine is not None:
            self._engine.close()

    # -- games ----------------------------------------------------------------

    def list_games(self, username: str, limit: int = 30, time_class: str | None = None) -> list[dict]:
        raw = chesscom_raw_games(username, limit, time_class)
        out = []
        for g in raw:
            summary = chesscom_summary(g, username)
            self._games[summary["id"]] = g
            (self.data_dir / "games" / f"{summary['id']}.json").write_text(json.dumps(g), encoding="utf-8")
            summary["review"] = self._review_brief(summary["id"])
            out.append(summary)
        return out

    def _raw_game(self, game_id: str) -> dict:
        if game_id not in self._games:
            path = self.data_dir / "games" / f"{game_id}.json"
            if not path.exists():
                raise KeyError(game_id)
            self._games[game_id] = json.loads(path.read_text(encoding="utf-8"))
        return self._games[game_id]

    def game_moves(self, game_id: str, username: str) -> dict:
        """The game's moves for the board, before any analysis exists."""
        raw = self._raw_game(game_id)
        game = parse_pgn(raw["pgn"])
        board = game.board()
        plies = []
        for ply, move in enumerate(game.mainline_moves()):
            plies.append(
                {
                    "ply": ply,
                    "san": board.san(move),
                    "uci": move.uci(),
                    "color": "white" if board.turn == chess.WHITE else "black",
                    "move_number": board.fullmove_number,
                    "fen_before": board.fen(),
                    "fen_after": after(board, move).fen(),
                }
            )
            board.push(move)
        summary = chesscom_summary(raw, username)
        color = chess.WHITE if summary["user_color"] == "white" else chess.BLACK
        players = game_players(game, color, None, None)
        summary["user_maia_elo"], summary["opp_maia_elo"] = players.user_elo, players.opp_elo
        return {"summary": summary, "start_fen": game.board().fen(), "plies": plies}

    # -- reviews --------------------------------------------------------------

    def _review_path(self, game_id: str) -> Path:
        return self.data_dir / "reviews" / f"{game_id}.json"

    def _review_brief(self, game_id: str) -> dict | None:
        """What the game list shows about a finished review."""
        review = self.cached_review(game_id)
        if review is None:
            return None
        color = review["game"]["user_color"]
        kinds = [c.get("kind", "mistake") for c in review["critical"].values()]
        return {
            "accuracy": review["accuracy"].get(color),
            "mistakes": kinds.count("mistake"),
            "choices": kinds.count("choice"),
        }

    def cached_review(self, game_id: str) -> dict | None:
        path = self._review_path(game_id)
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def start_review(self, game_id: str, username: str) -> Job:
        with self._lock:
            existing = self._review_jobs.get(game_id)
            if existing and self._jobs[existing].status in ("queued", "running"):
                return self._jobs[existing]
            job = self._new_job("review")
            self._review_jobs[game_id] = job.id
        raw = self._raw_game(game_id)
        self._executor.submit(self._run, job, self._do_review, raw, game_id, username)
        return job

    def _do_review(self, job: Job, raw: dict, game_id: str, username: str) -> dict:
        engine, human = self._engines()
        game = parse_pgn(raw["pgn"])
        summary = chesscom_summary(raw, username)
        color = chess.WHITE if summary["user_color"] == "white" else chess.BLACK
        players = game_players(game, color, None, None)

        def progress(msg: str, fraction: float) -> None:
            job.message, job.fraction = msg, fraction

        review = review_game(game, engine, human, self.settings, players, progress=progress)
        narrations = {}
        analysed = [mr for mr in review.moves if mr.analysis is not None]
        for i, mr in enumerate(analysed, start=1):
            progress(f"Scrivo le spiegazioni {i}/{len(analysed)}", 0.9 + 0.1 * (i - 1) / len(analysed))
            facts = position_facts(mr.analysis, mr.played, mr.played_cp,
                                   mr.played_line.pv if mr.played_line else None, mr.kind)
            narrations[mr.ply] = narrate(mr.analysis, facts)
        result = review_json(review, narrations)
        result["game"]["id"] = game_id
        result["game"]["opening"] = summary["opening"]
        self._review_path(game_id).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return result

    def start_renarrate(self, game_id: str) -> Job:
        """Rewrite a cached review's explanations from its stored facts and drafts."""
        job = self._new_job("narrate")
        self._executor.submit(self._run, job, self._do_renarrate, game_id)
        return job

    def _do_renarrate(self, job: Job, game_id: str) -> dict:
        review = self.cached_review(game_id)
        if review is None:
            raise KeyError(game_id)
        items = list(review["critical"].values())
        for i, item in enumerate(items, start=1):
            job.message, job.fraction = f"Scrivo le spiegazioni {i}/{len(items)}", (i - 1) / len(items)
            drafts = (item.get("narration") or {}).get("drafts")
            try:
                data, model = explain(item["facts"], drafts)
                item["narration"] = {**data, "source": model, "drafts": drafts}
            except LLMError as exc:
                if item.get("narration"):
                    item["narration"]["error"] = str(exc)
        self._review_path(game_id).write_text(json.dumps(review, ensure_ascii=False), encoding="utf-8")
        return review

    # -- single positions -----------------------------------------------------

    def start_position(self, start_fen: str, moves: list[str], user_elo: int, opp_elo: int) -> Job:
        job = self._new_job("position")
        self._executor.submit(self._run, job, self._do_position, start_fen, moves, user_elo, opp_elo)
        return job

    def _do_position(self, job: Job, start_fen: str, moves: list[str], user_elo: int, opp_elo: int) -> dict:
        engine, human = self._engines()
        board = chess.Board(start_fen)
        for uci in moves:
            board.push_uci(uci)
        job.message, job.fraction = "Cerco le mosse candidate", 0.1
        players = Players(board.turn, user_elo, opp_elo)
        analysis = Searcher(engine, human, players, self.settings).analyse(board)
        job.message, job.fraction = "Scrivo la spiegazione", 0.85
        facts = position_facts(analysis)
        return {"facts": facts, "narration": narrate(analysis, facts), "eval": format_cp(analysis.best.line.cp)}

    # -- jobs -----------------------------------------------------------------

    def _new_job(self, kind: str) -> Job:
        job = Job(uuid.uuid4().hex[:12], kind)
        self._jobs[job.id] = job
        return job

    def job(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def _run(self, job: Job, fn, *args) -> None:
        job.status, job.message, job.started = "running", "Preparo i motori", time.time()
        try:
            job.result = fn(job, *args)
            job.status, job.fraction, job.message = "done", 1.0, "Fatto"
        except Exception as exc:  # surfaced to the UI
            job.status, job.error = "error", f"{type(exc).__name__}: {exc}"
