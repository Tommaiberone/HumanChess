"""Stockfish wrapper: the objective oracle.

Every search result is cached by position. A search over a set of root moves also
records, for each child position, its eval and the best reply taken from the PV, so
the expectimax in `practical.py` rarely needs to search a child again.
"""

from __future__ import annotations

import glob
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import chess
import chess.engine

from .winprob import MATE_CP, win_pct

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class LineEval:
    """A root move with its eval from the POV of the side to move at the root."""

    move: chess.Move
    cp: int
    pv: tuple[chess.Move, ...]

    @property
    def win(self) -> float:
        return win_pct(self.cp)


def find_stockfish() -> str:
    env = os.environ.get("SMARTCHESS_STOCKFISH")
    if env:
        return env
    bundled = sorted(glob.glob(str(PROJECT_ROOT / "engines" / "stockfish" / "**" / "stockfish*.exe"), recursive=True))
    if bundled:
        return bundled[0]
    on_path = shutil.which("stockfish")
    if on_path:
        return on_path
    raise FileNotFoundError(
        "Stockfish not found. Put it under engines/stockfish/ or set SMARTCHESS_STOCKFISH."
    )


def _key(board: chess.Board) -> str:
    # Drop the move counters so transpositions share cache entries.
    return " ".join(board.fen().split()[:4])


class Stockfish:
    def __init__(
        self,
        path: str | None = None,
        threads: int = 8,
        hash_mb: int = 512,
        depth: int = 12,
        max_time: float = 1.0,
    ):
        self._engine = chess.engine.SimpleEngine.popen_uci(path or find_stockfish())
        self._engine.configure({"Threads": threads, "Hash": hash_mb})
        self.depth = depth
        # Some sparse endgames take minutes to reach a modest depth with MultiPV,
        # so every search is also capped in time.
        self.max_time = max_time
        self._best: dict[str, LineEval] = {}
        self._best_depth: dict[str, int] = {}
        self._moves: dict[tuple[str, chess.Move], LineEval] = {}
        self.searches = 0

    def close(self) -> None:
        self._engine.quit()

    def __enter__(self) -> Stockfish:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def analyse(
        self,
        board: chess.Board,
        multipv: int = 1,
        moves: list[chess.Move] | None = None,
        depth: int | None = None,
        max_time: float | None = None,
    ) -> list[LineEval]:
        """Search `board` and return lines sorted best first (side-to-move POV)."""
        if moves is not None:
            multipv = len(moves)
        multipv = max(1, min(multipv, board.legal_moves.count()))
        depth = depth or self.depth
        infos = self._engine.analyse(
            board,
            chess.engine.Limit(depth=depth, time=max_time or self.max_time),
            multipv=multipv,
            root_moves=moves,
        )
        self.searches += 1
        lines = []
        for info in infos:
            pv = info.get("pv")
            if not pv:
                continue
            cp = info["score"].pov(board.turn).score(mate_score=MATE_CP)
            lines.append(LineEval(pv[0], cp, tuple(pv)))
        lines.sort(key=lambda line: line.cp, reverse=True)
        self._remember(board, lines, complete=moves is None, depth=depth)
        return lines

    def _set_best(self, key: str, line: LineEval, depth: int) -> None:
        # Keep whichever search looked deeper at this position.
        if depth > self._best_depth.get(key, -1):
            self._best[key] = line
            self._best_depth[key] = depth

    def _remember(self, board: chess.Board, lines: list[LineEval], complete: bool, depth: int) -> None:
        key = _key(board)
        for line in lines:
            self._moves[(key, line.move)] = line
            # Every position along a PV has the same minimax value, with the sign
            # flipping each ply, and its best move is the next PV move.
            b = board.copy(stack=False)
            cp = line.cp
            for i in range(len(line.pv) - 1):
                b.push(line.pv[i])
                cp = -cp
                self._set_best(_key(b), LineEval(line.pv[i + 1], cp, line.pv[i + 1 :]), depth - i - 1)
        if complete and lines:
            self._set_best(key, lines[0], depth)

    def best(self, board: chess.Board) -> LineEval:
        key = _key(board)
        if key not in self._best:
            self.analyse(board)
        return self._best[key]

    def evaluate_moves(self, board: chess.Board, moves: list[chess.Move]) -> dict[chess.Move, LineEval]:
        key = _key(board)
        missing = [m for m in moves if (key, m) not in self._moves]
        if missing:
            self.analyse(board, moves=missing)
        # Stockfish occasionally drops a root move from a MultiPV answer.
        for m in moves:
            if (key, m) not in self._moves:
                self.analyse(board, moves=[m])
        return {m: self._moves[(key, m)] for m in moves}
