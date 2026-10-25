"""LLM explanations via Groq (OpenAI-compatible API).

The model only rewrites facts computed by Stockfish and Maia into friendly prose.
Every piece move it mentions must appear in the facts; otherwise the next model in
the chain is tried, and callers fall back to the templates in `explain.py`.

Groq free tier (Oct 2026): per model 30 requests and 8,000 tokens per minute, so on
a 429 we move on to the next model and park the saturated one for `retry-after`;
when all are parked we wait for the first to free up.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import requests

from .explain import advise
from .facts import allowed_moves, normalize_san
from .practical import PositionAnalysis

URL = "https://api.groq.com/openai/v1/chat/completions"
# qwen is the default (the user's choice), gpt-oss-120b the fallback. gpt-oss-20b is
# left out: its explanations were often nonsensical. Llama 3.3 70B is gone from Groq
# (404 model_not_found, Oct 2026) although the docs still list it.
MODELS = ("qwen/qwen3.8-27b", "openai/gpt-oss-120b")
TIMEOUT = 30
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Piece moves, captures and castling. Plain pawn pushes ("e5") are skipped
# because they look exactly like square names ("the pawn on e5").
SAN_RE = re.compile(r"(?:\d+\.(?:\.\.)?\s?)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?")

SYSTEM = """You are a friendly, concrete chess coach. You explain moves to a player rated about {elo} (Lichess scale), in English, warmly but without fluff.

You receive the FACTS of a position, computed by Stockfish (the engine) and Maia (a model of human moves):
- "best": the best move according to Stockfish;
- "simple": the move, within a small margin of the best (about 0.6 pawns), that is easiest to handle at the player's level ("at_your_level" = expected evaluation if the player keeps playing at their level);
- "tricky": the move, within a wider margin (up to about 1 pawn), that scores best against a real human opponent ("traps" = likely wrong replies, with their probability "prob", the punishment and the chance of finding it);
- "critical_moment": the point where the player will need a hard move ("find_prob" = chance of finding it);
- "motifs": themes of the move (captures, checks, forks, pins, discovered attacks, threats, pieces rescued or defended, passed pawns, open files);
- "opponent_threats": what the opponent threatens before the move: it explains why the right move is needed.

The player has the "side" pieces, the opponent the "opponent_side" pieces: never mix them up. The "motifs" describe what each of the player's moves does.
You also receive DRAFTS: correct sentences generated from the facts. Rewrite them in a warmer, more natural way and add the why using the motifs. Never contradict them.

Rules:
- Use ONLY moves, numbers and lines present in the facts. Do not calculate and do not invent lines or threats.
- Do not quote "loss_win_pct", "win" or other technical numbers besides evaluations and probabilities.
- If there is no "played" in the facts, do not talk about a played move.
- Write moves exactly as in the facts (English notation, e.g. 14...Nf6).
- Write probabilities as percentages (0.16 -> 16%; below 0.01 write "almost never").
- Each field is a paragraph of 2-3 complete sentences (at least 20 words), addressing the player as "you".

Type of moment ("moment"):
- "mistake": the player lost a lot here. In "summary" explain what was wrong with the played move, using "played.line" (what happens next) and its "motifs".
- "practical choice": the played move was reasonable; the point is to compare the practical options. If "played.roles" is not empty, the player chose exactly that move: tell them, with a compliment.
- If "same.only_one_candidate" is true, there was only one good move: write "simple" and "tricky" as empty strings.

What to write in each field:
- "summary": one sentence on the character of the position; if there is "played", say whether the played move was good or what it was missing compared to the alternatives.
- "best": why the move is strong, using its "motifs" and the start of "line". If it has a "critical_moment", warn: after which moves ("after") which move is needed ("needed") and how likely it is to be found.
- "simple": if it differs from "best", explain why it is easier to handle: compare the "at_your_level" of the two and mention the "critical_moment" of best that it avoids. If it is the same as best, explain that here the best move is also the most comfortable choice, or that the alternatives are even harder.
- "tricky": if it has "traps", tell the main trap: which natural but wrong reply ("reply", with "prob") and how you punish it ("punishment", with "find_prob"). Remember that the risk is limited: against the best reply the evaluation stays at "eval". If there are no traps, say that against a human it still scores "vs_human".

