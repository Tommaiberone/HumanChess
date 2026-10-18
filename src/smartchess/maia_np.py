"""Maia-3 without torch: the same network evaluated with numpy.

A Lambda zip package holds 250 MB, and torch alone takes about 700, so on AWS the
model runs here instead. `scripts/export_maia.py` writes the torch weights to .npz
files, and tests/test_maia_np.py checks this forward pass against torch. Board
encoding, the move table and decoding live here too: the torch wrapper (maia.py)
shares them, so both backends see exactly the same inputs.
"""

from __future__ import annotations

import math
from collections import deque
from pathlib import Path

import chess
import numpy as np

from .human import HumanMove

HISTORY = 8  # positions the model sees, the current one last
PIECE_INDEX = {chess.PAWN: 0, chess.KNIGHT: 1, chess.BISHOP: 2, chess.ROOK: 3, chess.QUEEN: 4, chess.KING: 5}

# Moves are always seen from White's side (the board is mirrored for Black): every
# from-to pair in square order, then the promotions from rank 7 to rank 8.
_SQUARES = [chess.square_name(s) for s in chess.SQUARES]
ALL_MOVES = [a + b for a in _SQUARES for b in _SQUARES] + [
    f"{f}7{t}8{p}" for f in "abcdefgh" for t in "abcdefgh" for p in "qrbn"
]
MOVE_INDEX = {m: i for i, m in enumerate(ALL_MOVES)}


def mirror_uci(uci: str) -> str:
    return f"{uci[0]}{9 - int(uci[1])}{uci[2]}{9 - int(uci[3])}{uci[4:]}"


def _tokenize(board: chess.Board) -> np.ndarray:
    """(64, 12) one-hot pieces, from the side to move's point of view."""
    tokens = np.zeros((64, 12), dtype=np.float32)
    if board.turn == chess.BLACK:
        board = board.mirror()
    for square, piece in board.piece_map().items():
        tokens[square, PIECE_INDEX[piece.piece_type] + (6 if piece.color == chess.BLACK else 0)] = 1
    return tokens


def encode(board: chess.Board) -> np.ndarray:
    """(64, 12 * HISTORY) input: the last positions from the move stack, oldest first.

    Each past position is tokenized from its own side to move, and a short history
    is padded with the earliest position, as Maia-3 does.
    """
    history: deque = deque()
    b = board.copy()
    history.appendleft(_tokenize(b))
    while len(history) < HISTORY and b.move_stack:
        b.pop()
        history.appendleft(_tokenize(b))
    while len(history) < HISTORY:
        history.appendleft(history[0])
    return np.concatenate(history, axis=1)


def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    e = np.exp(x - x.max(axis=axis, keepdims=True))
    return e / e.sum(axis=axis, keepdims=True)


def decode(board: chess.Board, logits: np.ndarray) -> list[HumanMove]:
    """All legal moves with their probability, most likely first."""
    ucis = [m.uci() if board.turn == chess.WHITE else mirror_uci(m.uci()) for m in board.legal_moves]
    idx = np.array([MOVE_INDEX[u] for u in ucis if u in MOVE_INDEX], dtype=np.int64)
    if not len(idx):
        return []
    probs = _softmax(logits[idx].astype(np.float64))
    out = []
    for i, prob in zip(idx, probs):
        uci = ALL_MOVES[i] if board.turn == chess.WHITE else mirror_uci(ALL_MOVES[i])
        out.append(HumanMove(chess.Move.from_uci(uci), float(prob)))
    out.sort(key=lambda hm: hm.prob, reverse=True)
    return out


