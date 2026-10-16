import pytest

from smartchess.ratings import to_maia_elo
from smartchess.winprob import MATE_CP, cp_from_win, format_cp, margin_win, win_pct


def test_win_pct_is_symmetric_around_50():
    assert win_pct(0) == 50
    assert win_pct(150) + win_pct(-150) == pytest.approx(100)


def test_cp_from_win_inverts_win_pct():
    for cp in (-600, -40, 0, 75, 300):
        assert cp_from_win(win_pct(cp)) == pytest.approx(cp, abs=0.5)


def test_margin_allows_more_pawns_when_winning():
    m = margin_win(40)
    assert m == pytest.approx(3.68, abs=0.01)
    # The same win% margin is worth more centipawns at +4 than at 0.
    assert cp_from_win(win_pct(400) - m) < 400 - 60


def test_format_cp():
    assert format_cp(85) == "+0.85"
    assert format_cp(-120) == "-1.20"
    assert format_cp(MATE_CP - 3) == "#2"
    assert format_cp(-(MATE_CP - 1)) == "#-1"


def test_chesscom_ratings_are_shifted_lichess_unchanged():
    assert to_maia_elo(1400, "Chess.com") == 1700
    assert to_maia_elo(1200, "Chess.com") == 1550
    assert to_maia_elo(1400, "lichess.org") == 1400
