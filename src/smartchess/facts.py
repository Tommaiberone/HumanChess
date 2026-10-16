"""JSON-ready facts about an analysed position.

The same facts feed the web UI and the LLM, and they bound what an LLM explanation
may mention: every SAN move in them is collected in `allowed_moves`.
"""

from __future__ import annotations

import chess

from .explain import after, numbered, pawns
from .motifs import material, opponent_threats, pieces
from .motifs import move_motifs as motifs
from .practical import Candidate, PositionAnalysis
from .winprob import format_cp, win_pct

def _line(board: chess.Board, moves) -> dict:
    moves = list(moves)
    return {"san": board.variation_san(moves) if moves else "", "uci": [m.uci() for m in moves]}


def candidate_facts(board: chess.Board, c: Candidate) -> dict:
    pos = after(board, c.move)
    traps = []
    for t in c.traps[:3]:
        reply_board = after(pos, t.reply)
        traps.append(
            {
                "reply": numbered(pos, t.reply),
                "reply_uci": t.reply.uci(),
                "prob": round(t.prob, 3),
                "eval_after": pawns(t.objective_after),
                "punishment": numbered(reply_board, t.punishment) if t.punishment else None,
                "punishment_uci": t.punishment.uci() if t.punishment else None,
                "find_prob": round(t.find_prob, 3),
                "motifs_punishment": motifs(reply_board, t.punishment) if t.punishment else [],
            }
        )
    critical = None
    h = c.hardest
    if h is not None and h.loss >= 3:
        critical = {
            "after": _line(pos, h.path),
            "needed": numbered(h.board, h.needed),
            "needed_uci": h.needed.uci(),
            "find_prob": round(h.find_prob, 3),
            "loss_win_pct": round(h.loss, 1),
            "fen": h.board.fen(),
        }
    return {
        "move": numbered(board, c.move),
        "san": board.san(c.move),
        "uci": c.move.uci(),
        "eval": format_cp(c.line.cp),
        "cp": c.line.cp,
        "line": _line(board, c.line.pv[:8]),
        "at_your_level": pawns(c.simple),
        "vs_human": pawns(c.tricky),
        "win": {"objective": round(c.objective, 1), "simple": round(c.simple, 1), "tricky": round(c.tricky, 1)},
        "naturalness": round(c.naturalness, 3),
        "opponent_error_prob": round(c.error_prob, 3),
        "motifs": motifs(board, c.move),
        "traps": traps,
        "critical_moment": critical,
    }


MOMENT_LABELS = {"mistake": "mistake", "choice": "practical choice"}


def position_facts(
    a: PositionAnalysis,
    played: chess.Move | None = None,
    played_cp: int | None = None,
    played_pv: tuple[chess.Move, ...] | None = None,
    kind: str | None = None,
) -> dict:
    b = a.board
    facts = {
        "fen": b.fen(),
        "moment": MOMENT_LABELS.get(kind),
        "side": "white" if b.turn == chess.WHITE else "black",
        "opponent_side": "black" if b.turn == chess.WHITE else "white",
        "move_number": b.fullmove_number,
        "user_elo": a.players.user_elo,
        "opponent_elo": a.players.opp_elo,
        "eval_note": "Evaluations are from your point of view: + means better for you.",
        "material_balance": material(b, b.turn) - material(b, not b.turn),
        "your_pieces": pieces(b, b.turn),
        "opponent_pieces": pieces(b, not b.turn),
        "opponent_threats": opponent_threats(b),
        "best": candidate_facts(b, a.best),
        "simple": candidate_facts(b, a.simplest),
        "tricky": candidate_facts(b, a.trickiest),
        "candidates": [
            {k: v for k, v in candidate_facts(b, c).items() if k in ("san", "uci", "eval", "at_your_level", "vs_human", "naturalness", "opponent_error_prob")}
            for c in a.candidates
        ],
    }
    facts["same"] = {
        "simple_is_best": facts["simple"]["uci"] == facts["best"]["uci"],
        "tricky_is_best": facts["tricky"]["uci"] == facts["best"]["uci"],
        "tricky_is_simple": facts["tricky"]["uci"] == facts["simple"]["uci"],
        "only_one_candidate": len(a.candidates) == 1,
    }
    if played is not None:
        facts["played"] = {
            "move": numbered(b, played),
            "san": b.san(played),
            "uci": played.uci(),
            "eval": format_cp(played_cp) if played_cp is not None else None,
            "motifs": motifs(b, played),
            "line": _line(b, played_pv[:8]) if played_pv else None,
        }
        facts["played"]["roles"] = [r for r in ("best", "simple", "tricky") if facts[r]["uci"] == played.uci()]
    return facts


def review_json(review, narrations: dict[int, dict]) -> dict:
    """A whole `review.GameReview` for the web UI."""
    h = review.game.headers
    p = review.players
    plies = []
    kinds = {mr.ply: mr.kind for mr in review.moves if mr.analysis is not None}
    for info in review.plies:
        b = info.board
        white_cp = info.cp_after if b.turn == chess.WHITE else -info.cp_after
        plies.append(
            {
                "ply": info.ply,
                "san": b.san(info.move),
                "uci": info.move.uci(),
                "color": "white" if b.turn == chess.WHITE else "black",
                "move_number": b.fullmove_number,
                "fen_before": b.fen(),
                "fen_after": after(b, info.move).fen(),
                "best_san": b.san(info.best.move),
                "best_uci": info.best.move.uci(),
                "white_cp": white_cp,
                "white_eval": format_cp(white_cp),
                "white_win": round(win_pct(white_cp), 1),
                "judgement": info.judgement,
                "loss": round(info.loss, 1),
                "critical": info.ply in kinds,
                "critical_kind": kinds.get(info.ply),
            }
        )
    critical = {}
    for mr in review.moves:
        if mr.analysis is not None:
            critical[str(mr.ply)] = {
                "kind": mr.kind,
                "facts": position_facts(mr.analysis, mr.played, mr.played_cp,
                                        mr.played_line.pv if mr.played_line else None, mr.kind),
                "narration": narrations.get(mr.ply),
            }
    return {
        "game": {
            "white": h.get("White", "?"),
            "black": h.get("Black", "?"),
            "white_elo": h.get("WhiteElo", ""),
            "black_elo": h.get("BlackElo", ""),
            "result": h.get("Result", ""),
            "date": h.get("Date", ""),
            "link": h.get("Link", ""),
            "start_fen": review.game.board().fen(),
            "user_color": "white" if p.user == chess.WHITE else "black",
            "user_elo": p.user_elo,
            "opp_elo": p.opp_elo,
        },
        "accuracy": {"white": review.accuracy(chess.WHITE), "black": review.accuracy(chess.BLACK)},
        "plies": plies,
        "critical": critical,
    }


def allowed_moves(facts: dict) -> set[str]:
    """Every SAN token that appears anywhere in the facts."""
    found: set[str] = set()

    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str):
            found.update(normalize_san(tok) for tok in x.split())

    walk(facts)
    found.discard("")
    return found


def normalize_san(token: str) -> str:
    """'14...Nxe5+!' -> 'Nxe5'."""
    t = token.strip().strip(".,;:()[]«»\"'")
    if "." in t:
        t = t.rsplit(".", 1)[1]
    return t.strip().rstrip("+#!?")
