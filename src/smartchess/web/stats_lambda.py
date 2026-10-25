"""AWS Lambda: anonymous usage counters for the public site.

The page sends a short list of counter names ("view", "review_done", "ai_busy"...). This
function adds them to the day's totals in the DynamoDB table and nothing else:

- only names from a closed list are accepted, so a request can carry no free text: no
  usernames, no games, no positions, no error messages;
- nothing is stored per person. To count visitors once a day, a hash of IP + browser +
  date + a secret is kept for 48 hours (a "seen" marker with a TTL) and then deleted; it
  cannot be linked across days and the IP itself is never written anywhere;
- the page sends nothing when the browser says Do Not Track / Global Privacy Control;
- only requests from the site's own origin are accepted (the function URL's CORS does the
  same for browsers).

Read the totals with scripts/stats.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections import Counter

MAX_BODY = 4_000  # bytes of request
MAX_KEYS = 30  # counters in one request

# The buckets are shared with static/stats.js: a value below the first edge is "u<edge>",
# any other is the largest edge that does not exceed it.
ELO_EDGES = (1000, 1400, 1800, 2200)
SECS_EDGES = (30, 60, 120, 300)
PLIES_EDGES = (40, 80, 120)
DUR_EDGES = (10, 60, 300, 900)


def labels(edges: tuple[int, ...]) -> list[str]:
    return [f"u{edges[0]}"] + [str(e) for e in edges]


REFS = ("direct", "reddit", "lichess", "chesscom", "google", "search", "github", "x", "hn", "other")
DEVICES = ("phone", "tablet", "desktop")
LANGS = ("en", "it", "es", "fr", "de", "pt", "ru", "pl", "nl", "tr", "zh", "ja", "ko", "hi", "ar", "other")
SOURCES = ("chesscom", "lichess", "pgn", "demo")
FAILS = ("net", "mem", "engine", "other")


def allowed_keys(campaigns: tuple[str, ...]) -> frozenset[str]:
    keys = {"view", "about", "explore", "pgn.ok", "pgn.fail", "review_done", "ai_start", "ai_ok", "ai_busy", "ai_fail"}
    keys |= {f"view.ref.{r}" for r in REFS} | {f"view.dev.{d}" for d in DEVICES} | {f"view.lang.{x}" for x in LANGS}
    keys |= {f"view.from.{c}" for c in campaigns}
    keys |= {f"list.{s}.{r}" for s in ("chesscom", "lichess") for r in ("ok", "fail")}
    keys |= {f"open.{s}" for s in SOURCES} | {f"review_start.{s}" for s in SOURCES}
    keys |= {f"review_start.elo.{b}" for b in labels(ELO_EDGES)}
    keys |= {f"review_done.secs.{b}" for b in labels(SECS_EDGES)} | {f"review_done.plies.{b}" for b in labels(PLIES_EDGES)}
    keys |= {f"review_abandon.secs.{b}" for b in labels(SECS_EDGES)} | {"review_abandon"}
    keys |= {f"review_fail.{w}" for w in FAILS}
    keys |= {f"leave.dur.{b}" for b in labels(DUR_EDGES)}
    return frozenset(keys)


def unique_kind(key: str) -> str | None:
    """The "visitors who did this" counter a key also feeds, or None."""
    if key == "view":
        return "visitors"
    if key == "pgn.ok" or (key.startswith("list.") and key.endswith(".ok")):
        return "loaded"
    if key in {f"review_start.{s}" for s in SOURCES}:
        return "review_start"
    if key == "review_done":
        return "review_done"
    return {"ai_start": "ai", "explore": "explore"}.get(key)


class Rejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def campaigns() -> tuple[str, ...]:
    return tuple(c for c in os.environ.get("STATS_CAMPAIGNS", "").split(",") if c)


def parse(raw: str) -> Counter:
    """The accepted counters of a request body; the unknown names are dropped."""
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise Rejected(400, "Invalid JSON") from None
    names = body.get("k") if isinstance(body, dict) else None
    if not isinstance(names, list) or len(names) > MAX_KEYS:
        raise Rejected(400, "Expected {k: [names]}")
    ok = allowed_keys(campaigns())
    # A language outside the list still counts, as "other".
    names = ["view.lang.other" if isinstance(n, str) and n.startswith("view.lang.") and n not in ok else n for n in names]
    return Counter(n for n in names if isinstance(n, str) and n in ok)


# -- storage --------------------------------------------------------------------

_db = None
_recent: dict[str, list[int]] = {}  # visitor -> [hour, requests]: a per-container brake on floods


def _client():
    global _db
    if _db is None:
        import boto3

        _db = boto3.client("dynamodb")
    return _db


def first_time(day: str, kind: str, visitor: str, now: float) -> bool:
    """True the first time this visitor does `kind` today. The marker expires in 48 hours."""
    try:
        _client().put_item(
            TableName=os.environ["SMARTCHESS_TABLE"],
            Item={"pk": {"S": "seen"}, "sk": {"S": f"{day}#{kind}#{visitor}"}, "expires": {"N": str(int(now) + 2 * 86400)}},
            ConditionExpression="attribute_not_exists(pk)",
        )
        return True
    except Exception as exc:  # noqa: BLE001 - the condition failing is the normal "seen before"
        if getattr(exc, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def add(day: str, counts: Counter) -> None:
    names = {f"#c{i}": key for i, key in enumerate(counts)}
    values = {f":n{i}": {"N": str(n)} for i, n in enumerate(counts.values())}
    _client().update_item(
        TableName=os.environ["SMARTCHESS_TABLE"],
        Key={"pk": {"S": "stats"}, "sk": {"S": f"day#{day}"}},
        UpdateExpression="ADD " + ", ".join(f"#c{i} :n{i}" for i in range(len(counts))),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def record(counts: Counter, ip: str, agent: str, now: float | None = None) -> None:
    now = now or time.time()
    day = time.strftime("%Y%m%d", time.gmtime(now))
    visitor = hashlib.sha256(f"{os.environ.get('STATS_SALT', '')}|{day}|{ip}|{agent}".encode()).hexdigest()[:20]
    hour = int(now // 3600)
    seen = _recent.setdefault(visitor, [hour, 0])
    if seen[0] != hour:
        seen[:] = [hour, 0]
    seen[1] += 1
    if seen[1] > int(os.environ.get("STATS_PER_HOUR", "120")):
        raise Rejected(429, "Slow down")
    total = Counter(counts)
    for key in counts:
        kind = unique_kind(key)
        if kind and first_time(day, kind, visitor, now):
            total[f"u.{kind}"] += 1
    add(day, total)


# -- handler --------------------------------------------------------------------

def handle(event: dict) -> dict:
    http = event.get("requestContext", {}).get("http", {})
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if http.get("method") != "POST":
        raise Rejected(405, "POST only")
    allowed = os.environ.get("ALLOWED_ORIGIN", "")
    if allowed and headers.get("origin") != allowed:
        raise Rejected(403, "Not allowed from this origin")
    raw = event.get("body") or ""
    if len(raw) > MAX_BODY:
        raise Rejected(413, "Request too large")
    counts = parse(raw)
    if counts:
        record(counts, http.get("sourceIp", "unknown"), headers.get("user-agent", ""))
    return {"statusCode": 204}


def handler(event, context):
    try:
        return handle(event)
    except Rejected as exc:
        return {"statusCode": exc.status, "headers": {"content-type": "application/json"}, "body": json.dumps({"error": str(exc)})}
    except Exception as exc:  # noqa: BLE001 - counting must never break the page
        print(f"stats failed: {type(exc).__name__}: {str(exc)[:200]}")
        return {"statusCode": 204}
