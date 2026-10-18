import chess

from smartchess.engine import LineEval
from smartchess.facts import allowed_moves, mark_played_options, motifs, normalize_san
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
    assert invented_moves(["Play 5...Na5, then after 6.Bb5+ push to c6."], allowed) == []
    assert invented_moves(["Better 5...Nxd5 with the idea Qf6."], allowed) == ["Nxd5", "Qf6"]
    assert invented_moves(["After 6. Bb5+ the game opens up."], allowed) == []


def test_motifs_capture_check_and_attack():
    # Scholar's mate pattern: Qxf7 is a capture with mate.
    b = board_after("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6")
    m = motifs(b, b.parse_san("Qxf7#"))
    assert "you capture the opponent's pawn on f7" in m
    assert "checkmate" in m
    # A knight attacking an undefended piece.
    b = chess.Board("4k3/8/8/8/3r4/8/8/4K1N1 w - - 0 1")
    assert "you attack the opponent's rook on d4 (undefended)" in motifs(b, b.parse_san("Nf3"))


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
    assert pieces(b, chess.WHITE) == "knight, 2 pawns"
    assert pieces(b, chess.BLACK) == "rook"


def _review(kind, roles, judgement="inaccuracy"):
    return {
        "plies": [{"ply": 0, "judgement": judgement, "critical": True, "critical_kind": kind}],
        "critical": {"0": {"kind": kind, "facts": {"moment": kind, "played": {"roles": roles}}}},
    }


def test_played_option_is_never_a_mistake():
    r = mark_played_options(_review("mistake", ["tricky"]))
    assert r["critical"]["0"]["kind"] == "choice" and r["plies"][0]["critical_kind"] == "choice"
    assert r["critical"]["0"]["facts"]["moment"] == "practical choice"
    assert r["plies"][0]["judgement"] == "tricky"
    # When the move is both best and tricky, the best role wins the icon.
    assert mark_played_options(_review("choice", ["best", "tricky"], "good"))["plies"][0]["judgement"] == "best"


def test_other_moves_keep_their_judgement():
    r = mark_played_options(_review("mistake", []))
    assert r["critical"]["0"]["kind"] == "mistake" and r["plies"][0]["judgement"] == "inaccuracy"
