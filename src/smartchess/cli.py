"""Command line interface.

    smartchess position --moves "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5"
    smartchess position --fen "<FEN>" --elo 1700 --opp-elo 1600
    smartchess review --chesscom <username> [--games 3]
    smartchess review --pgn game.pgn --user <name>
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import chess

from .engine import Stockfish
from .explain import format_console, numbered
from .importers import chesscom_games, read_pgn_file
from .practical import Players, Searcher, Settings
from .report import write_report
from .review import DEFAULT_ELO, detect_user_color, game_players, review_game
from .winprob import format_cp


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--elo", type=int, help=f"your rating on the Maia scale (default from PGN, else {DEFAULT_ELO})")
    p.add_argument("--opp-elo", type=int, help="opponent rating on the Maia scale")
    p.add_argument("--margin", type=float, default=60, help="centipawns the simple move may give up (balanced position)")
    p.add_argument("--tricky-margin", type=float, default=100, help="centipawns the tricky move may give up")
    p.add_argument("--model", default="maia3-23m", help="Maia-3 model (maia3-5m, maia3-23m, maia3-79m)")
    p.add_argument("--threads", type=int, default=4, help="Stockfish threads in total")
    p.add_argument("--workers", type=int, default=4, help="Stockfish instances analysing in parallel")
    p.add_argument("--depth", type=int, default=12, help="Stockfish depth inside the practical search")
    p.add_argument("--root-depth", type=int, default=18, help="Stockfish depth for candidate moves")
    p.add_argument("--llm", action="store_true", help="explain with Groq instead of templates")


def _print_analysis(analysis, header: str, played=None, played_cp=None, use_llm: bool = False) -> None:
    if not use_llm:
        print(format_console(analysis, header))
        return
    from .facts import position_facts
    from .llm import narrate

    n = narrate(analysis, position_facts(analysis, played, played_cp))
    print(header)
    if n.get("summary"):
        print(f"  {n['summary']}")
    for role, title in (("best", "Best"), ("simple", "Simplest"), ("tricky", "Trickiest")):
        c = {"best": analysis.best, "simple": analysis.simplest, "tricky": analysis.trickiest}[role]
        print(f"  {title:<10} {numbered(analysis.board, c.move):<12} {format_cp(c.line.cp):>6}\n      {n[role]}")
    print(f"  [{n['source']}]" + (f" {n['error']}" if n.get("error") else ""))


def _settings(args) -> Settings:
    return Settings(margin_cp=args.margin, tricky_margin_cp=args.tricky_margin, root_depth=args.root_depth)


def _engines(args):
    from .maia import Maia3  # imports torch, so keep it out of --help

    per_engine = max(1, args.threads // args.workers)
    return [Stockfish(threads=per_engine, hash_mb=256, depth=args.depth) for _ in range(args.workers)], Maia3(args.model)


def cmd_position(args) -> int:
    if args.fen:
        board = chess.Board(args.fen)
    else:
        board = chess.Board()
        for san in (args.moves or "").split():
            board.push_san(san)
    user_elo = args.elo or DEFAULT_ELO
    players = Players(board.turn, user_elo, args.opp_elo or user_elo)
    engines, human = _engines(args)
    try:
        analysis = Searcher(engines[0], human, players, _settings(args)).analyse(board)
    finally:
        for e in engines:
            e.close()
    header = f"Position: {board.fen()}  (Maia Elo: you {players.user_elo}, opponent {players.opp_elo})"
    _print_analysis(analysis, header, use_llm=args.llm)
    return 0


def _safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")


def cmd_review(args) -> int:
    if args.chesscom:
        games = chesscom_games(args.chesscom, args.games, None if args.time_class == "any" else args.time_class)
        username = args.user or args.chesscom
    else:
        games = read_pgn_file(args.pgn)[: args.games]
        username = args.user
    if not games:
        print("No games found.", file=sys.stderr)
        return 1

    engines, human = _engines(args)
    try:
        for game in games:
            color = {"white": chess.WHITE, "black": chess.BLACK}.get(args.color) if args.color else None
            color = color if color is not None else detect_user_color(game, username)
            if color is None:
                print("Cannot tell which colour you played: use --user or --color.", file=sys.stderr)
                return 1
            players = game_players(game, color, args.elo, args.opp_elo)
            h = game.headers
            print(f"\n=== {h.get('White')} ({h.get('WhiteElo', '?')}) – {h.get('Black')} ({h.get('BlackElo', '?')})"
                  f"  {h.get('Result', '')}  {h.get('Link', '')}")
            review = review_game(game, engines, human, _settings(args), players, max_mistakes=args.max_mistakes,
                                 max_choices=args.max_choices, skip_plies=args.skip_plies)
            for mr in review.moves:
                kind = "MISTAKE" if mr.kind == "mistake" else "PRACTICAL CHOICE"
                header = (f"\n[{kind}] {numbered(mr.board, mr.played)} played ({format_cp(mr.played_cp)}), "
                          f"best {format_cp(mr.best_cp)}")
                _print_analysis(mr.analysis, header, mr.played, mr.played_cp, args.llm)
            if not args.no_html:
                name = _safe_name(f"{h.get('Date', '')}_{h.get('White', '')}-{h.get('Black', '')}")
                path = write_report(review, Path(args.out) / f"{name}.html")
                print(f"\nReport: {path.resolve()}")
    finally:
        for e in engines:
            e.close()
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    parser = argparse.ArgumentParser(prog="smartchess", description="Human-aware chess game review")
    sub = parser.add_subparsers(dest="cmd", required=True)

    pos = sub.add_parser("position", help="analyse one position (you are the side to move)")
    pos.add_argument("--fen")
    pos.add_argument("--moves", help="SAN moves from the start position, keeps history for Maia")
    _add_common(pos)
    pos.set_defaults(func=cmd_position)

    rev = sub.add_parser("review", help="review your games")
    src = rev.add_mutually_exclusive_group(required=True)
    src.add_argument("--pgn")
    src.add_argument("--chesscom", metavar="USERNAME")
    rev.add_argument("--games", type=int, default=1, help="how many games (most recent first)")
    rev.add_argument("--time-class", default="rapid", help="Chess.com time class filter, or 'any'")
    rev.add_argument("--user", help="your username in the PGN")
    rev.add_argument("--color", choices=["white", "black"])
    rev.add_argument("--max-mistakes", type=int, default=5)
    rev.add_argument("--max-choices", type=int, default=5)
    rev.add_argument("--skip-plies", type=int, default=6, help="opening plies to skip")
    rev.add_argument("--out", default="reports", help="folder for HTML reports")
    rev.add_argument("--no-html", action="store_true")
    _add_common(rev)
    rev.set_defaults(func=cmd_review)

    web = sub.add_parser("web", help="start the web app")
    web.add_argument("--user", help="default Chess.com username")
    web.add_argument("--port", type=int, default=8765)
    web.add_argument("--no-browser", action="store_true")
    _add_common(web)
    web.set_defaults(func=cmd_web)

    exp = sub.add_parser("export", help="write the public site (analysis runs in the visitor's browser)")
    exp.add_argument("--out", default="site")
    exp.add_argument("--data", help="folder with the demo games (default: data/)")
    exp.add_argument("--llm-url", default="", help="explanation proxy (terraform -chdir=infra/app output llm_url): enables 'rewrite with AI'")
    exp.set_defaults(func=cmd_export)

    args = parser.parse_args(argv)
    return args.func(args)


def cmd_export(args) -> int:
    from .web.export import export_site

    ids = export_site(Path(args.out), Path(args.data) if args.data else None, args.llm_url)
    print(f"Exported the site with {len(ids)} demo games to {Path(args.out).resolve()}")
    return 0


def cmd_web(args) -> int:
    import threading
    import webbrowser

    import uvicorn

    from .web.app import create_app
    from .web.service import Service

    service = Service(model=args.model, threads=args.threads, workers=args.workers, depth=args.depth, settings=_settings(args))
    app = create_app(service, default_user=args.user)
    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, [url]).start()
    print(f"HumanChess: {url}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
