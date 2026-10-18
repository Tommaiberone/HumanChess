"""Static "showcase" export: the reviewed games as a site that needs no backend.

The frontend switches to read-only mode when index.html carries
<meta name="smartchess-mode" content="static">: it reads data/*.json instead of
the API and hides live analysis. Nothing secret is exported.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from ..importers import chesscom_summary
from .service import STATIC_DIR, Service


def export_site(service: Service, out: Path, username: str) -> list[str]:
    """Write the site to `out` and return the ids of the exported games."""
    if out.exists():
        shutil.rmtree(out)
    (out / "data" / "games").mkdir(parents=True)
    (out / "data" / "reviews").mkdir(parents=True)
    shutil.copytree(STATIC_DIR, out / "static", ignore=shutil.ignore_patterns("login.html"))

    index = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    index = index.replace("<meta charset=\"utf-8\">", "<meta charset=\"utf-8\">\n  <meta name=\"smartchess-mode\" content=\"static\">", 1)
    (out / "index.html").write_text(index, encoding="utf-8")
    (out / "static" / "index.html").unlink()

    games = []
    for game_id in service.reviewed_ids():
        try:
            raw = service._raw_game(game_id)
        except KeyError:
            continue
        summary = chesscom_summary(raw, username)
        summary["review"] = service._review_brief(game_id)
        games.append(summary)
        moves = service.game_moves(game_id, username)
        _write(out / "data" / "games" / f"{game_id}.json", moves)
        _write(out / "data" / "reviews" / f"{game_id}.json", service.cached_review(game_id))

    # Demo games first, then the real ones from the newest.
    games.sort(key=lambda g: (g.get("demo", False), g.get("end_time") or 0), reverse=True)
    _write(out / "data" / "games.json", games)
    _write(out / "data" / "config.json", {"username": username, "static": True})
    return [g["id"] for g in games]


def _write(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
