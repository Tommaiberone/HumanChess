import chess

from smartchess.engine import LineEval
from smartchess.facts import allowed_moves, motifs, normalize_san
from smartchess.llm import invented_moves
from smartchess.review import PlyInfo


def board_after(*sans):
    b = chess.Board()
    for san in sans:
        b.push_san(san)
    return b


def test_normalize_san_strips_numbers_and_annotations():
    assert normalize_san("14...Nxe5+!") == "Nxe5"
    assert normalize_san("3.O-O") == "O-O"
    assert normalize_san("(Qh5#)") == "Qh5"
    assert normalize_san("16. Ne2") == "Ne2"


def test_invented_piece_moves_are_caught_but_squares_are_not():
    facts = {"best": {"move": "5...Na5", "line": {"san": "5...Na5 6. Bb5+ c6"}}}
    allowed = allowed_moves(facts)
    assert invented_moves(["Gioca 5...Na5, poi dopo 6.Bb5+ spingi in c6."], allowed) == []
    assert invented_moves(["Meglio 5...Nxd5 con l'idea Qf6."], allowed) == ["Nxd5", "Qf6"]
    assert invented_moves(["Dopo 6. Bb5+ il gioco si apre."], allowed) == []


def test_motifs_capture_check_and_attack():
    # Scholar's mate pattern: Qxf7 is a capture with mate.
    b = board_after("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6")
    m = motifs(b, b.parse_san("Qxf7#"))
    assert "catturi il pedone dell'avversario in f7" in m
    assert "dai scacco matto" in m
    # A knight attacking an undefended piece.
    b = chess.Board("4k3/8/8/8/3r4/8/8/4K1N1 w - - 0 1")
    assert "attacchi la Torre dell'avversario in d4 (senza difesa)" in motifs(b, b.parse_san("Nf3"))


def test_judgement_and_accuracy():
    b = chess.Board()
    best = LineEval(chess.Move.from_uci("e2e4"), 30, ())
    good = PlyInfo(0, b, chess.Move.from_uci("e2e4"), best, cp_after=30)
    assert good.judgement == "best" and good.accuracy > 99
    blunder = PlyInfo(0, b, chess.Move.from_uci("f2f3"), best, cp_after=-400)
    assert blunder.judgement == "blunder"
    assert blunder.accuracy < 30


def test_material_and_pieces():
    from smartchess.facts import material, pieces

    b = chess.Board("4k3/8/8/8/3r4/8/PP6/4K1N1 w - - 0 1")
    assert material(b, chess.WHITE) - material(b, chess.BLACK) == 0
    assert pieces(b, chess.WHITE) == "Cavallo, 2 pedoni"
    assert pieces(b, chess.BLACK) == "Torre"
