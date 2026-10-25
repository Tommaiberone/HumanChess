"""Print the site's anonymous usage counters (src/smartchess/web/stats_lambda.py).

Usage: uv run --no-project --with boto3 python scripts/stats.py [--days 14]
Env:   AWS_PROFILE_NAME (default job-radar), AWS_REGION (default eu-west-1), SMARTCHESS_TABLE (default smartchess).

Days are UTC. "Visitors" are counted once per day (a salted hash of IP + browser that
expires after 48 hours), so a person who comes back on another day counts again.
"""

from __future__ import annotations

import argparse
import os
import time
from collections import Counter

import boto3


def load(days: int) -> dict[str, Counter]:
    session = boto3.Session(profile_name=os.environ.get("AWS_PROFILE_NAME", "job-radar"), region_name=os.environ.get("AWS_REGION", "eu-west-1"))
    db = session.client("dynamodb")
    first = time.strftime("%Y%m%d", time.gmtime(time.time() - (days - 1) * 86400))
    out: dict[str, Counter] = {}
    resp = db.query(
        TableName=os.environ.get("SMARTCHESS_TABLE", "smartchess"),
        KeyConditionExpression="pk = :p AND sk >= :s",
        ExpressionAttributeValues={":p": {"S": "stats"}, ":s": {"S": f"day#{first}"}},
    )
    for item in resp["Items"]:
        out[item["sk"]["S"].removeprefix("day#")] = Counter({k: int(v["N"]) for k, v in item.items() if "N" in v})
    return out


def pct(part: float, whole: float) -> str:
    return f"{100 * part / whole:3.0f}%" if whole else "  - "


def breakdown(title: str, total: Counter, prefix: str, order: list[str] | None = None, of: str = "") -> None:
    rows = {k.removeprefix(prefix): v for k, v in total.items() if k.startswith(prefix)}
    if not rows:
        return
    base = total[of] if of else sum(rows.values())
    names = [n for n in (order or []) if n in rows] + sorted((n for n in rows if n not in (order or [])), key=lambda n: -rows[n])
    print(f"\n{title}")
    for name in names:
        shown = f"<{name[1:]}" if name[0] == "u" and name[1:].isdigit() else f"{name}+" if name.isdigit() else name  # a bucket: "u30" is under 30, "60" is 60 and more
        print(f"  {shown:<14}{rows[name]:>7}  {pct(rows[name], base)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    days = load(parser.parse_args().days)
    if not days:
        print("No counters yet.")
        return
    total = Counter()
    for counts in days.values():
        total.update(counts)

    print(f"{'day':<10}{'visitors':>9}{'views':>7}{'loaded':>8}{'reviews':>9}{'done':>6}{'AI':>5}")
    for day, c in sorted(days.items()):
        print(f"{day:<10}{c['u.visitors']:>9}{c['view']:>7}{c['u.loaded']:>8}{c['u.review_start']:>9}{c['u.review_done']:>6}{c['u.ai']:>5}")
    print(f"{'total':<10}{total['u.visitors']:>9}{total['view']:>7}{total['u.loaded']:>8}{total['u.review_start']:>9}{total['u.review_done']:>6}{total['u.ai']:>5}")

    v = total["u.visitors"]
    print("\nWhat visitors did (of the visitors who came, counted once a day)")
    for label, key in (("loaded games or a PGN", "u.loaded"), ("started a review", "u.review_start"), ("finished a review", "u.review_done"),
                       ("analysed a position", "u.explore"), ("pressed 'rewrite with AI'", "u.ai")):
        print(f"  {label:<28}{total[key]:>6}  {pct(total[key], v)}")

    breakdown("Where from (page views)", total, "view.ref.", of="view")
    breakdown("Tagged links (?from=)", total, "view.from.", of="view")
    breakdown("Devices (page views)", total, "view.dev.", ["phone", "tablet", "desktop"], of="view")
    breakdown("Languages (page views)", total, "view.lang.", of="view")
    breakdown("Games loaded", total, "list.")
    breakdown("Games opened", total, "open.")
    breakdown("Reviews started", total, "review_start.", of="")
    breakdown("Rating of who reviews", total, "review_start.elo.", ["u1000", "1000", "1400", "1800", "2200"])
    breakdown("Review time", total, "review_done.secs.", ["u30", "30", "60", "120", "300"], of="review_done")
    breakdown("Game length (plies)", total, "review_done.plies.", ["u40", "40", "80", "120"], of="review_done")
    breakdown("Left while analysing (waited)", total, "review_abandon.secs.", ["u30", "30", "60", "120", "300"])
    breakdown("Reviews that failed", total, "review_fail.")
    breakdown("Time on the site", total, "leave.dur.", ["u10", "10", "60", "300", "900"])
    ai = {k: total[k] for k in ("ai_start", "ai_ok", "ai_busy", "ai_fail")}
    if ai["ai_start"]:
        print(f"\nAI explanations: {ai['ai_start']} asked, {ai['ai_ok']} ok, {ai['ai_busy']} busy, {ai['ai_fail']} failed")
    print(f"\nPGN pasted: {total['pgn.ok']} ok, {total['pgn.fail']} failed · About page opened: {total['about']}")
    print("Numbers are indicative: anyone can send counters to the endpoint, and a visitor with Do Not Track is not counted.")


if __name__ == "__main__":
    main()
