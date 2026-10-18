"""Maia-3 move probabilities for a given pair of ratings, with torch (local runs).

Maia-3's UCI wrapper only reports a ranked list, so we load the network directly
and read the full policy. Encoding, decoding and the cache come from maia_np.py,
whose numpy forward pass replaces this one on AWS Lambda.
"""

from __future__ import annotations

import os

import numpy as np
import torch

# Windows without Developer Mode cannot symlink the HF cache; the copy fallback is fine.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from maia3.model_registry import resolve_checkpoint_path, resolve_model_spec
from maia3.uci import load_model, parse_args

from .maia_np import MaiaPolicy


class Maia3(MaiaPolicy):
    def __init__(self, model: str = "maia3-23m", device: str = "cpu", threads: int | None = 4):
        super().__init__()
        if threads:
            torch.set_num_threads(threads)
        self.cfg = parse_args(["--model", model, "--device", device, "--no-use-amp"])
        self.cfg.checkpoint_path = resolve_checkpoint_path(resolve_model_spec(model))
        self.model = load_model(self.cfg)

    @torch.no_grad()
    def _forward(self, tokens: np.ndarray, elo_self: np.ndarray, elo_oppo: np.ndarray):
        t = torch.from_numpy(tokens).to(self.cfg.device)
        s = torch.from_numpy(elo_self).long().to(self.cfg.device)
        o = torch.from_numpy(elo_oppo).long().to(self.cfg.device)
        logits_move, logits_value, _ = self.model(t, s, o)
        return logits_move.float().cpu().numpy(), logits_value.float().cpu().numpy()
