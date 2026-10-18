"""Game review: find the user's critical positions and analyse them in depth.

A cheap Stockfish pass over every user move picks the positions worth a full
practical analysis: the user's mistakes, and positions where the best move is hard
to find for a human at the user's level while alternatives exist.
"""

from __future__ import annotations

import math
import queue
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable

import chess
import chess.pgn

from .engine import LineEval, Stockfish
from .human import HumanModel
from .practical import Players, PositionAnalysis, Searcher, Settings
from .ratings import to_maia_elo
from .winprob import MATE_CP, margin_win, win_pct

DEFAULT_ELO = to_maia_elo(1400, "chess.com")

# A move that loses this many win% points is reviewed as a mistake ("inaccuracy" or worse).
MISTAKE_LOSS = 6.0
# A practical choice is kept only if the simple or tricky move beats the best move by
# this many win% points at the user's level or against a human.
CHOICE_GAIN = 3.0
# Win% of the best move for a position to be considered for a practical choice.
CHOICE_WIN_RANGE = (15.0, 85.0)


@dataclass
class MoveReview:
    ply: int
    board: chess.Board  # position before the user's move, with game history
    played: chess.Move
    played_cp: int  # user POV
    best_cp: int
    analysis: PositionAnalysis | None = None
    kind: str = "mistake"  # "mistake": the user lost a lot; "choice": a practical alternative
    played_line: LineEval | None = None
    gain: float = 0.0  # for choices: win% gained by the simple or tricky move over the best

    @property
    def loss(self) -> float:
        """Win% points lost by the played move according to the quick pass."""
        return win_pct(self.best_cp) - win_pct(self.played_cp)


@dataclass
class PlyInfo:
    """Quick-pass facts about one move of the game (either side)."""

    ply: int
    board: chess.Board  # before the move, with history
    move: chess.Move
    best: LineEval  # mover POV
    cp_after: int = 0  # eval after the move, mover POV

    @property
    def loss(self) -> float:
        if self.move == self.best.move:
            return 0.0
        return max(0.0, win_pct(self.best.cp) - win_pct(self.cp_after))

    @property
    def judgement(self) -> str:
        """Gentler thresholds than Lichess (5/10/15): this is a cozy review."""
        loss = self.loss
        if self.move == self.best.move:
            return "best"
        if loss < 2:
            return "excellent"
        if loss < 6:
            return "good"
        if loss < 12:
            return "inaccuracy"
        if loss < 20:
            return "mistake"
        return "blunder"

    @property
    def accuracy(self) -> float:
        """Lichess per-move accuracy from the win% drop."""
        return min(100.0, max(0.0, 103.1668 * math.exp(-0.04354 * self.loss) - 3.1669))


@dataclass
class GameReview:
    game: chess.pgn.Game
    players: Players
    moves: list[MoveReview]  # positions analysed in depth
    plies: list[PlyInfo] = field(default_factory=list)

    def accuracy(self, color: chess.Color) -> float | None:
        values = [p.accuracy for p in self.plies if p.board.turn == color]
        return sum(values) / len(values) if values else None


def detect_user_color(game: chess.pgn.Game, username: str | None) -> chess.Color | None:
    if not username:
        return None
    name = username.lower()
    if game.headers.get("White", "").lower() == name:
        return chess.WHITE
    if game.headers.get("Black", "").lower() == name:
        return chess.BLACK
    return None


def _header_elo(game: chess.pgn.Game, color: chess.Color) -> int | None:
    value = game.headers.get("WhiteElo" if color == chess.WHITE else "BlackElo", "")
    return int(value) if value.isdigit() else None


def game_players(game: chess.pgn.Game, color: chess.Color, user_elo: int | None, opp_elo: int | None) -> Players:
    site = game.headers.get("Site", "")
    if user_elo is None:
        raw = _header_elo(game, color)
        user_elo = to_maia_elo(raw, site) if raw else DEFAULT_ELO
    if opp_elo is None:
        raw = _header_elo(game, not color)
        opp_elo = to_maia_elo(raw, site) if raw else user_elo
    return Players(color, user_elo, opp_elo)


