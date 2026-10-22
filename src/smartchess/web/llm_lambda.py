"""AWS Lambda: the proxy that lets the public site ask Groq for explanations.

The site runs entirely in the visitor's browser, so a Groq key cannot live there. This
function holds it instead. The browser sends the facts of one key moment (what the
analysis found: moves, evals, motifs; no names) and gets back the explanation.

The facts come from an untrusted client, so the function:
- accepts only the shape the analysis produces, with bounded sizes, so it cannot be used
  as a free general-purpose chat;
- limits requests per visitor (hashed IP, per hour) and overall (per day), with counters
  in the DynamoDB table; past a limit the site keeps its template explanations;
- only answers requests from the site's own origin (the function URL's CORS does the
  same for browsers).

`smartchess.llm.explain` already rejects any answer that mentions a move absent from the
facts and falls back across models.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time

from ..llm import LLMError, explain

MAX_BODY = 40_000  # bytes of request
MAX_STRING = 700  # characters of any string inside the facts
MAX_DRAFT = 1_500  # characters of a template draft
MAX_ITEMS = 80  # items of any list inside the facts
MAX_DEPTH = 7
REQUIRED = ("side", "user_elo", "best", "simple", "tricky", "same")
ROLES = ("best", "simple", "tricky")


class Rejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _bounded(value, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise Rejected(400, "Facts nested too deeply")
    if isinstance(value, dict):
        if len(value) > MAX_ITEMS:
            raise Rejected(400, "Facts too large")
        for k, v in value.items():
            if not isinstance(k, str) or len(k) > 40:
                raise Rejected(400, "Bad key in the facts")
            _bounded(v, depth + 1)
    elif isinstance(value, list):
        if len(value) > MAX_ITEMS:
            raise Rejected(400, "Facts too large")
        for v in value:
            _bounded(v, depth + 1)
    elif isinstance(value, str):
        if len(value) > MAX_STRING:
            raise Rejected(400, "A string in the facts is too long")
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise Rejected(400, "Unsupported value in the facts")


def validate(body: dict) -> tuple[dict, dict]:
    """(facts, drafts) of a well-formed request, or Rejected."""
    facts, drafts = body.get("facts"), body.get("drafts")
    if not isinstance(facts, dict) or not isinstance(drafts, dict):
        raise Rejected(400, "Expected {facts, drafts}")
    if any(k not in facts for k in REQUIRED) or not all(isinstance(facts[r], dict) for r in ROLES):
        raise Rejected(400, "These do not look like analysis facts")
    if not isinstance(facts["user_elo"], int) or not 100 <= facts["user_elo"] <= 3500:
        raise Rejected(400, "Bad rating")
    if facts["side"] not in ("white", "black"):
        raise Rejected(400, "Bad side")
    _bounded(facts)
    if set(drafts) - set(ROLES) or not all(isinstance(drafts.get(r), str) and len(drafts[r]) <= MAX_DRAFT for r in ROLES):
        raise Rejected(400, "Bad drafts")
    return facts, drafts


# -- limits ---------------------------------------------------------------------

_db = None


def _count(key: str, ttl: int) -> int:
    """Add one to the counter `key` (expiring after `ttl` seconds) and return its value."""
    global _db
    if _db is None:
        import boto3

        _db = boto3.client("dynamodb")
    resp = _db.update_item(
        TableName=os.environ["SMARTCHESS_TABLE"],
        Key={"pk": {"S": "ratelimit"}, "sk": {"S": key}},
        UpdateExpression="ADD n :one SET expires = :exp",
        ExpressionAttributeValues={":one": {"N": "1"}, ":exp": {"N": str(int(time.time()) + ttl)}},
        ReturnValues="UPDATED_NEW",
    )
    return int(resp["Attributes"]["n"]["N"])


def check_limits(ip: str, now: float | None = None) -> None:
    now = now or time.time()
    day = time.strftime("%Y%m%d", time.gmtime(now))
    hour = time.strftime("%Y%m%d%H", time.gmtime(now))
    visitor = hashlib.sha256(f"{ip}|{day}".encode()).hexdigest()[:16]  # the salt changes daily: no lasting log of visitors
    if _count(f"ip-{visitor}-{hour}", 2 * 3600) > int(os.environ.get("LLM_PER_IP_HOUR", "40")):
        raise Rejected(429, "Too many explanation requests from your connection: try again in an hour")
    if _count(f"day-{day}", 2 * 86400) > int(os.environ.get("LLM_PER_DAY", "1500")):
        raise Rejected(429, "The daily limit of AI explanations has been reached: try again tomorrow")


# -- handler --------------------------------------------------------------------

def _reply(status: int, payload: dict) -> dict:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(payload)}


def handle(event: dict) -> dict:
    http = event.get("requestContext", {}).get("http", {})
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if http.get("method") != "POST":
        raise Rejected(405, "POST only")
    allowed = os.environ.get("ALLOWED_ORIGIN", "")
    if allowed and headers.get("origin") != allowed:
        raise Rejected(403, "Not allowed from this origin")
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    if len(raw) > MAX_BODY:
        raise Rejected(413, "Request too large")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise Rejected(400, "Invalid JSON") from None
    if not isinstance(body, dict):
        raise Rejected(400, "Expected a JSON object")
    facts, drafts = validate(body)
    check_limits(http.get("sourceIp", "unknown"))
    try:
        data, model = explain(facts, drafts, max_wait=8)
    except LLMError as exc:
        raise Rejected(502, f"The explanation service is busy: {str(exc)[:160]}") from None
    return _reply(200, {**data, "source": model})


def handler(event, context):
    try:
        return handle(event)
    except Rejected as exc:
        return _reply(exc.status, {"error": str(exc)})
