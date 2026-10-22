"""Export a Maia-3 model to ONNX for the in-browser analysis (ONNX Runtime Web).

Usage: uv run --no-sync --with onnx --with onnxruntime python scripts/export_onnx.py [model] [out_dir]

model: maia3-5m (21 MB, the browser default) or maia3-23m (91 MB). The result is checked
against torch on random input before it is written to out_dir/<model>.onnx.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from smartchess.maia import Maia3


def rms_norm(x, normalized_shape, weight=None, eps=None):
    """torch's RMSNorm with primitive ops: ONNX opset 17 has no RMSNorm operator."""
    eps = eps if eps is not None else torch.finfo(x.dtype).eps
    dims = tuple(range(-len(normalized_shape), 0))
    y = x * torch.rsqrt(x.pow(2).mean(dims, keepdim=True) + eps)
    return y * weight if weight is not None else y


class Wrapped(torch.nn.Module):
    """Only the move and value heads: the third output of Maia-3 is not used."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, tokens, elo_self, elo_oppo):
        move, value, _ = self.net(tokens, elo_self, elo_oppo)
        return move, value


def export(model: str, out_dir: Path) -> Path:
    import onnxruntime as ort

    F.rms_norm = rms_norm
    net = Maia3(model, threads=4).model.eval()
    rng = np.random.default_rng(0)
    tokens = torch.from_numpy((rng.random((2, 64, 96)) > 0.9).astype(np.float32))
    elos = (torch.tensor([1700, 1500]), torch.tensor([1600, 1800]))
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{model}.onnx"
    batch = {0: "batch"}
    torch.onnx.export(
        Wrapped(net), (tokens, *elos), str(path), input_names=["tokens", "elo_self", "elo_oppo"],
        output_names=["move", "value"], opset_version=17, dynamo=False,
        dynamic_axes={"tokens": batch, "elo_self": batch, "elo_oppo": batch, "move": batch, "value": batch})
    got = ort.InferenceSession(str(path)).run(
        None, {"tokens": tokens.numpy(), "elo_self": elos[0].numpy(), "elo_oppo": elos[1].numpy()})
    with torch.no_grad():
        want = Wrapped(net)(tokens, *elos)
    diff = float(np.abs(got[0] - want[0].numpy()).max())
    if diff > 1e-3:
        raise SystemExit(f"ONNX output differs from torch by {diff}")
    print(f"{path}  {path.stat().st_size / 1e6:.1f} MB  (max logit difference {diff:.1e})")
    return path


if __name__ == "__main__":
    export(sys.argv[1] if len(sys.argv) > 1 else "maia3-5m", Path(sys.argv[2] if len(sys.argv) > 2 else "models"))
