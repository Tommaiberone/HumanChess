"""Template explanations built only from engine and Maia facts.

These are the facts an LLM will later turn into prose; keeping them explicit means
every move and number in an explanation can be traced back to a search.
"""

from __future__ import annotations

from dataclasses import dataclass

import chess

from .practical import Candidate, PositionAnalysis
from .winprob import cp_from_win, format_cp


def pawns(win: float) -> str:
    return format_cp(cp_from_win(win))


def numbered(board: chess.Board, move: chess.Move) -> str:
    dots = "." if board.turn == chess.WHITE else "..."
    return f"{board.fullmove_number}{dots}{board.san(move)}"


def pct(p: float) -> str:
    return "less than 1%" if 0 < p < 0.005 else f"{p:.0%}"


def after(board: chess.Board, move: chess.Move) -> chess.Board:
    b = board.copy()
    b.push(move)
    return b


@dataclass
class Advice:
    role: str  # "best" | "simple" | "tricky"
    title: str
    candidate: Candidate
    text: list[str]


def _hard_moment(c: Candidate, start: chess.Board) -> str | None:
    h = c.hardest
    if h is None or h.find_prob >= 0.5 or h.loss < 3:
        return None
    prefix = f"after {start.variation_san(h.path)}, " if h.path else ""
    return (
        f"{prefix}you need to find {numbered(h.board, h.needed)}, "
        f"which players at your level find {pct(h.find_prob)} of the time"
    )


def best_advice(a: PositionAnalysis) -> Advice:
    c = a.best
    b = a.board
    text = [f"Line: {b.variation_san(list(c.line.pv[:6]))}"]
    hard = _hard_moment(c, after(b, c.move))
    if hard:
        text.append(f"Careful: {hard}.")
    elif c.naturalness >= 0.3:
        text.append(f"It is also natural: {pct(c.naturalness)} of players at your level would play it.")
    return Advice("best", "Best", c, text)


def simple_advice(a: PositionAnalysis) -> Advice:
    c = a.simplest
    b = a.board
    if len(a.candidates) == 1:
        return Advice("simple", "Simplest", c, ["No alternative within the margin: here you need the best move."])
    if c.move == a.best.move:
        if _hard_moment(c, after(b, c.move)):
            text = "The alternatives within the margin are even harder to handle."
        else:
            text = "The best move is also the easiest to handle at your level."
        return Advice("simple", "Simplest", c, [text])
    text = [
        f"You give up little ({format_cp(c.line.cp)} against {format_cp(a.best.line.cp)}), but playing at your "
        f"level you stay around {pawns(c.simple)} on average, against {pawns(a.best.simple)} with the best move.",
        f"Line: {b.variation_san(list(c.line.pv[:6]))}",
    ]
    hard = _hard_moment(c, after(b, c.move))
    if hard:
        text.append(f"The one tricky moment: {hard}.")
    return Advice("simple", "Simplest", c, text)


def tricky_advice(a: PositionAnalysis) -> Advice:
    c = a.trickiest
    b = a.board
    pos = after(b, c.move)
    if len(a.candidates) == 1:
        return Advice("tricky", "Trickiest", c, ["No alternative within the margin."])
    text = []
    if c.traps:
        t = c.traps[0]
        reply_board = after(pos, t.reply)
        line = f"{pct(t.prob)} of players at your opponent's level answer {numbered(pos, t.reply)}?"
        if t.punishment is not None:
            line += (
                f", and after {numbered(reply_board, t.punishment)}! you are at {pawns(t.objective_after)}"
                f" (players at your level find it {pct(t.find_prob)} of the time)"
            )
        text.append(line + ".")
        if len(c.traps) > 1:
            text.append(f"In total, {pct(c.error_prob)} of the likely replies are mistakes.")
    elif c.tricky - c.objective >= 2:
        text.append("No precise trap, but the opponent's most natural replies are inaccurate.")
    if c.move == a.best.move:
        text.append("It is also the best move.")
    else:
        if c.move == a.simplest.move:
            text.append("It is also the simplest.")
        text.append(
            f"Limited risk: against the best reply you stay at {format_cp(c.line.cp)} "
            f"({format_cp(a.best.line.cp)} with the best move)."
        )
    text.append(f"Against a real opponent it scores {pawns(c.tricky)} on average.")
    return Advice("tricky", "Trickiest", c, text)


def advise(a: PositionAnalysis) -> list[Advice]:
    return [best_advice(a), simple_advice(a), tricky_advice(a)]


def format_console(a: PositionAnalysis, header: str = "") -> str:
    out = [header] if header else []
    for adv in advise(a):
        c = adv.candidate
        out.append(f"  {adv.title:<10} {numbered(a.board, c.move):<12} {format_cp(c.line.cp):>6}")
        out.extend(f"      {line}" for line in adv.text)
    return "\n".join(out)
