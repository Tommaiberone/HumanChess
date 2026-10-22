import json

import pytest

from smartchess.web import llm_lambda
from smartchess.web.llm_lambda import Rejected, handler, validate


def facts() -> dict:
    cand = {"san": "Nf3", "uci": "g1f3", "eval": "+0.30", "motifs": ["you develop your knight"], "traps": []}
    return {"side": "white", "user_elo": 1700, "best": cand, "simple": cand, "tricky": cand,
            "same": {"simple_is_best": True}, "fen": "x"}


def request(body, origin="https://site.example", method="POST") -> dict:
    return {"requestContext": {"http": {"method": method, "sourceIp": "1.2.3.4"}}, "headers": {"Origin": origin},
            "body": body if isinstance(body, str) else json.dumps(body)}


DRAFTS = {"best": "Line: 1. Nf3", "simple": "Easy.", "tricky": "Tricky."}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://site.example")
    monkeypatch.setattr(llm_lambda, "_count", lambda key, ttl: 1)
    monkeypatch.setattr(llm_lambda, "explain", lambda f, d, max_wait: ({"summary": "s", "best": "b", "simple": "x", "tricky": "t"}, "model-x"))


def test_a_good_request_gets_the_explanation():
    out = handler(request({"facts": facts(), "drafts": DRAFTS}), None)
    assert out["statusCode"] == 200
    assert json.loads(out["body"])["source"] == "model-x"


@pytest.mark.parametrize("mutate", [
    lambda b: b.pop("facts"),
    lambda b: b["facts"].pop("best"),
    lambda b: b["facts"].update(user_elo="1700"),
    lambda b: b["facts"].update(side="green"),
    lambda b: b["facts"].update(note="x" * 701),
    lambda b: b["facts"].update(many=list(range(200))),
    lambda b: b["facts"].update(nested={"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": 1}}}}}}}}),
    lambda b: b["facts"].update(weird=object.__class__.__name__ and {"k" * 41: 1}),
    lambda b: b["drafts"].update(best="x" * 1501),
    lambda b: b["drafts"].update(extra="hello"),
])
def test_malformed_facts_are_rejected(mutate):
    body = {"facts": facts(), "drafts": dict(DRAFTS)}
    mutate(body)
    assert handler(request(body), None)["statusCode"] == 400


def test_origin_method_size_and_json_are_checked():
    ok = {"facts": facts(), "drafts": DRAFTS}
    assert handler(request(ok, origin="https://evil.example"), None)["statusCode"] == 403
    assert handler(request(ok, method="GET"), None)["statusCode"] == 405
    assert handler(request("x" * 50_000), None)["statusCode"] == 413
    assert handler(request("{not json"), None)["statusCode"] == 400
    assert handler(request("[1]"), None)["statusCode"] == 400


def test_limits_answer_429(monkeypatch):
    monkeypatch.setenv("LLM_PER_IP_HOUR", "2")
    monkeypatch.setattr(llm_lambda, "_count", lambda key, ttl: 3)
    out = handler(request({"facts": facts(), "drafts": DRAFTS}), None)
    assert out["statusCode"] == 429


def test_the_llm_failing_is_a_502(monkeypatch):
    def boom(f, d, max_wait):
        raise llm_lambda.LLMError("rate limited")

    monkeypatch.setattr(llm_lambda, "explain", boom)
    assert handler(request({"facts": facts(), "drafts": DRAFTS}), None)["statusCode"] == 502


def test_validate_returns_the_parts():
    f, d = validate({"facts": facts(), "drafts": DRAFTS})
    assert f["side"] == "white" and d == DRAFTS
    with pytest.raises(Rejected):
        validate({"facts": [], "drafts": {}})
