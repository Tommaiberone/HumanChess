"""The numpy Maia-3 (used on AWS Lambda) must match the torch one (used locally)."""

import chess
import numpy as np
import pytest

from smartchess.maia_np import ALL_MOVES, MaiaNumpy, encode

torch = pytest.importorskip("torch")
maia3_dataset = pytest.importorskip("maia3.dataset")
maia3_utils = pytest.importorskip("maia3.utils")


def boards():
    out = []
    for line in ["", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5", "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6 Bg5 Bb7 f3 h6 Bh4 d5"]:
        b = chess.Board()
        for san in line.split():
            b.push_san(san)
        out.append(b)
    out.append(chess.Board("8/P5k1/8/8/8/8/5K2/8 w - - 0 1"))  # promotions
    out.append(chess.Board("8/5k2/8/8/8/8/p5K1/8 b - - 0 1"))  # black promotions
    return out


def test_move_table_matches_maia3():
    assert ALL_MOVES == maia3_utils.get_all_possible_moves()


def test_encoding_matches_maia3():
    from collections import deque

    cfg = type("Cfg", (), {"history": 8, "include_time_info": False})()
    for board in boards():
        history, b = deque([maia3_dataset.tokenize_board(board)]), board.copy()
        while len(history) < 8 and b.move_stack:
            b.pop()
            history.appendleft(maia3_dataset.tokenize_board(b))
        expected = maia3_dataset.get_historical_tokens(history, cfg, 0, 0, 0, 0)[:, :96].numpy()
        np.testing.assert_array_equal(encode(board), expected)


@pytest.fixture(scope="module")
def models():
    try:
        from smartchess.maia import Maia3

        torch_maia = Maia3("maia3-23m")
    except Exception as exc:  # no checkpoint in the Hugging Face cache, no network
        pytest.skip(f"Maia-3 checkpoint unavailable: {exc}")
    state = torch_maia.model.state_dict()
    weights = {k: v.float().numpy() for k, v in state.items() if not k.endswith("self_attn.gab_weight")}
    return torch_maia, MaiaNumpy(weights)


def test_forward_matches_torch(models):
    torch_maia, numpy_maia = models
    tokens = np.stack([encode(b) for b in boards()])
    elo_self, elo_oppo = np.array([1100, 1500, 1900, 1700, 2400]), np.array([1200, 1500, 1800, 1700, 900])
    lm_t, lv_t = torch_maia._forward(tokens, elo_self, elo_oppo)
    lm_n, lv_n = numpy_maia._forward(tokens, elo_self, elo_oppo)
    np.testing.assert_allclose(lm_n, lm_t, atol=2e-3, rtol=0)
    np.testing.assert_allclose(lv_n, lv_t, atol=2e-3, rtol=0)


def test_policies_agree(models):
    torch_maia, numpy_maia = models
    for board in boards():
        a = torch_maia.policy(board, 1500, 1500)
        b = numpy_maia.policy(board, 1500, 1500)
        assert [hm.move for hm in a[:5]] == [hm.move for hm in b[:5]]
        for x, y in zip(a, sorted(b, key=lambda hm: [h.move for h in a].index(hm.move))):
            assert abs(x.prob - y.prob) < 1e-4
