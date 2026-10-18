"""Background analysis service for the web app.

Stockfish and Maia are single instances, so locally all analyses run one at a time
on a single worker thread. On AWS (aws.py) the API hands each job to a worker Lambda
through `launch` instead, and the job's progress travels through the jobs store.
Games and finished reviews are JSON documents in `store` (data/ locally).
"""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import chess

from ..engine import PROJECT_ROOT, Stockfish
from ..explain import after
from ..facts import mark_played_options, position_facts, review_json
from ..importers import chesscom_raw_games, chesscom_summary, parse_pgn
from ..llm import LLMError, explain, narrate
from ..practical import Players, Searcher, Settings
from ..review import game_players, review_game
from ..winprob import format_cp
from .store import LocalStore, MemoryStore, Store

STATIC_DIR = Path(__file__).parent / "static"


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error
    message: str = "Queued"
    fraction: float = 0.0
    result: dict | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float = 0.0

    def public(self) -> dict:
        out = {k: getattr(self, k) for k in ("id", "kind", "status", "message", "fraction", "result", "error")}
        out["elapsed"] = round(time.time() - self.started, 1) if self.started else 0.0
        return out


@dataclass
class Service:
    store: Store = field(default_factory=lambda: LocalStore(PROJECT_ROOT / "data"))
    jobs: Store = field(default_factory=MemoryStore)
    # Hands a job to another process (the AWS worker); None runs it here on a thread.
    launch: Callable[[dict], None] | None = None
    job_timeout: float | None = None  # a job still running after this long has died
    save_every: float = 0.0  # minimum seconds between two progress writes of a job
    # Builds the human move model; None loads Maia-3 with torch (AWS passes the numpy one).
    human_model: Callable[[], object] | None = None
    model: str = "maia3-23m"
    threads: int = 12  # Stockfish threads in total, split across the workers
    workers: int = 3  # Stockfish instances analysing positions in parallel
    depth: int = 12
    settings: Settings = field(default_factory=Settings)

    def __post_init__(self):
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analysis")
        self._games: dict[str, dict] = {}  # game id -> raw Chess.com game
        self._saved: dict[str, float] = {}  # job id -> time of its last write
        self._lock = threading.Lock()
        self._pool: list[Stockfish] = []
        self._human = None

    # -- engines --------------------------------------------------------------

    def _engines(self) -> tuple[list[Stockfish], object]:
        if not self._pool:
            per_engine = max(1, self.threads // self.workers)
            self._pool = [Stockfish(threads=per_engine, hash_mb=256, depth=self.depth) for _ in range(self.workers)]
            if self.human_model:
                self._human = self.human_model()
            else:
                from ..maia import Maia3

                self._human = Maia3(self.model, threads=min(4, self.threads))
        return self._pool, self._human

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        for engine in self._pool:
            engine.close()

    # -- games ----------------------------------------------------------------

    def list_games(self, username: str, limit: int = 30, time_class: str | None = None) -> list[dict]:
        raw = chesscom_raw_games(username, limit, time_class)
        demos = [d for d in self.store.read_many(self.store.keys("games/demo"))
                 if d and (not time_class or d.get("time_class") == time_class)]
        out, unseen = [], []
        for g in demos + raw:
            summary = chesscom_summary(g, username)
            if summary["id"] not in self._games:
                unseen.append((summary["id"], g))
            self._games[summary["id"]] = g
            out.append(summary)
        # Save the games this process has not met yet, when the store lacks them too.
        stored = self.store.read_many([f"games/{gid}.json" for gid, _ in unseen])
        for (gid, g), existing in zip(unseen, stored):
            if existing is None:
                self.store.write(f"games/{gid}.json", g)
        reviews = self.store.read_many([self._review_key(s["id"]) for s in out])
        for summary, review in zip(out, reviews):
            summary["review"] = self._brief(mark_played_options(review)) if review else None
        return out

    def _raw_game(self, game_id: str) -> dict:
        if game_id not in self._games:
            raw = self.store.read(f"games/{game_id}.json")
            if raw is None:
                raise KeyError(game_id)
            self._games[game_id] = raw
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

    @staticmethod
    def _review_key(game_id: str) -> str:
        return f"reviews/{game_id}.json"

    def reviewed_ids(self) -> list[str]:
        return [key.removeprefix("reviews/").removesuffix(".json") for key in self.store.keys("reviews/")]

    def _review_brief(self, game_id: str) -> dict | None:
        review = self.cached_review(game_id)
        return self._brief(review) if review else None

    @staticmethod
    def _brief(review: dict) -> dict:
        """What the game list shows about a finished review."""
        color = review["game"]["user_color"]
        kinds = [c.get("kind", "mistake") for c in review["critical"].values()]
        return {
            "accuracy": review["accuracy"].get(color),
            "mistakes": kinds.count("mistake"),
            "choices": kinds.count("choice"),
        }

    def cached_review(self, game_id: str) -> dict | None:
        review = self.store.read(self._review_key(game_id))
        return mark_played_options(review) if review else None

    def start_review(self, game_id: str, username: str) -> Job:
        self._raw_game(game_id)  # KeyError before any job exists
        with self._lock:
            # One review per game at a time: asking again joins the running one.
            existing = self.job(f"review-{game_id}")
            if existing and existing.status in ("queued", "running"):
                return existing
            job = Job(f"review-{game_id}", "review")
            self._submit(job, game_id, username)
        return job

    def _do_review(self, job: Job, game_id: str, username: str) -> dict:
        engines, human = self._engines()
        raw = self._raw_game(game_id)
        game = parse_pgn(raw["pgn"])
        summary = chesscom_summary(raw, username)
        color = chess.WHITE if summary["user_color"] == "white" else chess.BLACK
        players = game_players(game, color, None, None)

        def progress(msg: str, fraction: float) -> None:
            self._progress(job, msg, fraction)

        review = review_game(game, engines, human, self.settings, players, progress=progress,
                             force_plies=tuple(raw.get("key_plies", ())))
        narrations = {}
        analysed = [mr for mr in review.moves if mr.analysis is not None]
        for i, mr in enumerate(analysed, start=1):
            progress(f"Writing the explanations {i}/{len(analysed)}", 0.9 + 0.1 * (i - 1) / len(analysed))
            facts = position_facts(mr.analysis, mr.played, mr.played_cp,
                                   mr.played_line.pv if mr.played_line else None, mr.kind)
            narrations[mr.ply] = narrate(mr.analysis, facts)
        result = review_json(review, narrations)
        result["game"]["id"] = game_id
        result["game"]["opening"] = summary["opening"]
        self.store.write(self._review_key(game_id), result)
        return result

    def start_renarrate(self, game_id: str) -> Job:
        """Rewrite a cached review's explanations from its stored facts and drafts."""
        job = self._new_job("narrate")
        self._submit(job, game_id)
        return job

    def _do_narrate(self, job: Job, game_id: str) -> dict:
        review = self.cached_review(game_id)
        if review is None:
            raise KeyError(game_id)
        items = list(review["critical"].values())
        for i, item in enumerate(items, start=1):
            self._progress(job, f"Writing the explanations {i}/{len(items)}", (i - 1) / len(items))
            drafts = (item.get("narration") or {}).get("drafts")
            try:
                data, model = explain(item["facts"], drafts)
                item["narration"] = {**data, "source": model, "drafts": drafts}
            except LLMError as exc:
                if item.get("narration"):
                    item["narration"]["error"] = str(exc)
        self.store.write(self._review_key(game_id), review)
        return review

    # -- single positions -----------------------------------------------------

    def start_position(self, start_fen: str, moves: list[str], user_elo: int, opp_elo: int) -> Job:
        job = self._new_job("position")
        self._submit(job, start_fen, moves, user_elo, opp_elo)
        return job

    def _do_position(self, job: Job, start_fen: str, moves: list[str], user_elo: int, opp_elo: int) -> dict:
        engines, human = self._engines()
        engine = engines[0]
        board = chess.Board(start_fen)
        for uci in moves:
            board.push_uci(uci)
        self._progress(job, "Finding candidate moves", 0.1)
        players = Players(board.turn, user_elo, opp_elo)
        analysis = Searcher(engine, human, players, self.settings).analyse(board)
        self._progress(job, "Writing the explanation", 0.85)
        facts = position_facts(analysis)
        return {"facts": facts, "narration": narrate(analysis, facts), "eval": format_cp(analysis.best.line.cp)}

    # -- jobs -----------------------------------------------------------------

    def _new_job(self, kind: str) -> Job:
        return Job(uuid.uuid4().hex[:12], kind)

    def job(self, job_id: str) -> Job | None:
        data = self.jobs.read(f"jobs/{job_id}.json")
        if data is None:
            return None
        job = Job(**data)
        if (self.job_timeout and job.status in ("queued", "running")
                and time.time() - (job.started or job.created) > self.job_timeout):
            job.status, job.error = "error", "The analysis stopped before finishing: try again"
        return job

    def _save(self, job: Job) -> None:
        self._saved[job.id] = time.time()
        self.jobs.write(f"jobs/{job.id}.json", asdict(job))

    def _progress(self, job: Job, message: str, fraction: float) -> None:
        job.message, job.fraction = message, fraction
        if time.time() - self._saved.get(job.id, 0.0) >= self.save_every:
            self._save(job)

    def _submit(self, job: Job, *args) -> None:
        self._save(job)
        if self.launch:
            self.launch({"job": job.id, "args": list(args)})
        else:
            self._executor.submit(self._run, job, *args)

    def run(self, job_id: str, args: list) -> None:
        """Run a job that `launch` handed to this process."""
        job = self.job(job_id)
        if job is not None and job.status == "queued":
            self._run(job, *args)

    def _run(self, job: Job, *args) -> None:
        task = {"review": self._do_review, "narrate": self._do_narrate, "position": self._do_position}[job.kind]
        job.status, job.message, job.started = "running", "Starting the engines", time.time()
        self._save(job)
        try:
            job.result = task(job, *args)
            job.status, job.fraction, job.message = "done", 1.0, "Done"
        except Exception as exc:  # surfaced to the UI
            job.status, job.error = "error", f"{type(exc).__name__}: {exc}"
        self._save(job)