class MaiaPolicy:
    """Move probabilities and expected outcome for a pair of ratings, cached by position.

    Subclasses provide `_forward(tokens, elo_self, elo_oppo)`, which returns the move
    logits (B, 4352) and the value logits (B, 3) as numpy arrays.
    """

    def __init__(self):
        self._cache: dict[tuple, list[HumanMove]] = {}
        self._value_cache: dict[tuple, tuple[float, float, float]] = {}

    def _forward(self, tokens: np.ndarray, elo_self: np.ndarray, elo_oppo: np.ndarray):
        raise NotImplementedError

    @staticmethod
    def _cache_key(board: chess.Board, elo_self: int, elo_oppo: int) -> tuple:
        recent = tuple(m.uci() for m in board.move_stack[-(HISTORY - 1):])
        return board.fen(), recent, elo_self, elo_oppo

    def policy(self, board: chess.Board, elo_self: int, elo_oppo: int) -> list[HumanMove]:
        return self.policy_batch([board], elo_self, elo_oppo)[0]

    def policy_batch(self, boards: list[chess.Board], elo_self: int, elo_oppo: int) -> list[list[HumanMove]]:
        keys = [self._cache_key(b, elo_self, elo_oppo) for b in boards]
        todo = [i for i, k in enumerate(keys) if k not in self._cache and not boards[i].is_game_over()]
        if todo:
            tokens = np.stack([encode(boards[i]) for i in todo])
            n = len(todo)
            logits_move, logits_value = self._forward(tokens, np.full(n, elo_self), np.full(n, elo_oppo))
            for row, i in enumerate(todo):
                self._cache[keys[i]] = decode(boards[i], logits_move[row])
                loss, draw, win = _softmax(logits_value[row].astype(np.float64)).tolist()
                self._value_cache[keys[i]] = (win, draw, loss)
        return [self._cache.get(k, []) for k in keys]

    def value(self, board: chess.Board, elo_self: int, elo_oppo: int) -> tuple[float, float, float]:
        """Predicted (win, draw, loss) in a human game, for the side to move."""
        self.policy(board, elo_self, elo_oppo)
        return self._value_cache[self._cache_key(board, elo_self, elo_oppo)]


# -- the network ---------------------------------------------------------------

def _gelu(x: np.ndarray) -> np.ndarray:
    """Exact GELU, x * Phi(x), the default of torch's nn.GELU.

    numpy has no erf: Abramowitz and Stegun 7.1.26 gives it within 1.5e-7 (float32
    precision), worked in place because these arrays are the biggest in the model.
    """
    a = np.abs(x)
    a *= np.float32(1 / math.sqrt(2))
    t = a * np.float32(0.3275911)
    t += 1
    np.reciprocal(t, out=t)
    tail = t * np.float32(1.061405429)
    for c in (-1.453152027, 1.421413741, -0.284496736, 0.254829592):
        tail += np.float32(c)
        tail *= t
    a *= a
    np.negative(a, out=a)
    np.exp(a, out=a)
    tail *= a
    tail *= np.float32(0.5)  # tail = 1 - Phi(|x|)
    return x * np.where(x >= 0, 1 - tail, tail)


