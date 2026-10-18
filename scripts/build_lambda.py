"""Build the AWS Lambda zips into build/lambda/ (used by infra/app).

Usage: uv run --no-project --python 3.12 python scripts/build_lambda.py

- app.zip: the smartchess package, shared by both functions;
- deps.zip: a layer with the `lambda` dependency group, Linux wheels for Python 3.12;
- maia-1.zip, maia-2.zip: layers with the Maia-3 weights (scripts/export_maia.py),
  one file each because a layer uploaded directly is capped at 50 MB.

The zips are reproducible (fixed timestamps, sorted entries, hash-based .pyc), so
Terraform uploads a layer again only when its content changes.
"""

from __future__ import annotations

import compileall
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "lambda"
WEIGHTS = ROOT / "models" / "maia3-23m"
LIMIT = 250 * 1024 * 1024  # unzipped size of a function and its layers
DIRECT_UPLOAD = 50 * 1024 * 1024


def compile_tree(path: Path) -> None:
    # The task root is read-only: without .pyc every cold start compiles from source.
    # Unchecked hashes keep them valid whatever timestamps the unzipped files get.
    compileall.compile_dir(path, quiet=1, invalidation_mode=compileall.py_compile.PycInvalidationMode.UNCHECKED_HASH)


def zip_tree(src: Path, dest: Path, prefix: str = "") -> int:
    """Zip `src` with fixed metadata; returns the unzipped size."""
    total = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(p for p in src.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(prefix + path.relative_to(src).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            data = path.read_bytes()
            z.writestr(info, data)
            total += len(data)
    return total


def build_deps(work: Path) -> Path:
    req = work / "requirements.txt"
    req.write_text(subprocess.run(
        ["uv", "export", "--frozen", "--only-group", "lambda", "--no-hashes", "--no-header", "--no-annotate"],
        cwd=ROOT, check=True, capture_output=True, text=True).stdout)
    target = work / "deps" / "python"
    # Linux wheels; only pure-Python packages (python-chess ships no wheel) are built here.
    subprocess.run(["uv", "pip", "install", "--quiet", "--python", sys.executable, "--target", str(target), "--no-deps",
                    "--python-platform", "x86_64-manylinux_2_28", "--python-version", "3.12", "-r", str(req)],
                   cwd=ROOT, check=True)
    native = [p.name for p in target.rglob("*.pyd")] + [p.name for p in target.rglob("*.dll")]
    if native:
        sys.exit(f"Windows binaries in the Lambda layer: {native[:5]}")
    for tests in target.glob("numpy/**/tests"):
        shutil.rmtree(tests)
    compile_tree(target)
    return target.parent


def build_app(work: Path) -> Path:
    src = work / "app"
    shutil.copytree(ROOT / "src" / "smartchess", src / "smartchess", ignore=shutil.ignore_patterns("__pycache__"))
    compile_tree(src)
    return src


def main() -> int:
    if sys.version_info[:2] != (3, 12):
        sys.exit("Run with Python 3.12, the Lambda runtime: uv run --no-project --python 3.12 ...")
    parts = sorted(WEIGHTS.glob("part-*.npz"))
    if not parts:
        sys.exit(f"No weights in {WEIGHTS}: run uv run --no-sync python scripts/export_maia.py")
    shutil.rmtree(OUT, ignore_errors=True)
    work = OUT / "work"
    work.mkdir(parents=True)

    sizes = {"app.zip": zip_tree(build_app(work), OUT / "app.zip"),
             "deps.zip": zip_tree(build_deps(work), OUT / "deps.zip")}
    for i, part in enumerate(parts, start=1):
        folder = work / f"maia-{i}" / "maia"
        folder.mkdir(parents=True)
        shutil.copyfile(part, folder / part.name)
        sizes[f"maia-{i}.zip"] = zip_tree(folder.parent, OUT / f"maia-{i}.zip")
    shutil.rmtree(work)

    for name, unzipped in sizes.items():
        zipped = (OUT / name).stat().st_size
        print(f"{name:<11} {zipped / 2**20:6.1f} MB zipped, {unzipped / 2**20:6.1f} MB unzipped")
        if zipped > DIRECT_UPLOAD:
            sys.exit(f"{name} is over the 50 MB of a direct upload")
    total = sum(sizes.values())
    print(f"worker      {total / 2**20:6.1f} MB unzipped of 250")
    if total > LIMIT:
        sys.exit("The worker is over the 250 MB Lambda limit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