Reply with a JSON object only: {{"summary": "...", "best": "...", "simple": "...", "tricky": "..."}}"""


class LLMError(RuntimeError):
    pass


_cooldown: dict[str, float] = {}


def api_key() -> str:
    if key := os.environ.get("GROQ_API_KEY"):
        return key
    env = PROJECT_ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("GROQ_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    raise LLMError("Missing GROQ_API_KEY (environment or .env)")


def _body(model: str, messages: list[dict]) -> dict:
    body = {
        "model": model,
        "messages": messages,
        "temperature": 0.4,
        "max_completion_tokens": 1500,
        "response_format": {"type": "json_object"},
    }
    if model.startswith("openai/gpt-oss"):
        body["reasoning_effort"] = "low"
    elif model.startswith("qwen/"):
        body["reasoning_effort"] = "none"
    return body


def invented_moves(texts: list[str], allowed: set[str]) -> list[str]:
    bad = []
    for text in texts:
        for match in SAN_RE.finditer(text):
            san = normalize_san(match.group(0))
            if san not in allowed:
                bad.append(san)
    return bad


def compact(facts):
    """Facts without machine-only fields (UCI, FEN, win%), to save tokens."""
    if isinstance(facts, dict):
        out = {}
        for k, v in facts.items():
            if k in ("fen", "uci", "win", "cp", "candidates") or k.endswith("_uci"):
                continue
            if isinstance(v, dict) and set(v) == {"san", "uci"}:
                out[k] = v["san"]
            else:
                out[k] = compact(v)
        return out
    if isinstance(facts, list):
        return [compact(v) for v in facts]
    return facts


def _ask(key: str, model: str, messages: list[dict], allowed: set[str]) -> tuple[dict | None, str | None, float]:
    """(answer, error, retry_after) for one model."""
    try:
        resp = requests.post(URL, headers={"Authorization": f"Bearer {key}"}, json=_body(model, messages), timeout=TIMEOUT)
    except requests.RequestException as exc:
        return None, f"{model}: {type(exc).__name__}", 0.0
    if resp.status_code == 401:
        raise LLMError("Invalid Groq key (401)")
    if resp.status_code == 429:
        try:
            wait = float(resp.headers.get("retry-after") or 20)
        except ValueError:
            wait = 20.0
        return None, f"{model}: rate limited ({wait:.0f}s)", wait
    if resp.status_code != 200:
        return None, f"{model}: HTTP {resp.status_code}", 0.0
    text = resp.json()["choices"][0]["message"].get("content") or ""
    try:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        data = json.loads(match.group(0)) if match else None
    except json.JSONDecodeError:
        data = None
    if not isinstance(data, dict) or not all(isinstance(data.get(k), str) for k in ("best", "simple", "tricky")):
        return None, f"{model}: malformed JSON", 0.0
    data.setdefault("summary", "")
    bad = invented_moves([data[k] for k in ("summary", "best", "simple", "tricky")], allowed)
    if bad:
        return None, f"{model}: invented moves {bad}", 0.0
    return data, None, 0.0


def explain(
    facts: dict,
    drafts: dict | None = None,
    models: tuple[str, ...] = MODELS,
    max_wait: float = 75.0,
) -> tuple[dict, str]:
    """({"summary", "best", "simple", "tricky"}, model). Raises LLMError.

    Reviews run in the background, so when every model is rate limited we wait
    for the first one to free up (up to `max_wait` seconds in total) instead of
    falling back to a weaker model.
    """
    key = api_key()
    user = "FATTI:\n" + json.dumps(compact(facts), ensure_ascii=False)
    if drafts:
        user += "\n\nBOZZE:\n" + json.dumps(drafts, ensure_ascii=False)
    messages = [
        {"role": "system", "content": SYSTEM.format(elo=facts.get("user_elo", 1500))},
        {"role": "user", "content": user},
    ]
    allowed = allowed_moves(facts)
    errors: list[str] = []
    deadline = time.time() + max_wait
    while True:
        now = time.time()
        for model in models:
            if _cooldown.get(model, 0) > now:
                continue
            data, error, wait = _ask(key, model, messages, allowed)
            if data is not None:
                return data, model
            errors.append(error)
            if wait:
                _cooldown[model] = time.time() + wait
        free_at = min(_cooldown.get(m, 0) for m in models)
        if free_at <= time.time():
            break  # failures that waiting will not fix
        if free_at > deadline:
            break
        time.sleep(free_at - time.time() + 0.5)
    raise LLMError("; ".join(errors[-4:]))


def narrate(a: PositionAnalysis, facts: dict) -> dict:
    """LLM explanation, or the templates when Groq is unavailable or unreliable.

    The drafts are kept with the result so explanations can be regenerated later
    without searching the position again.
    """
    drafts = {adv.role: " ".join(adv.text) for adv in advise(a)}
    try:
        data, model = explain(facts, drafts)
        return {**data, "source": model, "drafts": drafts}
    except LLMError as exc:
        return {"summary": "", **drafts, "source": "template", "error": str(exc), "drafts": drafts}
