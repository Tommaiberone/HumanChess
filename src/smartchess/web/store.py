"""Where the web app keeps its JSON documents: games, reviews and, on AWS, jobs.

Keys look like "reviews/<game id>.json". Locally they are files under data/ (and jobs
live in memory); on AWS they are items of a DynamoDB table.
"""

from __future__ import annotations

import copy
import json
import time
import zlib
from pathlib import Path
from typing import Protocol


class Store(Protocol):
    def read(self, key: str) -> dict | None: ...

    def read_many(self, keys: list[str]) -> list[dict | None]:
        """`read` of each key, in order, in as few requests as the store allows."""
        ...

    def write(self, key: str, data: dict) -> None: ...

    def keys(self, prefix: str) -> list[str]:
        """Every key starting with `prefix` (a folder, then any start of a name), sorted."""
        ...


def dumps(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False)


class LocalStore:
    def __init__(self, root: Path):
        self.root = root

    def read(self, key: str) -> dict | None:
        path = self.root / key
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def read_many(self, keys: list[str]) -> list[dict | None]:
        return [self.read(k) for k in keys]

    def write(self, key: str, data: dict) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(dumps(data), encoding="utf-8")

    def keys(self, prefix: str) -> list[str]:
        folder, _, start = prefix.rpartition("/")
        paths = (self.root / folder).glob(start + "*")
        return sorted(p.relative_to(self.root).as_posix() for p in paths if p.is_file())


class MemoryStore:
    def __init__(self):
        self._data: dict[str, dict] = {}

    def read(self, key: str) -> dict | None:
        return copy.deepcopy(self._data.get(key))

    def read_many(self, keys: list[str]) -> list[dict | None]:
        return [self.read(k) for k in keys]

    def write(self, key: str, data: dict) -> None:
        self._data[key] = copy.deepcopy(data)

    def keys(self, prefix: str) -> list[str]:
        return sorted(k for k in self._data if k.startswith(prefix))


class DynamoStore:
    """Items keyed by folder (partition key `pk`) and file name (sort key `sk`).

    Documents are stored zlib-compressed: a review is about 100 KB of JSON but about
    15 KB stored, far from the 400 KB item limit and cheap in capacity units, which
    matters on the free tier's provisioned capacity. Folders listed in `expire_days`
    get a TTL, so DynamoDB deletes old jobs by itself.
    """

    def __init__(self, table: str, expire_days: dict[str, int] | None = None):
        import boto3
        from botocore.config import Config

        # Adaptive retries absorb the throttling of a small provisioned capacity.
        self.db = boto3.client("dynamodb", config=Config(retries={"max_attempts": 10, "mode": "adaptive"}))
        self.table = table
        self.expire_days = expire_days or {}

    @staticmethod
    def _key(key: str) -> dict:
        folder, _, name = key.partition("/")
        return {"pk": {"S": folder}, "sk": {"S": name}}

    @staticmethod
    def _load(item: dict) -> dict:
        return json.loads(zlib.decompress(item["data"]["B"]))

    def read(self, key: str) -> dict | None:
        # Strongly consistent: the worker must see the job the API has just written.
        item = self.db.get_item(TableName=self.table, Key=self._key(key), ConsistentRead=True).get("Item")
        return self._load(item) if item else None

    def read_many(self, keys: list[str]) -> list[dict | None]:
        # Eventually consistent, at half the capacity: it only feeds the game list.
        found: dict[tuple[str, str], dict] = {}
        unique = list(dict.fromkeys(keys))
        for i in range(0, len(unique), 100):  # BatchGetItem takes at most 100 keys
            pending = {self.table: {"Keys": [self._key(k) for k in unique[i:i + 100]]}}
            while pending:
                resp = self.db.batch_get_item(RequestItems=pending)
                for item in resp["Responses"].get(self.table, []):
                    found[(item["pk"]["S"], item["sk"]["S"])] = self._load(item)
                pending = resp.get("UnprocessedKeys") or {}
        return [found.get(tuple(k.partition("/")[::2])) for k in keys]

    def write(self, key: str, data: dict) -> None:
        item = {**self._key(key), "data": {"B": zlib.compress(dumps(data).encode())}}
        days = self.expire_days.get(key.partition("/")[0])
        if days:
            item["expires"] = {"N": str(int(time.time()) + days * 86400)}
        self.db.put_item(TableName=self.table, Item=item)

    def keys(self, prefix: str) -> list[str]:
        folder, _, start = prefix.partition("/")
        query = {"TableName": self.table, "KeyConditionExpression": "pk = :pk", "ProjectionExpression": "sk",
                 "ExpressionAttributeValues": {":pk": {"S": folder}}}
        if start:
            query["KeyConditionExpression"] += " AND begins_with(sk, :start)"
            query["ExpressionAttributeValues"][":start"] = {"S": start}
        names = []
        for page in self.db.get_paginator("query").paginate(**query):
            names += [item["sk"]["S"] for item in page["Items"]]
        return sorted(f"{folder}/{name}" for name in names)
