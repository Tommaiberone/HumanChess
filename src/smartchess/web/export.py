"""The public site: a static folder that needs no backend.

index.html carries <meta name="smartchess-mode" content="browser">, so the frontend
fetches games from Chess.com or Lichess itself and runs Stockfish and Maia in the
visitor's browser (static/dist, built by `npm run build`). The only data shipped
besides the app is the demo games, hand-built records in data/games/demo*.json with
their reviews, listed first for every visitor.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from ..engine import PROJECT_ROOT
from .service import STATIC_DIR
from .store import LocalStore

MODE_META = '<meta name="smartchess-mode" content="browser">'
# Scripts, workers, fonts and styles only from this site; the page may fetch games from
# Chess.com and Lichess and, if configured, ask the explanation proxy (llm_lambda.py).
# 'wasm-unsafe-eval' lets WebAssembly compile.


def head_meta(llm_url: str = "", build: str = "") -> str:
    """The <meta> tags of the public index: mode, CSP, referrer, the build, and the explanation proxy if any."""
    connect = "'self' https://api.chess.com https://lichess.org"
    extra = ""
    if llm_url:
        connect += " " + llm_url.rstrip("/")
        extra = f'\n  <meta name="smartchess-llm" content="{llm_url}">'
    if build:
        extra += f'\n  <meta name="smartchess-build" content="{build}">'
    csp = (
        f"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        f"img-src 'self' data:; font-src 'self'; connect-src {connect}; "
        "worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"
    )
    return f'''{MODE_META}{extra}
  <meta http-equiv="Content-Security-Policy" content="{csp}">
  <meta name="referrer" content="no-referrer">'''


def demos(data: Path) -> list[dict]:
    store = LocalStore(data)
    out = []
    for key in store.keys("games/demo"):
        game = store.read(key)
        review = store.read("reviews/" + key.removeprefix("games/"))
        if game and review:
            out.append({"game": game, "review": review})
    return out


def export_site(out: Path, data: Path | None = None, llm_url: str = "") -> list[str]:
    """Write the site to `out` and return the ids of its demo games."""
    if not (STATIC_DIR / "dist" / "backend.js").exists():
        raise SystemExit("The browser bundles are missing: run `npm install && npm run build` first")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC_DIR, out / "static", ignore=shutil.ignore_patterns("login.html", "index.html", "demos.json"))
    shown = demos(data or PROJECT_ROOT / "data")
    (out / "static" / "demos.json").write_text(json.dumps(shown, ensure_ascii=False), encoding="utf-8")

    index = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    meta = head_meta(llm_url, build_id(out / "static", index))
    index = index.replace('<meta charset="utf-8">', f'<meta charset="utf-8">\n  {meta}', 1)
    (out / "index.html").write_text(index, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")  # GitHub Pages: serve every file as it is
    return [d["game"].get("id", "") for d in shown]


def build_id(static: Path, index: str) -> str:
    """A fingerprint of the page and its code: an open tab compares it with the live one
    to know the site was deployed since (app.js), and the footer shows it."""
    digest = hashlib.sha256(index.encode())
    for path in sorted(static.rglob("*")):
        if path.suffix in {".js", ".css", ".json", ".webmanifest"}:
            digest.update(path.relative_to(static).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:8]
