"""Map platform ratings to the scale Maia-3 was trained on (Lichess blitz).

The Chess.com table is a rough estimate from public rating comparisons; a
per-user calibration (maximum likelihood over the user's own moves) should
replace it. Use --elo to override.
"""

from __future__ import annotations

# (Chess.com rating, Maia/Lichess-equivalent rating)
CHESSCOM_TABLE = [
    (400, 900),
    (800, 1200),
    (1000, 1400),
    (1400, 1700),
    (1800, 1975),
    (2200, 2275),
    (2600, 2600),
]


def _interpolate(table: list[tuple[int, int]], x: float) -> int:
    if x <= table[0][0]:
        return table[0][1] - (table[0][0] - x)
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x <= x1:
            return round(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
    return round(table[-1][1] + (x - table[-1][0]))


def to_maia_elo(rating: int, site: str = "") -> int:
    if "chess.com" in site.lower():
        return _interpolate(CHESSCOM_TABLE, rating)
    return rating
