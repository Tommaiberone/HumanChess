"""Human move model: what the practical search needs from a model of human play.

The implementation is Maia-3 (`maia.py`). It imports torch, so it lives apart and the
web API can start without loading it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import chess


@dataclass(frozen=True)
class HumanMove:
    move: chess.Move
    prob: float


class HumanModel(Protocol):
    def policy(self, board: chess.Board, elo_self: int, elo_oppo: int) -> list[HumanMove]:
        """All legal moves with their probability, most likely first."""
        ...


def top_moves(policy: list[HumanMove], mass: float, max_moves: int, min_prob: float = 0.01) -> list[HumanMove]:
    """Smallest prefix of `policy` covering `mass`, capped at `max_moves`."""
    chosen: list[HumanMove] = []
    total = 0.0
    for hm in policy:
        if len(chosen) >= max_moves or total >= mass:
            break
        if chosen and hm.prob < min_prob:
            break
        chosen.append(hm)
        total += hm.prob
    return chosen
