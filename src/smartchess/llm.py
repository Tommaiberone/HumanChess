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
# left out: its Italian explanations were often nonsensical.
MODELS = ("qwen/qwen3.8-27b", "openai/gpt-oss-120b")
TIMEOUT = 30
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Piece moves, captures and castling. Plain pawn pushes ("e5") are skipped
# because they look exactly like square names ("il pedone in e5").
SAN_RE = re.compile(r"(?:\d+\.(?:\.\.)?\s?)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?")

SYSTEM = """Sei un istruttore di scacchi cordiale e concreto. Spieghi le mosse a un giocatore \
di circa {elo} di Elo (scala Lichess), in italiano, con tono caldo ma senza fronzoli.

Ricevi i FATTI di una posizione, calcolati da Stockfish (motore) e da Maia (modello delle mosse umane):
- "best": la mossa migliore secondo Stockfish;
- "simple": la mossa, entro un piccolo margine dalla migliore (circa 0,6 pedoni), più facile da gestire al livello del giocatore \
("at_your_level" = valutazione attesa se il giocatore continua a giocare al suo livello);
- "tricky": la mossa, entro un margine più largo (fino a circa 1 pedone), che rende di più contro un avversario umano reale \
("traps" = risposte sbagliate probabili, con la probabilità "prob", la punizione e la probabilità di trovarla);
- "critical_moment": il punto dove al giocatore servirà una mossa difficile ("find_prob" = probabilità di trovarla);
- "motifs": fatti osservabili sulla mossa (catture, scacchi, attacchi).

Il giocatore ha i pezzi "side", l'avversario i pezzi "opponent_side": non confonderli mai. I "motifs" descrivono cosa fa ciascuna mossa del giocatore.
Ricevi anche le BOZZE: frasi già corrette, generate dai fatti. Riscrivile in modo più caldo e naturale \
e aggiungi il perché usando i motifs. Non contraddirle mai.

Regole:
- Usa SOLO mosse, numeri e varianti presenti nei fatti. Non calcolare e non inventare varianti né minacce.
- Non citare "loss_win_pct", "win" né altri numeri tecnici oltre a valutazioni e probabilità.
- Se nei fatti non c'è "played", non parlare di una mossa giocata.
- Scrivi le mosse esattamente come nei fatti (notazione inglese, es. 14...Nf6).
- Le probabilità scrivile in percentuale (0.16 -> 16%; sotto 0.01 scrivi "quasi mai").
- Ogni campo è un paragrafo di 2-3 frasi complete (almeno 20 parole), rivolto al giocatore con il "tu".

Tipo di momento ("moment"):
- "errore": il giocatore qui ha perso molto. Nel "summary" spiega cosa non andava nella mossa giocata, usando \
"played.line" (cosa succede dopo) e i suoi "motifs".
- "scelta pratica": la mossa giocata era ragionevole; il punto è confrontare le opzioni pratiche. Se \
"played.roles" non è vuoto, il giocatore ha scelto proprio quella mossa: diglielo con un complimento.
- Se "same.only_one_candidate" è vero, c'era una sola buona mossa: scrivi "simple" e "tricky" come stringhe vuote.

Cosa scrivere in ogni campo:
- "summary": una frase sul carattere della posizione; se c'è "played", di' se la mossa giocata era buona \
o cosa le mancava rispetto alle alternative.
- "best": perché la mossa è forte, usando i suoi "motifs" e la prima parte di "line". Se ha un \
"critical_moment", avvisa: dopo quali mosse ("after") serve quale mossa ("needed") e con che probabilità la si trova.
- "simple": se è diversa da "best", spiega perché è più facile da gestire: confronta "at_your_level" delle due \
e cita il "critical_moment" di best che così eviti. Se coincide con best, spiega che qui la migliore è anche \
la scelta più comoda, oppure che le alternative sono ancora più difficili.
- "tricky": se ha "traps", racconta la trappola principale: quale risposta naturale ma sbagliata ("reply", con \
"prob") e come la punisci ("punishment", con "find_prob"). Ricorda che il rischio è limitato: contro la risposta \
migliore la valutazione resta "eval". Se non ci sono trappole, di' che contro un umano rende comunque "vs_human".

Rispondi solo con un oggetto JSON: {{"summary": "...", "best": "...", "simple": "...", "tricky": "..."}}"""


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
