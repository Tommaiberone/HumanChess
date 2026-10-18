"""Write the Maia-3 weights as .npz files for the numpy forward pass (maia_np.py).

Usage: uv run --no-sync python scripts/export_maia.py [model] [out_dir]

The weights are split into two files of about the same size: each one goes into its
own Lambda layer, and a layer uploaded directly is capped at 50 MB.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from smartchess.maia import Maia3


def export(model: str, out: Path, parts: int = 2) -> list[Path]:
    state = Maia3(model).model.state_dict()
    # Every attention block refers to the shared GAB weight: keep a single copy.
    weights = {k: v.detach().float().numpy() for k, v in state.items() if not k.endswith("self_attn.gab_weight")}
    total = sum(a.nbytes for a in weights.values())
    groups: list[dict[str, np.ndarray]] = [{} for _ in range(parts)]
    size = 0
    for key, array in weights.items():
        groups[min(parts - 1, int(size * parts // total))][key] = array
        size += array.nbytes
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, group in enumerate(groups, start=1):
        path = out / f"part-{i}.npz"
        np.savez(path, **group)
        paths.append(path)
    return paths


if __name__ == "__main__":
    model = sys.argv[1] if len(sys.argv) > 1 else "maia3-23m"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else f"models/{model}")
    for path in export(model, out):
        print(f"{path}  {path.stat().st_size / 1e6:.1f} MB")
