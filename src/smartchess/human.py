"""Human move model: Maia-3 move probabilities for a given pair of ratings.

Maia-3's UCI wrapper only reports a ranked list, so we load the network directly
and read the full policy. The model sees the last 8 positions; we rebuild them from
the board's move stack, which is why callers should pass boards with history.
"""

from __future__ import annotations

import os
from collections import deque
from dataclasses import dataclass
from typing import Protocol

import chess
import torch

# Windows without Developer Mode cannot symlink the HF cache; the copy fallback is fine.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from maia3.dataset import get_historical_tokens, get_legal_moves_mask, tokenize_board
from maia3.model_registry import resolve_checkpoint_path, resolve_model_spec
from maia3.uci import load_model, parse_args
from maia3.utils import get_all_possible_moves, mirror_move


@dataclass(frozen=True)
class HumanMove:
    move: chess.Move
    prob: float


class HumanModel(Protocol):
    def policy(self, board: chess.Board, elo_self: int, elo_oppo: int) -> list[HumanMove]:
        """All legal moves with their probability, most likely first."""
        ...


def top_moves(policy: list[HumanMove], mass: float, max_moves: int, min_prob: float = 0.01) -> list[HumanMove]:
    """Smallest prefix of `policy` covering `mass`, capped at `max_moves`."""
    chosen: list[HumanMove] = []
    total = 0.0
    for hm in policy:
        if len(chosen) >= max_moves or total >= mass:
            break
        if chosen and hm.prob < min_prob:
            break
        chosen.append(hm)
        total += hm.prob
    return chosen


class Maia3:
    def __init__(self, model: str = "maia3-23m", device: str = "cpu", threads: int | None = 4):
        if threads:
            torch.set_num_threads(threads)
        self.cfg = parse_args(["--model", model, "--device", device, "--no-use-amp"])
        self.cfg.checkpoint_path = resolve_checkpoint_path(resolve_model_spec(model))
        self.model = load_model(self.cfg)
        self.all_moves = get_all_possible_moves()
        self.move_index = {m: i for i, m in enumerate(self.all_moves)}
        self._cache: dict[tuple, list[HumanMove]] = {}
        self._value_cache: dict[tuple, tuple[float, float, float]] = {}

    def _tokens(self, board: chess.Board) -> torch.Tensor:
        history: deque = deque()
        b = board.copy()
        history.appendleft(tokenize_board(b))
        while len(history) < self.cfg.history and b.move_stack:
            b.pop()
            history.appendleft(tokenize_board(b))
        return get_historical_tokens(history, self.cfg, base=0.0, inc=0.0, clk_left_before=0.0, clk_ponder=0.0)

    @staticmethod
    def _cache_key(board: chess.Board, elo_self: int, elo_oppo: int) -> tuple:
        recent = tuple(m.uci() for m in board.move_stack[-7:])
        return board.fen(), recent, elo_self, elo_oppo

    @torch.no_grad()
    def _forward(self, boards: list[chess.Board], elo_self: list[int], elo_oppo: list[int]):
        tokens = torch.stack([self._tokens(b) for b in boards]).to(self.cfg.device)
        s = torch.tensor(elo_self, dtype=torch.long, device=self.cfg.device)
        o = torch.tensor(elo_oppo, dtype=torch.long, device=self.cfg.device)
        logits_move, logits_value, _ = self.model(tokens, s, o)
        return logits_move.float(), logits_value.float()

    def policy(self, board: chess.Board, elo_self: int, elo_oppo: int) -> list[HumanMove]:
        return self.policy_batch([board], elo_self, elo_oppo)[0]

    def policy_batch(self, boards: list[chess.Board], elo_self: int, elo_oppo: int) -> list[list[HumanMove]]:
        keys = [self._cache_key(b, elo_self, elo_oppo) for b in boards]
        todo = [i for i, k in enumerate(keys) if k not in self._cache and not boards[i].is_game_over()]
        if todo:
            batch = [boards[i] for i in todo]
            logits_move, logits_value = self._forward(batch, [elo_self] * len(batch), [elo_oppo] * len(batch))
            for row, i in enumerate(todo):
                self._cache[keys[i]] = self._decode(boards[i], logits_move[row])
                loss, draw, win = torch.softmax(logits_value[row], dim=-1).tolist()
                self._value_cache[keys[i]] = (win, draw, loss)
        return [self._cache.get(k, []) for k in keys]

    def value(self, board: chess.Board, elo_self: int, elo_oppo: int) -> tuple[float, float, float]:
        """Predicted (win, draw, loss) in a human game, for the side to move."""
        self.policy(board, elo_self, elo_oppo)
        return self._value_cache[self._cache_key(board, elo_self, elo_oppo)]

    def _decode(self, board: chess.Board, logits: torch.Tensor) -> list[HumanMove]:
        mask = get_legal_moves_mask(board, self.move_index)
        probs = torch.softmax(logits.masked_fill(~mask, float("-inf")), dim=-1)
        result = []
        for idx in torch.nonzero(mask).flatten().tolist():
            uci = self.all_moves[idx]
            if board.turn == chess.BLACK:
                uci = mirror_move(uci)
            result.append(HumanMove(chess.Move.from_uci(uci), float(probs[idx])))
        result.sort(key=lambda hm: hm.prob, reverse=True)
        return result
