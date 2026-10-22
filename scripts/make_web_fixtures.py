"""Write the fixtures the JavaScript port is tested against (web-tests/).

Usage: uv run python scripts/make_web_fixtures.py

For positions from real games and a few special ones it records what the Python code
says: legal moves in generation order with their SAN, motifs of every move, threats,
material, and game-over state. web-tests/*.test.js check the port gives the same.
"""

from __future__ import annotations

import io
import json
import random
from pathlib import Path

import chess
import chess.pgn

from smartchess.explain import numbered
from smartchess.facts import normalize_san
from smartchess.motifs import material, move_motifs, opponent_threats, pieces
from smartchess.winprob import cp_from_win, format_cp, win_pct

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web-tests" / "fixtures" / "positions.json"

SPECIAL = [
    "r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 8",  # both can castle
    "r3k2r/pppq1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPQ1PPP/R3K2R b KQkq - 0 8",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",  # en passant available
    "8/P1k5/8/8/8/8/5Kp1/8 w - - 0 1",  # promotions both sides
    "8/P1k5/8/8/8/8/5Kp1/8 b - - 0 1",
    "4k3/8/8/8/8/8/4q3/4K3 w - - 0 1",  # king takes the queen
    "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",  # back-rank mate in one
    "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",  # Qxf7#
    "k7/8/1Q6/8/8/8/8/K7 b - - 0 1",  # stalemate-ish
    "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",  # stalemate
    "3r2k1/5ppp/8/8/8/8/3B1PPP/3R2K1 w - - 0 1",  # pins and trades
    "4k3/8/8/2b5/8/4N3/8/4K2R w K - 0 1",
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",  # fool's mate position, mate
]


def position_record(board: chess.Board) -> dict:
    moves = list(board.legal_moves)
    rec = {
        "fen": board.fen(),
        "stack": [m.uci() for m in board.move_stack[-9:]],
        "turn": "white" if board.turn else "black",
        "game_over": board.is_game_over(claim_draw=True),
        "winner": (None if board.outcome(claim_draw=True) is None or board.outcome(claim_draw=True).winner is None
                   else "white" if board.outcome(claim_draw=True).winner else "black"),
        "legal": [m.uci() for m in moves],
        "san": [board.san(m) for m in moves],
        "numbered": [numbered(board, m) for m in moves],
        "motifs": [move_motifs(board, m) for m in moves],
        "threats": opponent_threats(board),
        "material": [material(board, True), material(board, False)],
        "pieces": [pieces(board, True), pieces(board, False)],
    }
    seq, b = [], board.copy()
    rng = random.Random(board.fen())
    for _ in range(6):
        legal = list(b.legal_moves)
        if not legal:
            break
        m = rng.choice(legal)
        seq.append(m.uci())
        b.push(m)
    rec["variation"] = {"moves": seq, "san": board.variation_san([chess.Move.from_uci(u) for u in seq]) if seq else ""}
    return rec


def maia_records() -> list[dict]:
    """Maia-3 5M policies of positions with history, to check the browser encoding and decoding."""
    from smartchess.maia import Maia3

    maia = Maia3("maia3-5m", threads=4)
    rng = random.Random(11)
    out = []
    for path in sorted((ROOT / "data" / "games").glob("*.json"))[:6]:
        raw = json.loads(path.read_text(encoding="utf-8"))
        game = chess.pgn.read_game(io.StringIO(raw["pgn"]))
        moves = list(game.mainline_moves())
        for ply in sorted(rng.sample(range(len(moves)), 3)):
            board = game.board()
            for m in moves[:ply]:
                board.push(m)
            elo_self, elo_oppo = rng.choice([(1700, 1650), (1450, 1500), (2000, 1900)])
            policy = maia.policy(board, elo_self, elo_oppo)
            out.append({"start_fen": game.board().fen(), "moves": [m.uci() for m in moves[:ply]],
                        "elo_self": elo_self, "elo_oppo": elo_oppo, "n_legal": len(policy),
                        "policy": [[hm.move.uci(), hm.prob] for hm in policy[:8]]})
    return out


def main() -> None:
    rng = random.Random(7)
    records = []
    for path in sorted((ROOT / "data" / "games").glob("*.json"))[:12]:
        raw = json.loads(path.read_text(encoding="utf-8"))
        game = chess.pgn.read_game(io.StringIO(raw["pgn"]))
        board = game.board()
        plies = list(game.mainline_moves())
        picks = set(rng.sample(range(len(plies)), min(7, len(plies))))
        for i, move in enumerate(plies):
            if i in picks:
                records.append(position_record(board))
            board.push(move)
    for fen in SPECIAL:
        records.append(position_record(chess.Board(fen)))
    win = [{"cp": cp, "win": win_pct(cp), "fmt": format_cp(cp)} for cp in (-9999, -9990, -1500, -37, 0, 12, 85, 640, 9990, 9999)]
    win += [{"win_in": w, "cp": cp_from_win(w)} for w in (1, 12.5, 50, 63.7, 99)]
    OUT.write_text(json.dumps({"positions": records, "winprob": win, "maia": maia_records()}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(records)} positions, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