def _stderr(msg: str, fraction: float = 0.0) -> None:
    print(msg, file=sys.stderr, flush=True)


def _parallel(engines: list[Stockfish], fn, items: list, on_done: Callable[[int], None]) -> list:
    """fn(engine, item) for every item, each call borrowing one engine from the pool.

    Results keep the order of `items`; `on_done(n)` reports completions.
    """
    if len(engines) == 1:
        out = []
        for i, item in enumerate(items):
            out.append(fn(engines[0], item))
            on_done(i + 1)
        return out
    free: queue.Queue = queue.Queue()
    for e in engines:
        free.put(e)

    def run(item):
        engine = free.get()
        try:
            return fn(engine, item)
        finally:
            free.put(engine)

    results: list = [None] * len(items)
    lock = threading.Lock()
    done = 0
    with ThreadPoolExecutor(max_workers=len(engines)) as pool:
        futures = {pool.submit(run, item): i for i, item in enumerate(items)}
        for future in as_completed(futures):
            results[futures[future]] = future.result()
            with lock:
                done += 1
                on_done(done)
    return results


def review_game(
    game: chess.pgn.Game,
    engine: Stockfish | list[Stockfish],
    human: HumanModel,
    settings: Settings,
    players: Players,
    max_mistakes: int = 5,
    max_choices: int = 5,
    choice_pool: int = 6,
    skip_plies: int = 6,
    prepass_depth: int = 14,
    progress: Callable[[str, float], None] = _stderr,
    force_plies: tuple[int, ...] = (),
) -> GameReview:
    """Two kinds of key moments, each with its own budget.

    Mistakes mostly happen where only one move holds, so the three analyses agree
    there. Practical choices are positions with several near-equal moves where the
    best one is hard to find for a human: that is where "simple" and "tricky"
    have something to say, and we keep only those where they actually differ.
    """
    engines = engine if isinstance(engine, list) else [engine]
    color = players.user
    threshold = margin_win(max(settings.margin_cp, settings.tricky_margin_cp))
    moves = list(game.mainline_moves())
    board = game.board()
    plies: list[PlyInfo] = []
    candidate_lines: dict[int, list[LineEval]] = {}

    # Pass 1: every position, so that each move gets an eval and a judgement.
    positions = []
    for ply, move in enumerate(moves):
        positions.append((ply, board.copy(), move))
        board.push(move)

    def quick(engine: Stockfish, item):
        ply, b, _ = item
        return engine.analyse(b, multipv=settings.multipv if b.turn == color else 1, depth=prepass_depth, max_time=2.0)

    all_lines = _parallel(engines, quick, positions, lambda n: progress(
        f"Evaluating every move: {n}/{len(moves)}", 0.5 * n / max(1, len(moves))))
    for (ply, b, move), lines in zip(positions, all_lines):
        plies.append(PlyInfo(ply, b, move, lines[0]))
        if b.turn == color:
            candidate_lines[ply] = lines
    final_cp = _final_cp(board, engines[0], prepass_depth)
    for i, info in enumerate(plies):
        # The eval after a move is the next position's eval, seen from the mover.
        info.cp_after = -(plies[i + 1].best.cp if i + 1 < len(plies) else final_cp)

    # Pick the user's positions worth a full practical analysis.
    mistakes: list[PlyInfo] = []
    pool: list[tuple[float, PlyInfo]] = []
    for info in plies:
        lines = candidate_lines.get(info.ply)
        if lines is None or info.ply < skip_plies or not 3 < info.best.win < 97:
            continue  # decided positions teach little
        if info.loss >= MISTAKE_LOSS:
            mistakes.append(info)
            continue
        # Practical choices only matter while the game is open: near 0% or 100% the
        # win% curve is flat and no alternative can gain anything.
        if not CHOICE_WIN_RANGE[0] < info.best.win < CHOICE_WIN_RANGE[1]:
            continue
        alternatives = [line for line in lines if info.best.win - line.win <= threshold]
        if len(alternatives) < 2 or all(line.cp == info.best.cp for line in alternatives):
            continue  # a single option, or a dead draw where every move is the same
        policy = {hm.move: hm.prob for hm in human.policy(info.board, players.user_elo, players.opp_elo)}
        best_nat = policy.get(info.best.move, 0.0)
        if best_nat >= 0.3:
            continue
        # The more natural an alternative is compared to the best move, and the more
        # balanced the position, the more likely a practical choice exists.
        balance = 1 - abs(info.best.win - 50) / 50
        pool.append(((max(policy.get(line.move, 0.0) for line in alternatives) - best_nat) * balance, info))
    mistakes = sorted(mistakes, key=lambda i: i.loss, reverse=True)[:max_mistakes]
    pool_infos = [info for _, info in sorted(pool, key=lambda x: x[0], reverse=True)[:choice_pool]]
    # Demo games can name moments that must be shown, whatever the heuristics say.
    chosen_plies = {i.ply for i in mistakes} | {i.ply for i in pool_infos}
    forced = [p for p in plies if p.ply in force_plies and p.ply not in chosen_plies]

    todo = [(info, "mistake") for info in mistakes] + [(info, "choice") for info in pool_infos + forced]

    def deep(engine: Stockfish, item) -> MoveReview:
        info, kind = item
        review = MoveReview(info.ply, info.board, info.move, info.cp_after, info.best.cp, kind=kind)
        review.analysis = a = Searcher(engine, human, players, settings).analyse(info.board)
        # Report the deeper evals so the header matches the advice below it.
        review.best_cp = a.best.line.cp
        played = next((c.line for c in a.candidates if c.move == review.played), None)
        if played is None:
            played = engine.analyse(info.board, moves=[review.played], depth=settings.root_depth, max_time=settings.root_time)[0]
        review.played_cp = played.cp
        review.played_line = played
        return review

    analysed = _parallel(engines, deep, todo, lambda n: progress(
        f"Analysing the key moments: {n}/{len(todo)}", 0.5 + 0.4 * n / max(1, len(todo))))
    kept: list[MoveReview] = []  # mistakes, and practical options the user played
    choices: list[MoveReview] = []
    for review in analysed:
        a = review.analysis
        if review.kind == "mistake" and review.played != a.best.move:
            if review.played in (a.simplest.move, a.trickiest.move):
                # The quick pass saw a loss, but the deep search counts the played move
                # among the options: the user made a practical choice, not a mistake.
                review.kind = "choice"
            kept.append(review)
            continue
        # A "mistake" that the deep search finds best was misjudged by the quick pass:
        # like any choice, it stays only if the alternatives have something to say.
        review.kind = "choice"
        if review.ply not in force_plies:
            review.gain = max(a.simplest.simple - a.best.simple, a.trickiest.tricky - a.best.tricky)
            differs = a.simplest.move != a.best.move or a.trickiest.move != a.best.move
            if not differs or review.gain < CHOICE_GAIN:
                continue
        choices.append(review)

    choices = sorted(choices, key=lambda r: r.gain, reverse=True)[:max_choices]
    chosen = sorted(kept + choices, key=lambda r: r.ply)
    return GameReview(game, players, chosen, plies)


def _final_cp(board: chess.Board, engine: Stockfish, depth: int) -> int:
    """Eval of the final position, side-to-move POV."""
    outcome = board.outcome(claim_draw=True)
    if outcome is not None:
        return -MATE_CP if outcome.winner is not None else 0
    return engine.analyse(board, depth=depth, max_time=2.0)[0].cp
