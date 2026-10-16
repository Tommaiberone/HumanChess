"""Template explanations (Italian) built only from engine and Maia facts.

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
    return "meno dell'1%" if 0 < p < 0.005 else f"{p:.0%}"


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
    prefix = f"dopo {start.variation_san(h.path)}, " if h.path else ""
    return (
        f"{prefix}devi trovare {numbered(h.board, h.needed)}, "
        f"che al tuo livello si trova nel {pct(h.find_prob)} dei casi"
    )


def best_advice(a: PositionAnalysis) -> Advice:
    c = a.best
    b = a.board
    text = [f"Linea: {b.variation_san(list(c.line.pv[:6]))}"]
    hard = _hard_moment(c, after(b, c.move))
    if hard:
        text.append(f"Attenzione: {hard}.")
    elif c.naturalness >= 0.3:
        text.append(f"È anche naturale: la gioca il {pct(c.naturalness)} dei giocatori del tuo livello.")
    return Advice("best", "Migliore", c, text)


def simple_advice(a: PositionAnalysis) -> Advice:
    c = a.simplest
    b = a.board
    if len(a.candidates) == 1:
        return Advice("simple", "Più semplice", c, ["Nessuna alternativa entro il margine: qui serve la migliore."])
    if c.move == a.best.move:
        if _hard_moment(c, after(b, c.move)):
            text = "Le alternative entro il margine sono ancora più difficili da gestire."
        else:
            text = "La migliore è anche la più facile da gestire al tuo livello."
        return Advice("simple", "Più semplice", c, [text])
    text = [
        f"Cedi poco ({format_cp(c.line.cp)} contro {format_cp(a.best.line.cp)}), ma anche giocando "
        f"al tuo livello resti in media su {pawns(c.simple)}, contro {pawns(a.best.simple)} con la migliore.",
        f"Linea: {b.variation_san(list(c.line.pv[:6]))}",
    ]
    hard = _hard_moment(c, after(b, c.move))
    if hard:
        text.append(f"Unico passaggio delicato: {hard}.")
    return Advice("simple", "Più semplice", c, text)


def tricky_advice(a: PositionAnalysis) -> Advice:
    c = a.trickiest
    b = a.board
    pos = after(b, c.move)
    if len(a.candidates) == 1:
        return Advice("tricky", "Più insidiosa", c, ["Nessuna alternativa entro il margine."])
    text = []
    if c.traps:
        t = c.traps[0]
        reply_board = after(pos, t.reply)
        line = f"Il {pct(t.prob)} dei giocatori del livello del tuo avversario risponde {numbered(pos, t.reply)}?"
        if t.punishment is not None:
            line += (
                f", e dopo {numbered(reply_board, t.punishment)}! sei a {pawns(t.objective_after)}"
                f" (al tuo livello la trovi nel {pct(t.find_prob)} dei casi)"
            )
        text.append(line + ".")
        if len(c.traps) > 1:
            text.append(f"In totale il {pct(c.error_prob)} delle risposte probabili è un errore.")
    elif c.tricky - c.objective >= 2:
        text.append("Nessuna trappola precisa, ma le risposte più naturali dell'avversario sono imprecise.")
    if c.move == a.best.move:
        text.append("È anche la mossa migliore.")
    else:
        if c.move == a.simplest.move:
            text.append("Coincide con la più semplice.")
        text.append(
            f"Rischio limitato: contro la risposta migliore resti a {format_cp(c.line.cp)} "
            f"({format_cp(a.best.line.cp)} con la migliore)."
        )
    text.append(f"Contro un avversario reale rende in media {pawns(c.tricky)}.")
    return Advice("tricky", "Più insidiosa", c, text)


def advise(a: PositionAnalysis) -> list[Advice]:
    return [best_advice(a), simple_advice(a), tricky_advice(a)]


def format_console(a: PositionAnalysis, header: str = "") -> str:
    out = [header] if header else []
    for adv in advise(a):
        c = adv.candidate
        out.append(f"  {adv.title:<14} {numbered(a.board, c.move):<12} {format_cp(c.line.cp):>6}")
        out.extend(f"      {line}" for line in adv.text)
    return "\n".join(out)
