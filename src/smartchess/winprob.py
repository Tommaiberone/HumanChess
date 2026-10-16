"""Centipawn <-> win-percentage conversions (Lichess accuracy model).

Working in win% instead of centipawns makes a fixed margin behave sensibly:
0.4 pawns matter a lot in a balanced position and very little at +6.
"""

from __future__ import annotations

import math

# Constant from https://lichess.org/page/accuracy
K = 0.00368208

# Mate scores are mapped to this many centipawns (minus distance to mate).
MATE_CP = 10_000


def win_pct(cp: float) -> float:
    """Win percentage (0-100) for the side whose POV `cp` is in."""
    return 50 + 50 * (2 / (1 + math.exp(-K * cp)) - 1)


def cp_from_win(win: float) -> float:
    """Inverse of `win_pct`, clamped to stay finite near 0 and 100."""
    w = min(max(win, 0.01), 99.99)
    return -math.log(2 / (1 + (w - 50) / 50) - 1) / K


def margin_win(margin_cp: float) -> float:
    """Win% equivalent of a centipawn margin measured in a balanced position."""
    return win_pct(margin_cp) - 50


def format_cp(cp: float) -> str:
    """Human-readable eval, e.g. '+0.85', '-1.20', '#5', '#-3'."""
    if abs(cp) >= MATE_CP - 500:
        plies = MATE_CP - abs(cp)
        moves = max(1, math.ceil(plies / 2))
        return f"#{moves}" if cp > 0 else f"#-{moves}"
    return f"{cp / 100:+.2f}"
