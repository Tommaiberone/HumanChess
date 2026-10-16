"""Tactical and positional themes, in Italian and in the second person.

These are cheap board facts (no engine): the LLM uses them to explain *why* a
move works, so ownership is always explicit ("il tuo Alfiere", "la Torre
dell'avversario"); without it LLMs regularly mix up whose piece is attacked.
"""

from __future__ import annotations

import chess

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
NAMES = {
    chess.PAWN: "il pedone",
    chess.KNIGHT: "il Cavallo",
    chess.BISHOP: "l'Alfiere",
    chess.ROOK: "la Torre",
    chess.QUEEN: "la Donna",
    chess.KING: "il Re",
}
YOUR = {
    chess.PAWN: "il tuo pedone",
    chess.KNIGHT: "il tuo Cavallo",
    chess.BISHOP: "il tuo Alfiere",
    chess.ROOK: "la tua Torre",
    chess.QUEEN: "la tua Donna",
    chess.KING: "il tuo Re",
}
PLURALS = {
    chess.QUEEN: ("Donna", "Donne"),
    chess.ROOK: ("Torre", "Torri"),
    chess.BISHOP: ("Alfiere", "Alfieri"),
    chess.KNIGHT: ("Cavallo", "Cavalli"),
    chess.PAWN: ("pedone", "pedoni"),
}
SLIDERS = (chess.BISHOP, chess.ROOK, chess.QUEEN)
# A capture or threat must win at least this much material (in pawns) to be worth saying.
MIN_GAIN = 2


def theirs(piece_type: int, square: int) -> str:
    return f"{NAMES[piece_type]} dell'avversario in {chess.square_name(square)}"


def yours(piece_type: int, square: int) -> str:
    return f"{YOUR[piece_type]} in {chess.square_name(square)}"


def _after(board: chess.Board, move: chess.Move) -> chess.Board:
    b = board.copy(stack=False)
    b.push(move)
    return b


def _attackers(board: chess.Board, color: chess.Color, square: int) -> list[int]:
    """Pieces of `color` that can really take on `square`: pinned pieces cannot,
    unless the square lies on their pin line."""
    out = []
    for a in board.attackers(color, square):
        if board.is_pinned(color, a) and square not in board.pin(color, a):
            continue
        out.append(a)
    return out


def _hanging(board: chess.Board, square: int) -> bool:
    """Attacked by the other side and not defended by its own."""
    piece = board.piece_at(square)
    return (
        piece is not None
        and bool(_attackers(board, not piece.color, square))
        and not board.is_attacked_by(piece.color, square)
    )


def _worth_attacking(board: chess.Board, target_sq: int, attacker_type: int) -> bool:
    target = board.piece_at(target_sq)
    if target is None or target.piece_type == chess.KING:
        return False
    return _hanging(board, target_sq) or VALUES[target.piece_type] > VALUES[attacker_type]


def capture_gain(board: chess.Board, move: chess.Move) -> int:
    """Rough material won by a capture: the victim, minus the attacker if the square is defended."""
    attacker = board.piece_at(move.from_square)
    if board.is_en_passant(move):
        victim_value = VALUES[chess.PAWN]
    else:
        victim = board.piece_at(move.to_square)
        if victim is None:
            return 0
        victim_value = VALUES[victim.piece_type]
    defended = board.is_attacked_by(not board.turn, move.to_square)
    return victim_value - (VALUES[attacker.piece_type] if defended else 0)