class MaiaNumpy(MaiaPolicy):
    """The Maia-3 forward pass (models.py in the maia3 package) on numpy arrays.

    The sizes come from the weight shapes, so any Maia-3 checkpoint loads.
    """

    def __init__(self, weights: dict[str, np.ndarray]):
        super().__init__()
        # nn.MultiheadAttention names its input projection in_proj_weight / in_proj_bias.
        self.w = {k.replace("in_proj_", "in_proj."): np.asarray(v, dtype=np.float32) for k, v in weights.items()}
        self.blocks = len({k.split(".")[2] for k in self.w if k.startswith("transformer.layers.")})
        self.gen_size = self.w["gab_shared_weight"].shape[1]
        self.heads = self.w["transformer.layers.0.self_attn.sm3.weight"].shape[0] // self.gen_size
        self.hid = self.w["proj_sq_from.weight"].shape[0]

    @classmethod
    def from_dir(cls, path: str | Path) -> "MaiaNumpy":
        """Weights split over several .npz files (one per Lambda layer)."""
        weights: dict[str, np.ndarray] = {}
        for file in sorted(Path(path).glob("*.npz")):
            with np.load(file) as f:
                weights.update({k: f[k] for k in f.files})
        return cls(weights)

    def _linear(self, x: np.ndarray, name: str) -> np.ndarray:
        # One 2-D product: numpy runs a 3-D one as many small ones, about 5x slower.
        y = x.reshape(-1, x.shape[-1]) @ self.w[f"{name}.weight"].T
        bias = self.w.get(f"{name}.bias")
        if bias is not None:
            y += bias
        return y.reshape(*x.shape[:-1], -1)

    def _layer_norm(self, x: np.ndarray, name: str, eps: float = 1e-5) -> np.ndarray:
        mean = x.mean(axis=-1, keepdims=True)
        var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
        return (x - mean) / np.sqrt(var + np.float32(eps)) * self.w[f"{name}.weight"] + self.w[f"{name}.bias"]

    def _rms_norm(self, x: np.ndarray, name: str) -> np.ndarray:
        # torch.nn.RMSNorm with eps=None uses the dtype's machine epsilon.
        eps = np.finfo(np.float32).eps
        return x / np.sqrt((x * x).mean(axis=-1, keepdims=True) + eps) * self.w[f"{name}.weight"]

    def _attention(self, x: np.ndarray, name: str) -> np.ndarray:
        B, T, D = x.shape
        H, d = self.heads, D // self.heads
        # Attention bias generated from the board (GAB): one 64x64 map per head.
        y = self._linear(x, f"{name}.sm1").reshape(B, -1)
        y = self._layer_norm(_gelu(self._linear(y, f"{name}.sm2")), f"{name}.ln1")
        y = self._layer_norm(_gelu(self._linear(y, f"{name}.sm3")), f"{name}.ln2").reshape(B, H, self.gen_size)
        bias = (y @ self.w["gab_shared_weight"].T).reshape(B, H, T, T)

        qkv = self._linear(x, f"{name}.mha.in_proj").reshape(B, T, 3, H, d).transpose(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]  # (B, H, T, d)
        scores = q @ k.transpose(0, 1, 3, 2) * np.float32(1 / math.sqrt(d)) + bias
        out = (_softmax(scores) @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
        return self._linear(out, f"{name}.mha.out_proj")

    def _elo(self, elos: np.ndarray) -> np.ndarray:
        weight_low = (np.clip(elos, 0, 5000).astype(np.float32) / 5000)[:, None]
        return weight_low * self.w["elo_embedding_low.weight"][0] + (1 - weight_low) * self.w["elo_embedding_high.weight"][0]

    def _forward(self, tokens: np.ndarray, elo_self: np.ndarray, elo_oppo: np.ndarray):
        B = len(tokens)
        elos = [np.broadcast_to(self._elo(e)[:, None, :], (B, 64, self.w["elo_embedding_low.weight"].shape[1]))
                for e in (elo_self, elo_oppo)]
        x = self._linear(np.concatenate([tokens.astype(np.float32), *elos], axis=-1), "token_projection")
        for i in range(self.blocks):
            p = f"transformer.layers.{i}"
            x = self._rms_norm(x + self._attention(x, f"{p}.self_attn"), f"{p}.norm1")
            x = self._rms_norm(x + self._linear(_gelu(self._linear(x, f"{p}.linear1")), f"{p}.linear2"), f"{p}.norm2")
        x = self._layer_norm(x, "transformer.norm")

        # Move logits: a from-square / to-square score, plus a bias per promotion piece.
        sq_from = self._linear(x, "proj_sq_from")
        sq_to = self._linear(x, "proj_sq_to")
        scores = sq_from @ sq_to.transpose(0, 2, 1) * np.float32(1 / math.sqrt(self.hid))  # (B, 64, 64)
        promo_bias = self._linear(sq_to[:, 56:64], "promo_bias_proj") * np.float32(math.sqrt(self.hid))
        promotions = scores[:, 48:56, 56:64, None] + promo_bias[:, None, :, :]  # (B, from file, to file, piece)
        logits_move = np.concatenate([scores.reshape(B, -1), promotions.reshape(B, -1)], axis=1)

        v = self._layer_norm(x.mean(axis=1), "last_ln")
        logits_value = self._linear(np.maximum(self._linear(v, "fc_value_hid"), 0), "fc_value")
        return logits_move, logits_value
