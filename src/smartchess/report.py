"""Self-contained HTML report for a game review."""

from __future__ import annotations

import html
from pathlib import Path

import chess
import chess.svg

from .explain import advise, numbered, pawns, pct
from .review import GameReview, MoveReview
from .winprob import format_cp

ROLE_COLORS = {
    "best": "#2e7d32",
    "simple": "#1565c0",
    "tricky": "#e65100",
    "played": "#c62828",
}

CSS = """
:root {
  --bg: #f7f7f5; --card: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
  --best: #2e7d32; --simple: #1565c0; --tricky: #e65100; --played: #c62828;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --card: #20201e; --text: #ecece8; --muted: #a3a39c; --line: #34342f;
    --best: #66bb6a; --simple: #64b5f6; --tricky: #ffa726; --played: #ef5350;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: var(--muted); margin-bottom: 24px; }
.pos { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px; margin-bottom: 20px; display: grid; grid-template-columns: 340px 1fr; gap: 20px; }
.pos svg { width: 100%; height: auto; }
@media (max-width: 760px) { .pos { grid-template-columns: 1fr; } }
h2 { font-size: 17px; margin: 0 0 8px; }
.played { color: var(--muted); margin-bottom: 12px; }
.advice { border-left: 4px solid var(--line); padding: 4px 0 4px 12px; margin-bottom: 12px; }
.advice.best { border-color: var(--best); } .advice.simple { border-color: var(--simple); }
.advice.tricky { border-color: var(--tricky); }
.advice .head { font-weight: 600; }
.advice .head .eval { color: var(--muted); font-weight: 400; margin-left: 6px; }
.advice p { margin: 2px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 8px; }
th, td { text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 500; }
.legend span { display: inline-block; margin-right: 12px; font-size: 13px; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; }
"""


def _arrows(mr: MoveReview) -> list[chess.svg.Arrow]:
    a = mr.analysis
    roles = [
        ("best", a.best.move),
        ("simple", a.simplest.move),
        ("tricky", a.trickiest.move),
        ("played", mr.played),
    ]
    seen: set[chess.Move] = set()
    arrows = []
    for role, move in roles:
        if move in seen:
            continue
        seen.add(move)
        arrows.append(chess.svg.Arrow(move.from_square, move.to_square, color=ROLE_COLORS[role] + "cc"))
    return arrows


def _position_html(mr: MoveReview) -> str:
    a = mr.analysis
    board = mr.board
    svg = chess.svg.board(
        board,
        orientation=a.players.user,
        arrows=_arrows(mr),
        lastmove=board.peek() if board.move_stack else None,
        size=340,
    )
    loss_cp = mr.best_cp - mr.played_cp
    loss = "decisiva" if abs(loss_cp) > 2000 else f"{loss_cp / 100:.2f}"
    parts = [
        f'<section class="pos"><div>{svg}</div><div>',
        f"<h2>{html.escape(numbered(board, mr.played))}</h2>",
        f'<div class="played">Hai giocato {html.escape(board.san(mr.played))} '
        f"({format_cp(mr.played_cp)}) · perdita {loss}</div>",
    ]
    for adv in advise(a):
        c = adv.candidate
        parts.append(f'<div class="advice {adv.role}"><div class="head">{adv.title}: '
                     f'{html.escape(numbered(board, c.move))}<span class="eval">{format_cp(c.line.cp)}</span></div>')
        parts.extend(f"<p>{html.escape(line)}</p>" for line in adv.text)
        parts.append("</div>")
    parts.append(
        "<table><tr><th>Mossa</th><th>Stockfish</th><th>Al tuo livello</th>"
        "<th>Vs umano</th><th>Naturale</th><th>Errore avv.</th></tr>"
    )
    for c in a.candidates:
        parts.append(
            f"<tr><td>{html.escape(board.san(c.move))}</td><td>{format_cp(c.line.cp)}</td>"
            f"<td>{pawns(c.simple)}</td><td>{pawns(c.tricky)}</td>"
            f"<td>{pct(c.naturalness)}</td><td>{pct(c.error_prob)}</td></tr>"
        )
    parts.append("</table></div></section>")
    return "".join(parts)


def write_report(review: GameReview, path: str | Path) -> Path:
    h = review.game.headers
    p = review.players
    title = f"{h.get('White', '?')} – {h.get('Black', '?')}"
    meta = (
        f"{h.get('Date', '')} · {h.get('Result', '')} · Elo Maia: tu {p.user_elo}, avversario {p.opp_elo}"
    )
    link = h.get("Link", "")
    if link:
        meta += f' · <a href="{html.escape(link)}">partita</a>'
    legend = "".join(
        f'<span><i style="background:{ROLE_COLORS[r]}"></i>{label}</span>'
        for r, label in [("best", "migliore"), ("simple", "più semplice"), ("tricky", "più insidiosa"), ("played", "giocata")]
    )
    body = "".join(_position_html(mr) for mr in review.moves if mr.analysis) or "<p>Nessuna posizione critica trovata.</p>"
    doc = (
        f'<!doctype html><html lang="it"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>SmartChess review</title><style>{CSS}</style></head><body><main>"
        f"<h1>{html.escape(title)}</h1><div class=\"meta\">{meta}</div>"
        f'<div class="legend">{legend}</div><br>{body}</main></body></html>'
    )
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    return out
