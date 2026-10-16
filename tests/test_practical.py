"""Expectimax semantics, checked against a stub engine and a stub human model."""

import chess
import pytest

from smartchess.engine import LineEval
from smartchess.human import HumanMove, top_moves
from smartchess.practical import Players, Searcher, Settings
from smartchess.winprob import win_pct


class StubEngine:
    """Evals keyed by UCI move, from the mover's POV; unknown moves score `default`."""

    def __init__(self, evals: dict[str, int], default: int = -300):
        self.evals = evals
        self.default = default

    def analyse(self, board, multipv=1, moves=None, depth=None, max_time=None):
        moves = moves or list(board.legal_moves)
        lines = [LineEval(m, self.evals.get(m.uci(), self.default), (m,)) for m in moves]
        lines.sort(key=lambda line: line.cp, reverse=True)
        return lines if moves else lines[:multipv]

    def best(self, board):
        return self.analyse(board)[0]

    def evaluate_moves(self, board, moves):
        return {line.move: line for line in self.analyse(board, moves=moves)}


class StubHuman:
    def __init__(self, probs: dict[str, float]):
        self.probs = probs

    def policy(self, board, elo_self, elo_oppo):
        moves = [HumanMove(chess.Move.from_uci(u), p) for u, p in self.probs.items()
                 if chess.Move.from_uci(u) in board.legal_moves]
        return sorted(moves, key=lambda hm: hm.prob, reverse=True)


def after_e4():
    board = chess.Board()
    board.push_san("e4")
    return board


def test_top_moves_stops_at_mass_and_cap():
    policy = [HumanMove(chess.Move.null(), p) for p in (0.5, 0.3, 0.15, 0.05)]
    assert len(top_moves(policy, mass=0.75, max_moves=5)) == 2
    assert len(top_moves(policy, mass=0.99, max_moves=3)) == 3


def test_opponent_unexplored_mass_gets_its_best_reply():
    # Black (opponent) to move; Maia covers only 70% of the mass.
    engine = StubEngine({"e7e5": 0, "c7c5": -100, "d7d5": 50})
    human = StubHuman({"e7e5": 0.5, "c7c5": 0.2})
    s = Searcher(engine, human, Players(chess.WHITE, 1700, 1700), Settings(human_mass=0.99))
    node = s.expand(after_e4(), 1, frozenset({chess.WHITE, chess.BLACK}))
    expected = 0.5 * (100 - win_pct(0)) + 0.2 * (100 - win_pct(-100)) + 0.3 * (100 - win_pct(50))
    assert node.value == pytest.approx(expected)


def test_user_moves_are_renormalised():
    engine = StubEngine({"e2e4": 30, "d2d4": 20})
    human = StubHuman({"e2e4": 0.6, "d2d4": 0.3})
    s = Searcher(engine, human, Players(chess.WHITE, 1700, 1700), Settings(human_mass=0.99))
    node = s.expand(chess.Board(), 1, frozenset({chess.WHITE}))
    assert node.value == pytest.approx((0.6 * win_pct(30) + 0.3 * win_pct(20)) / 0.9)


def test_engine_node_follows_best_move():
    engine = StubEngine({"e7e5": 0, "d7d5": 50})
    s = Searcher(engine, StubHuman({}), Players(chess.WHITE, 1700, 1700), Settings())
    node = s.expand(after_e4(), 1, frozenset({chess.WHITE}))
    assert node.kind == "engine"
    assert node.edges[0].move == chess.Move.from_uci("d7d5")
    assert node.value == pytest.approx(100 - win_pct(50))


def test_candidates_respect_margin_and_traps_are_detected():
    # White to move: e4 (+40) and d4 (+10) are within 0.4, a3 (-60) is not.
    # After d4, Black's likely reply e5 is a blunder (-300 for Black).
    engine = StubEngine({"e2e4": 40, "d2d4": 10, "a2a3": -60, "e7e5": -300, "d7d5": 10}, default=-500)
    human = StubHuman({"e2e4": 0.5, "d2d4": 0.4, "e7e5": 0.6, "d7d5": 0.4})
    s = Searcher(engine, human, Players(chess.WHITE, 1700, 1700), Settings(human_mass=0.99, margin_cp=40, tricky_margin_cp=40))
    analysis = s.analyse(chess.Board())
    moves = [c.move.uci() for c in analysis.candidates]
    assert moves == ["e2e4", "d2d4"]
    d4 = analysis.candidates[1]
    assert [t.reply.uci() for t in d4.traps] == ["e7e5"]
    assert d4.error_prob == pytest.approx(0.6)
    assert analysis.trickiest.move.uci() == "d2d4"
    assert analysis.best.move.uci() == "e2e4"


def test_simple_move_uses_the_narrower_margin():
    # e4 +40, d4 0, c4 -50: with margins 0.5 (simple) and 1.0 (tricky), c4 can only be tricky.
    engine = StubEngine({"e2e4": 40, "d2d4": 0, "c2c4": -50, "e7e5": 0, "d7d5": 0, "e7e6": 0, "c7c5": 0}, default=-500)
    human = StubHuman({"e2e4": 0.2, "d2d4": 0.2, "c2c4": 0.5, "e7e5": 0.5, "d7d5": 0.5, "e7e6": 0.5, "c7c5": 0.5})
    s = Searcher(engine, human, Players(chess.WHITE, 1700, 1700), Settings(human_mass=0.99, margin_cp=50, tricky_margin_cp=100))
    analysis = s.analyse(chess.Board())
    assert [c.move.uci() for c in analysis.candidates] == ["e2e4", "d2d4", "c2c4"]
    assert [c.move.uci() for c in analysis.simple_candidates] == ["e2e4", "d2d4"]
