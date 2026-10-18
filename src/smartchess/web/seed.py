"""Copy local games and reviews to the DynamoDB table of the Lambda app.

Usage: python -m smartchess.web.seed TABLE [DATA_DIR]   (needs boto3)

Demo games are always copied, since they are edited locally. Reviews, with their
games, only when the table lacks them, so a review redone on AWS is never overwritten.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .store import DynamoStore, LocalStore, Store


def seed(local: Store, remote: Store) -> list[str]:
    copied = []
    for key in local.keys("games/demo"):
        remote.write(key, local.read(key))
        copied.append(key)
    present = set(remote.keys("reviews/"))
    for key in local.keys("reviews/"):
        if key in present:
            continue
        remote.write(key, local.read(key))
        copied.append(key)
        game = local.read("games/" + key.removeprefix("reviews/"))
        if game is not None:
            remote.write("games/" + key.removeprefix("reviews/"), game)
    return copied


if __name__ == "__main__":
    data = Path(sys.argv[2] if len(sys.argv) > 2 else "data")
    for key in seed(LocalStore(data), DynamoStore(sys.argv[1])):
        print(f"  copied {key}")
