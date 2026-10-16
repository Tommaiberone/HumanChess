"""FastAPI app: JSON API plus the static single-page UI."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .service import Service

STATIC = Path(__file__).parent / "static"


class PositionRequest(BaseModel):
    start_fen: str
    moves: list[str] = []
    user_elo: int
    opp_elo: int


def create_app(service: Service | None = None, default_user: str | None = None) -> FastAPI:
    service = service or Service()
    default_user = default_user or os.environ.get("SMARTCHESS_USER", "")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        service.close()

    app = FastAPI(title="SmartChess", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/config")
    def config():
        s = service.settings
        return {"username": default_user, "margin_cp": s.margin_cp, "tricky_margin_cp": s.tricky_margin_cp}

    @app.get("/api/games")
    def games(user: str = "", time_class: str | None = None, limit: int = 30):
        user = user or default_user
        try:
            return service.list_games(user, limit, time_class or None)
        except Exception as exc:
            raise HTTPException(502, f"Chess.com non risponde: {exc}") from exc

    @app.get("/api/games/{game_id}")
    def game(game_id: str, user: str = ""):
        user = user or default_user
        try:
            return service.game_moves(game_id, user)
        except KeyError as exc:
            raise HTTPException(404, "Partita non trovata: ricarica l'elenco") from exc

    @app.get("/api/reviews/{game_id}")
    def cached_review(game_id: str):
        review = service.cached_review(game_id)
        if review is None:
            raise HTTPException(404, "Nessuna review")
        return review

    @app.post("/api/reviews/{game_id}")
    def start_review(game_id: str, user: str = ""):
        user = user or default_user
        try:
            return service.start_review(game_id, user).public()
        except KeyError as exc:
            raise HTTPException(404, "Partita non trovata: ricarica l'elenco") from exc

    @app.post("/api/reviews/{game_id}/narrations")
    def renarrate(game_id: str):
        if service.cached_review(game_id) is None:
            raise HTTPException(404, "Nessuna review")
        return service.start_renarrate(game_id).public()

    @app.post("/api/positions")
    def start_position(req: PositionRequest):
        return service.start_position(req.start_fen, req.moves, req.user_elo, req.opp_elo).public()

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        job = service.job(job_id)
        if job is None:
            raise HTTPException(404, "Job sconosciuto")
        return job.public()

    return app
