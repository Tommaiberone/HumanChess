"""FastAPI app: JSON API plus the static single-page UI."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .service import Service

STATIC = Path(__file__).parent / "static"
SESSION_COOKIE = "smartchess_session"


class PositionRequest(BaseModel):
    start_fen: str
    moves: list[str] = []
    user_elo: int
    opp_elo: int


def create_app(service: Service | None = None, default_user: str | None = None,
               password: str | None = None) -> FastAPI:
    """`password` (or SMARTCHESS_PASSWORD) puts the whole app behind a login page."""
    service = service or Service()
    default_user = default_user or os.environ.get("SMARTCHESS_USER", "")
    password = password or os.environ.get("SMARTCHESS_PASSWORD", "")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        service.close()

    app = FastAPI(title="SmartChess", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.middleware("http")
    async def revalidate_frontend(request: Request, call_next):
        # File names carry no hash: make browsers check the ETag on every load, or a
        # phone keeps running an old app.js against a newer API after a deploy.
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    if password:
        # A login page and a session cookie rather than basic auth: a Lambda function
        # URL renames WWW-Authenticate, so a browser would never show the prompt. Basic
        # auth (user `smartchess`) still works for scripts. The cookie is derived from
        # the password, so changing the password signs everyone out.
        session = hmac.new(password.encode(), b"smartchess-session", hashlib.sha256).hexdigest().encode()
        basic = ("Basic " + base64.b64encode(f"smartchess:{password}".encode()).decode()).encode()

        def signed_in(request: Request) -> bool:
            return (secrets.compare_digest(request.cookies.get(SESSION_COOKIE, "").encode(), session)
                    or secrets.compare_digest(request.headers.get("authorization", "").encode(), basic))

        @app.middleware("http")
        async def require_login(request: Request, call_next):
            path = request.url.path
            if path == "/login" or path.startswith("/static/") or signed_in(request):
                return await call_next(request)
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sign in again"}, status_code=401)
            return RedirectResponse("/login", status_code=303)

        @app.get("/login")
        def login_page():
            return FileResponse(STATIC / "login.html", headers={"Cache-Control": "no-cache"})

        @app.post("/login")
        async def login(request: Request):
            form = parse_qs((await request.body()).decode())
            if not secrets.compare_digest(form.get("password", [""])[0].encode(), password.encode()):
                return RedirectResponse("/login?wrong", status_code=303)
            response = RedirectResponse("/", status_code=303)
            response.set_cookie(SESSION_COOKIE, session.decode(), max_age=400 * 86400, httponly=True,
                                secure=request.url.scheme == "https", samesite="lax")
            return response

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
            raise HTTPException(502, f"Chess.com is not responding: {exc}") from exc

    @app.get("/api/games/{game_id}")
    def game(game_id: str, user: str = ""):
        user = user or default_user
        try:
            return service.game_moves(game_id, user)
        except KeyError as exc:
            raise HTTPException(404, "Game not found: reload the list") from exc

    @app.get("/api/reviews/{game_id}")
    def cached_review(game_id: str):
        review = service.cached_review(game_id)
        if review is None:
            raise HTTPException(404, "No review")
        return review

    @app.post("/api/reviews/{game_id}")
    def start_review(game_id: str, user: str = ""):
        user = user or default_user
        try:
            return service.start_review(game_id, user).public()
        except KeyError as exc:
            raise HTTPException(404, "Game not found: reload the list") from exc

    @app.post("/api/reviews/{game_id}/narrations")
    def renarrate(game_id: str):
        if service.cached_review(game_id) is None:
            raise HTTPException(404, "No review")
        return service.start_renarrate(game_id).public()

    @app.post("/api/positions")
    def start_position(req: PositionRequest):
        return service.start_position(req.start_fen, req.moves, req.user_elo, req.opp_elo).public()

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        job = service.job(job_id)
        if job is None:
            raise HTTPException(404, "Unknown job")
        return job.public()

    return app
