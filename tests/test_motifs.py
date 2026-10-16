import chess

from smartchess.motifs import move_motifs, opponent_threats


def themes(fen: str, san: str) -> list[str]:
    board = chess.Board(fen)
    return move_motifs(board, board.parse_san(san))


def test_knight_fork_with_check():
    assert "fork: you give check and attack the opponent's rook on a8" in themes("r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1", "Nc7+")


def test_pin_to_the_king():
    assert "you pin the opponent's knight on c6 to the king" in themes("4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", "Bb5")


def test_discovered_check():
    assert "discovered check with your rook on e1" in themes("4k3/8/8/8/4B3/8/8/4RK2 w - - 0 1", "Bd5+")


def test_new_mate_threat_and_opponent_threats():
    # Queen in front, bishop behind on the b1-h7 diagonal: Qd3 threatens Qxh7#.
    fen = "5rk1/5ppp/8/8/8/8/2B5/3Q2K1 w - - 0 1"
    assert "you threaten Qxh7# (checkmate)" in themes(fen, "Qd3")
    board = chess.Board(fen)
    board.push_san("Qd3")
    assert "the opponent threatens Qxh7# (checkmate)" in opponent_threats(board)


def test_rescuing_an_attacked_piece():
    assert "you rescue your knight, which was under attack" in themes("4k3/8/8/4p3/3N4/8/8/4K3 w - - 0 1", "Nf3")


def test_passed_pawn_and_open_file():
    assert "your pawn on d5 is passed" in themes("4k3/8/8/8/3P4/8/8/4K3 w - - 0 1", "d5")
    assert "your rook takes the open d-file" in themes("4k3/pp4pp/8/8/8/8/PP4PP/R3K3 w - - 0 1", "Rd1")


def test_quiet_move_has_no_invented_themes():
    assert themes(chess.STARTING_FEN, "h3") == []


def test_pinned_attacker_does_not_make_a_piece_hang():
    # The d2 knight attacks c4 but is pinned to its king by the b4 bishop.
    t = themes("2r3k1/8/8/8/1b6/8/3N4/4K3 b - - 0 1", "Rc4")
    assert not any("is left attacked" in x for x in t)
    # A pinned piece can still take the pinner along the pin line.
    t = themes("5bk1/8/8/8/3P4/8/8/6K1 b - - 0 1", "Bc5")
    assert "you pin the opponent's pawn on d4 to the king" in t
    assert any("is left attacked" in x for x in t)
