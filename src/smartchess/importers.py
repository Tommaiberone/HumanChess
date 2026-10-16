"""Load games from PGN files or from the Chess.com public API."""

from __future__ import annotations

import io
from pathlib import Path

import chess.pgn
import requests

# Chess.com asks API clients to identify themselves.
USER_AGENT = "SmartChess/0.1 (personal open-source game review tool)"


def read_pgn_file(path: str | Path) -> list[chess.pgn.Game]:
    games = []
    with open(path, encoding="utf-8") as f:
        while (game := chess.pgn.read_game(f)) is not None:
            games.append(game)
    return games


def parse_pgn(text: str) -> chess.pgn.Game:
    game = chess.pgn.read_game(io.StringIO(text))
    if game is None:
        raise ValueError("Invalid PGN")
    return game


DRAW_RESULTS = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}


def chesscom_raw_games(username: str, max_games: int = 30, time_class: str | None = None) -> list[dict]:
    """Raw Chess.com API game objects (standard chess only), newest first."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    url = f"https://api.chess.com/pub/player/{username.lower()}/games/archives"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    archives = resp.json().get("archives", [])

    games: list[dict] = []
    for archive in reversed(archives):
        resp = session.get(archive, timeout=30)
        resp.raise_for_status()
        for g in reversed(resp.json().get("games", [])):
            if g.get("rules") != "chess" or "pgn" not in g:
                continue
            if time_class and g.get("time_class") != time_class:
                continue
            games.append(g)
            if len(games) >= max_games:
                return games
    return games


def chesscom_summary(g: dict, username: str) -> dict:
    """The fields the game list needs, from the user's point of view."""
    name = username.lower()
    user_is_white = g["white"]["username"].lower() == name
    me, opp = (g["white"], g["black"]) if user_is_white else (g["black"], g["white"])
    result = "win" if me["result"] == "win" else "draw" if me["result"] in DRAW_RESULTS else "loss"
    opening = g.get("eco", "").rstrip("/").rsplit("/", 1)[-1].replace("-", " ")
    return {
        "id": g["url"].rstrip("/").rsplit("/", 1)[-1],
        "url": g["url"],
        "end_time": g.get("end_time"),
        "time_class": g.get("time_class"),
        "time_control": g.get("time_control"),
        "user_color": "white" if user_is_white else "black",
        "username": me["username"],
        "user_rating": me.get("rating"),
        "opponent": opp["username"],
        "opponent_rating": opp.get("rating"),
        "result": result,
        "result_detail": me["result"] if result != "win" else opp["result"],
        "opening": opening,
    }


def chesscom_games(username: str, max_games: int = 1, time_class: str | None = "rapid") -> list[chess.pgn.Game]:
    """Most recent standard-chess games of `username`, newest first."""
    return [parse_pgn(g["pgn"]) for g in chesscom_raw_games(username, max_games, time_class)]
