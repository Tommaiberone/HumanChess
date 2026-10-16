"""Practical move selection.

For a position where the user is to move, Stockfish gives the candidate moves that
stay close to the best one (measured in win%): within `margin_cp` for the simple move
and within the wider `tricky_margin_cp` for the tricky one. Each candidate is then
scored by three expectimax searches that differ only in who plays "perfectly":

    objective  engine vs engine         -> plain Stockfish eval
    simple     engine opponent, human user  -> can *I* keep this up at my level?
    tricky     human opponent, human user   -> what does it score against a real
                                               opponent, when I must also find the
                                               punishment myself?

Human nodes are chance nodes weighted by Maia; engine nodes follow Stockfish's best
move; leaves are Stockfish evals. All values are win% from the user's POV.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import chess

from .engine import LineEval, Stockfish
from .human import HumanModel, top_moves
from .winprob import margin_win


@dataclass
class Settings:
    # Max centipawns (in a balanced position) the simple move may give up. Measured on
    # the user's games: a wider margin barely helps the simple move, whose limit is
    # the practical gain, but it doubles the useful tricky moves at 1 pawn.
    margin_cp: float = 60
    tricky_margin_cp: float = 100
    multipv: int = 8
    max_candidates: int = 6
    root_depth: int = 18
    root_time: float = 6.0
    human_mass: float = 0.9
    human_max_moves: int = 5
    simple_plies: int = 4
    tricky_plies: int = 2
    # An opponent reply is a "mistake" when it hands the user this many win% points.
    error_drop: float = 10.0


@dataclass(frozen=True)
class Players:
    user: chess.Color
    user_elo: int
    opp_elo: int

    def elo(self, color: chess.Color) -> int:
        return self.user_elo if color == self.user else self.opp_elo


@dataclass
class Edge:
    move: chess.Move
    prob: float
    objective: float  # engine eval right after the move, user POV win%
    value: float  # expected value of the subtree
    child: Node | None = None


@dataclass
class Node:
    board: chess.Board
    kind: str  # "leaf" | "engine" | "human" | "terminal"
    value: float
    best: LineEval | None = None
    edges: list[Edge] = field(default_factory=list)
    covered: float = 1.0  # probability mass of the explored human moves


@dataclass
class Trap:
    """An opponent reply that is a mistake, and how the user can punish it."""

    reply: chess.Move
    prob: float
    objective_after: float
    punishment: chess.Move | None
    find_prob: float
    realized: float  # expected value after the reply, given the user's human follow-up


@dataclass
class Moment:
    """The point in a line where the user is most likely to go wrong."""

    path: list[chess.Move]  # moves from the candidate's resulting position
    board: chess.Board
    needed: chess.Move
    find_prob: float
    loss: float  # expected win% lost right here by playing like a human
    weight: float


@dataclass
class Candidate:
    line: LineEval
    objective: float
    simple: float
    tricky: float
    naturalness: float  # Maia probability that the user would play it
    simple_tree: Node
    tricky_tree: Node
    traps: list[Trap]
    hardest: Moment | None

    @property
    def move(self) -> chess.Move:
        return self.line.move

    @property
    def error_prob(self) -> float:
        return sum(t.prob for t in self.traps)


@dataclass
class PositionAnalysis:
    board: chess.Board
    players: Players
    candidates: list[Candidate]  # best (objective) first, all within the tricky margin
    simple_margin: float = 100.0  # win% points the simple move may give up

    @property
    def best(self) -> Candidate:
        return self.candidates[0]

    @property
    def simple_candidates(self) -> list[Candidate]:
        return [c for c in self.candidates if self.best.objective - c.objective <= self.simple_margin]

    @property
    def simplest(self) -> Candidate:
        return max(self.simple_candidates, key=lambda c: (round(c.simple, 1), c.naturalness))

    @property
    def trickiest(self) -> Candidate:
        return max(self.candidates, key=lambda c: (round(c.tricky, 1), c.error_prob))


class Searcher:
    def __init__(self, engine: Stockfish, human: HumanModel, players: Players, settings: Settings):
        self.engine = engine
        self.human = human
        self.players = players
        self.settings = settings

    # -- values -------------------------------------------------------------

    def _user_win(self, line: LineEval, mover: chess.Color) -> float:
        return line.win if mover == self.players.user else 100 - line.win

    def _terminal(self, board: chess.Board) -> float:
        winner = board.outcome(claim_draw=True).winner
        if winner is None:
            return 50.0
        return 100.0 if winner == self.players.user else 0.0

    def _policy(self, board: chess.Board):
        mover = board.turn
        policy = self.human.policy(board, self.players.elo(mover), self.players.elo(not mover))
        return top_moves(policy, self.settings.human_mass, self.settings.human_max_moves)

    # -- expectimax ---------------------------------------------------------

    def expand(self, board: chess.Board, plies: int, human_sides: frozenset[chess.Color]) -> Node:
        if board.is_game_over(claim_draw=True):
            return Node(board, "terminal", self._terminal(board))
        mover = board.turn
        best = self.engine.best(board)
        best_value = self._user_win(best, mover)
        if plies == 0:
            return Node(board, "leaf", best_value, best)

        hms = self._policy(board) if mover in human_sides else []
        if not hms:
            edge = self._edge(board, best.move, 1.0, best_value, plies, human_sides)
            return Node(board, "engine", edge.value, best, [edge])

        evals = self.engine.evaluate_moves(board, [hm.move for hm in hms])
        edges = [
            self._edge(board, hm.move, hm.prob, self._user_win(evals[hm.move], mover), plies, human_sides)
            for hm in hms
        ]
        covered = sum(e.prob for e in edges)
        if mover == self.players.user:
            # The user's unlikely moves are dropped and the rest renormalised.
            value = sum(e.prob * e.value for e in edges) / covered
        else:
            # The opponent's unexplored mass is assumed to find the best reply,
            # so we never count on mistakes the model cannot see.
            best_edge = next((e for e in edges if e.move == best.move), None)
            if best_edge is None:
                best_edge = self._edge(board, best.move, 0.0, best_value, plies, human_sides)
            value = sum(e.prob * e.value for e in edges) + (1 - covered) * best_edge.value
        return Node(board, "human", value, best, edges, covered)

    def _edge(self, board, move, prob, objective, plies, human_sides) -> Edge:
        if plies == 1:
            return Edge(move, prob, objective, objective)
        child_board = board.copy()
        child_board.push(move)
        child = self.expand(child_board, plies - 1, human_sides)
        return Edge(move, prob, objective, child.value, child)

    # -- facts for explanations ---------------------------------------------

    def _traps(self, tricky: Node, objective: float) -> list[Trap]:
        traps = []
        if tricky.kind != "human":
            return traps
        for e in tricky.edges:
            if e.objective - objective < self.settings.error_drop:
                continue
            punishment, find_prob = None, 0.0
            if e.child is not None and e.child.best is not None:
                punishment = e.child.best.move
                find_prob = next((x.prob for x in e.child.edges if x.move == punishment), 0.0)
            traps.append(Trap(e.move, e.prob, e.objective, punishment, find_prob, e.value))
        traps.sort(key=lambda t: t.prob, reverse=True)
        return traps

    def _hardest(self, node: Node, path: list[chess.Move], path_prob: float) -> Moment | None:
        found: Moment | None = None
        if node.kind == "human" and node.board.turn == self.players.user and node.best is not None:
            best_value = self._user_win(node.best, node.board.turn)
            expected_here = sum(e.prob * e.objective for e in node.edges) / node.covered
            loss = best_value - expected_here
            find_prob = next((e.prob for e in node.edges if e.move == node.best.move), 0.0)
            found = Moment(list(path), node.board, node.best.move, find_prob, loss, path_prob * loss)
        for e in node.edges:
            if e.child is None:
                continue
            sub = self._hardest(e.child, path + [e.move], path_prob * (e.prob if node.kind == "human" else 1.0))
            if sub is not None and (found is None or sub.weight > found.weight):
                found = sub
        return found

    # -- entry point --------------------------------------------------------

    def analyse(self, board: chess.Board) -> PositionAnalysis:
        if board.turn != self.players.user:
            raise ValueError("analyse() expects a position with the user to move")
        s = self.settings
        lines = self.engine.analyse(board, multipv=s.multipv, depth=s.root_depth, max_time=s.root_time)
        best = lines[0]
        threshold = margin_win(max(s.margin_cp, s.tricky_margin_cp))
        lines = [line for line in lines if best.win - line.win <= threshold][: s.max_candidates]

        root_policy = {
            hm.move: hm.prob
            for hm in self.human.policy(board, self.players.user_elo, self.players.opp_elo)
        }
        user = self.players.user
        candidates = []
        for line in lines:
            child = board.copy()
            child.push(line.move)
            simple_tree = self.expand(child, s.simple_plies, frozenset({user}))
            tricky_tree = self.expand(child, s.tricky_plies, frozenset({user, not user}))
            candidates.append(
                Candidate(
                    line=line,
                    objective=line.win,
                    simple=simple_tree.value,
                    tricky=tricky_tree.value,
                    naturalness=root_policy.get(line.move, 0.0),
                    simple_tree=simple_tree,
                    tricky_tree=tricky_tree,
                    traps=self._traps(tricky_tree, line.win),
                    hardest=self._hardest(simple_tree, [], 1.0),
                )
            )
        return PositionAnalysis(board, self.players, candidates, margin_win(s.margin_cp))