def threats(board: chess.Board, color: chess.Color, limit: int = 2) -> list[tuple[chess.Move, int | None, chess.Board]]:
    """What `color` could do if it were its turn now: mates in one and winning captures.

    Returns (move, captured piece type or None for a mate, board to play it on), best first.
    """
    b = board.copy(stack=False)
    if b.turn != color:
        if b.is_check():
            return []  # the side in check has no time to pass
        b.push(chess.Move.null())
    found: list[tuple[int, chess.Move, int | None]] = []
    for m in b.legal_moves:
        if b.gives_check(m) and _after(b, m).is_checkmate():
            found.append((1000, m, None))
        elif b.is_capture(m) and capture_gain(b, m) >= MIN_GAIN:
            victim = chess.PAWN if b.is_en_passant(m) else b.piece_at(m.to_square).piece_type
            found.append((capture_gain(b, m), m, victim))
    found.sort(key=lambda x: x[0], reverse=True)
    return [(m, victim, b) for _, m, victim in found[:limit]]


def _is_passed(board: chess.Board, square: int, color: chess.Color) -> bool:
    file, rank = chess.square_file(square), chess.square_rank(square)
    ahead = range(rank + 1, 8) if color == chess.WHITE else range(0, rank)
    for f in (file - 1, file, file + 1):
        if 0 <= f < 8:
            for r in ahead:
                p = board.piece_at(chess.square(f, r))
                if p and p.piece_type == chess.PAWN and p.color != color:
                    return False
    return True


