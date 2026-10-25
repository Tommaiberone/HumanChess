import json

import pytest

from smartchess.web import stats_lambda
from smartchess.web.stats_lambda import allowed_keys, handler, labels, unique_kind


class Conditional(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class FakeDb:
    def __init__(self):
        self.seen, self.updates = set(), []

    def put_item(self, TableName, Item, ConditionExpression):
        key = (Item["pk"]["S"], Item["sk"]["S"])
        if key in self.seen:
            raise Conditional()
        self.seen.add(key)

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        self.updates.append((Key["sk"]["S"], {ExpressionAttributeNames[f"#c{i}"]: int(ExpressionAttributeValues[f":n{i}"]["N"])
                                              for i in range(len(ExpressionAttributeNames))}))


def request(names, origin="https://site.example", method="POST", ip="1.2.3.4", agent="Firefox") -> dict:
    return {"requestContext": {"http": {"method": method, "sourceIp": ip}}, "headers": {"Origin": origin, "User-Agent": agent},
            "body": names if isinstance(names, str) else json.dumps({"k": names})}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://site.example")
    monkeypatch.setenv("SMARTCHESS_TABLE", "t")
    monkeypatch.setenv("STATS_SALT", "pepper")
    monkeypatch.setenv("STATS_CAMPAIGNS", "chess,hn")
    db = FakeDb()
    monkeypatch.setattr(stats_lambda, "_db", db)
    stats_lambda._recent.clear()
    return db


def test_counters_are_added_to_the_days_totals(env):
    out = handler(request(["view", "view.ref.reddit", "view.dev.phone", "review_done", "review_done"]), None)
    assert out["statusCode"] == 204
    day, counts = env.updates[0]
    assert day.startswith("day#20")
    assert counts["view"] == 1 and counts["review_done"] == 2 and counts["view.ref.reddit"] == 1
    assert counts["u.visitors"] == 1 and counts["u.review_done"] == 1  # one visitor, however many reviews


def test_a_visitor_counts_once_a_day_but_another_visitor_counts_too(env):
    handler(request(["view"]), None)
    handler(request(["view"]), None)
    handler(request(["view"], ip="5.6.7.8"), None)
    visitors = [counts.get("u.visitors", 0) for _, counts in env.updates]
    assert visitors == [1, 0, 1]
    assert [counts["view"] for _, counts in env.updates] == [1, 1, 1]


def test_only_names_from_the_list_are_kept(env):
    handler(request(["view", "tommasobersani", "list.chesscom.ok", "view.lang.xx", "view.from.chess", "view.from.evil"]), None)
    counts = env.updates[0][1]
    assert set(counts) - {"u.visitors", "u.loaded"} == {"view", "list.chesscom.ok", "view.from.chess", "view.lang.other"}
    handler(request(["view.lang.sv"], ip="9.9.9.9"), None)
    assert env.updates[1][1] == {"view.lang.other": 1}


def test_nothing_is_written_when_no_name_is_valid(env):
    assert handler(request(["nope"]), None)["statusCode"] == 204
    assert env.updates == [] and env.seen == set()


@pytest.mark.parametrize("body,status", [("{not json", 400), ("[1]", 400), ('{"k": "view"}', 400), (json.dumps({"k": ["view"] * 31}), 400),
                                         ("x" * 4_001, 413)])
def test_malformed_requests_are_rejected(body, status):
    assert handler(request(body), None)["statusCode"] == status


def test_origin_and_method_are_checked():
    assert handler(request(["view"], origin="https://evil.example"), None)["statusCode"] == 403
    assert handler(request(["view"], method="GET"), None)["statusCode"] == 405


def test_a_flood_from_one_visitor_is_cut(monkeypatch):
    monkeypatch.setenv("STATS_PER_HOUR", "3")
    codes = [handler(request(["view"]), None)["statusCode"] for _ in range(5)]
    assert codes == [204, 204, 204, 429, 429]


def test_a_database_failure_never_breaks_the_page(monkeypatch):
    class Broken:
        def put_item(self, **kw):
            raise RuntimeError("down")

    monkeypatch.setattr(stats_lambda, "_db", Broken())
    assert handler(request(["view"]), None)["statusCode"] == 204


def test_the_buckets_match_the_ones_the_page_sends():
    assert labels(stats_lambda.ELO_EDGES) == ["u1000", "1000", "1400", "1800", "2200"]
    assert {"review_start.elo.1400", "review_done.secs.u30", "leave.dur.900", "review_done.plies.120"} <= allowed_keys(())
    assert unique_kind("view") == "visitors" and unique_kind("pgn.ok") == "loaded" and unique_kind("list.lichess.fail") is None


def test_every_counter_the_page_can_send_is_on_the_servers_list():
    """A name the page sends but the server does not know would be dropped without a trace."""
    import re
    from pathlib import Path

    static = Path(stats_lambda.__file__).parent / "static"
    names = []
    for js in ("app.js", "stats.js"):
        names += re.findall(r"track\((?:'([^']+)'|`([^`]+)`)\)", (static / js).read_text(encoding="utf-8"))
    patterns = [a or b for a, b in names]
    assert len(patterns) > 20
    allowed = allowed_keys(("chess",))
    for pattern in patterns:
        # a ${...} part stands for any one segment of the name
        rx = re.compile("^" + "[^.]+".join(re.escape(part) for part in re.split(r"\$\{[^}]*\}", pattern)) + "$")
        assert any(rx.match(k) for k in allowed), f"the page sends {pattern!r}, which the server does not accept"
