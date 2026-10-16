from smartchess.importers import chesscom_summary


def raw(white_result, black_result):
    return {
        "url": "https://www.chess.com/game/live/185387418430",
        "end_time": 1792000000,
        "time_class": "rapid",
        "time_control": "600",
        "eco": "https://www.chess.com/openings/Queens-Pawn-Opening-Blackmar-Diemer-Gambit",
        "white": {"username": "Opponent", "rating": 1503, "result": white_result},
        "black": {"username": "TommasoBersani", "rating": 1335, "result": black_result},
    }


def test_summary_is_from_the_users_point_of_view():
    s = chesscom_summary(raw("resigned", "win"), "tommasobersani")
    assert s["id"] == "185387418430"
    assert s["user_color"] == "black"
    assert s["username"] == "TommasoBersani"
    assert (s["opponent"], s["opponent_rating"], s["user_rating"]) == ("Opponent", 1503, 1335)
    assert s["result"] == "win" and s["result_detail"] == "resigned"
    assert s["opening"] == "Queens Pawn Opening Blackmar Diemer Gambit"


def test_draws_and_losses():
    assert chesscom_summary(raw("repetition", "repetition"), "tommasobersani")["result"] == "draw"
    assert chesscom_summary(raw("win", "checkmated"), "tommasobersani")["result"] == "loss"