def move_motifs(board: chess.Board, move: chess.Move, limit: int = 7) -> list[str]:
    """Themes of a move by the side to move (the user), most telling first."""
    out: list[str] = []
    mover = board.turn
    opp = not mover
    piece = board.piece_at(move.from_square)
    if piece is None:
        return out
    nxt = _after(board, move)
    to = move.to_square

    # What the move does immediately.
    if board.is_castling(move):
        out.append("arrocchi")
    elif board.is_capture(move):
        if board.is_en_passant(move):
            out.append("catturi un pedone dell'avversario en passant")
        else:
            out.append(f"catturi {theirs(board.piece_at(to).piece_type, to)}")
    if move.promotion:
        out.append(f"promuovi a {PLURALS[move.promotion][0]}")
    if nxt.is_checkmate():
        return out + ["dai scacco matto"]

    # Discovered attacks and checks by the pieces behind the moved one.
    discovered: list[str] = []
    discovered_targets: list[int] = []
    for sq in board.pieces(chess.BISHOP, mover) | board.pieces(chess.ROOK, mover) | board.pieces(chess.QUEEN, mover):
        if sq == move.from_square:
            continue
        new = nxt.attacks(sq) & ~board.attacks(sq) & nxt.occupied_co[opp]
        slider = board.piece_at(sq).piece_type
        for t in new:
            target = nxt.piece_at(t)
            if target.piece_type == chess.KING:
                discovered.append(f"dai scacco di scoperta con {yours(slider, sq)}")
            elif _worth_attacking(nxt, t, slider):
                discovered.append(f"scopri un attacco di {yours(slider, sq)} su {theirs(target.piece_type, t)}")
                discovered_targets.append(t)
    direct_check = nxt.is_check() and to in nxt.attackers(mover, nxt.king(opp))

    # Fork, or single attacks, by the moved piece.
    targets = [t for t in nxt.attacks(to) & nxt.occupied_co[opp] if _worth_attacking(nxt, t, piece.piece_type)]
    names = [theirs(nxt.piece_at(t).piece_type, t) for t in targets]
    if direct_check and not names:
        out.append("dai scacco")
    if direct_check and names:
        out.append(f"forchetta: dai scacco e attacchi {' e '.join(names)}")
    elif len(names) >= 2:
        out.append(f"forchetta: attacchi {' e '.join(names)}")
    else:
        for t, name in zip(targets, names):
            hanging = _hanging(nxt, t)
            out.append(f"attacchi {name} " + ("(senza difesa)" if hanging else "con un pezzo di valore minore"))
    out.extend(discovered)

    # Pins to the king created by the moved piece.
    if piece.piece_type in SLIDERS:
        for sq in chess.SquareSet(nxt.occupied_co[opp]):
            p = nxt.piece_at(sq)
            if p.piece_type != chess.KING and nxt.is_pinned(opp, sq) and to in nxt.pin(opp, sq):
                out.append(f"inchiodi {theirs(p.piece_type, sq)} al Re")

    # New threats: what you could win next if the opponent ignored the move. Captures
    # of pieces already named as attacked above would only repeat them.
    available_before = {m for m in board.legal_moves if board.is_capture(m) and capture_gain(board, m) >= MIN_GAIN}
    named = set(targets) | {t for t in discovered_targets}
    for m, victim, b in threats(nxt, mover):
        if m in available_before or (victim is not None and m.to_square in named):
            continue
        what = "matto" if victim is None else f"per catturare {theirs(victim, m.to_square)}"
        out.append(f"minacci {b.san(m)} ({what})")

    # Safety: rescuing the moved piece, or defending another one.
    if (
        piece.piece_type != chess.KING
        and _attackers(board, opp, move.from_square)
        and (_hanging(board, move.from_square) or _cheaper_attacker(board, move.from_square))
        and not _hanging(nxt, to)
    ):
        out.append(f"metti in salvo {YOUR[piece.piece_type]}, che era sotto attacco")
    for sq in chess.SquareSet(nxt.occupied_co[mover]):
        if sq != to and _hanging(board, sq) and not _hanging(nxt, sq) and sq in nxt.attacks(to):
            out.append(f"difendi {yours(nxt.piece_at(sq).piece_type, sq)}")

    # Structure and activity.
    if piece.piece_type == chess.PAWN and _is_passed(nxt, to, mover):
        out.append(f"il tuo pedone in {chess.square_name(to)} è passato")
    if piece.piece_type == chess.ROOK and chess.square_file(move.from_square) != chess.square_file(to):
        file_pawns = [nxt.piece_at(chess.square(chess.square_file(to), r)) for r in range(8)]
        own = any(p and p.piece_type == chess.PAWN and p.color == mover for p in file_pawns)
        their = any(p and p.piece_type == chess.PAWN and p.color == opp for p in file_pawns)
        column = "abcdefgh"[chess.square_file(to)]
        if not own and not their:
            out.append(f"porti la Torre sulla colonna aperta {column}")
        elif not own:
            out.append(f"porti la Torre sulla colonna semiaperta {column}")
    back_rank = 0 if mover == chess.WHITE else 7
    if piece.piece_type in (chess.KNIGHT, chess.BISHOP) and chess.square_rank(move.from_square) == back_rank and board.fullmove_number <= 15:
        out.append(f"sviluppi {YOUR[piece.piece_type]}")
    if piece.piece_type != chess.KING and _hanging(nxt, to):
        out.append(f"{yours(piece.piece_type, to)} resta sotto attacco e senza difesa")
    return out[:limit]


def _cheaper_attacker(board: chess.Board, square: int) -> bool:
    piece = board.piece_at(square)
    return any(VALUES[board.piece_at(a).piece_type] < VALUES[piece.piece_type] for a in _attackers(board, not piece.color, square))


def opponent_threats(board: chess.Board) -> list[str]:
    """What the opponent threatens in the position, with the user to move."""
    out = []
    for m, victim, b in threats(board, not board.turn):
        if victim is None:
            out.append(f"l'avversario minaccia {b.san(m)} (matto)")
        else:
            out.append(f"l'avversario minaccia {b.san(m)}, che cattura {yours(victim, m.to_square)}")
    return out


def material(board: chess.Board, color: chess.Color) -> int:
    return sum(VALUES[p.piece_type] for p in board.piece_map().values() if p.color == color and p.piece_type != chess.KING)


def pieces(board: chess.Board, color: chess.Color) -> str:
    parts = []
    for pt in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN):
        n = len(board.pieces(pt, color))
        if n:
            one, many = PLURALS[pt]
            parts.append(one if n == 1 else f"{n} {many}")
    return ", ".join(parts) or "solo il Re"
