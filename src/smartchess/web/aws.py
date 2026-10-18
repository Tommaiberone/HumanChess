"""AWS Lambda entry points: the HTTP API (behind a function URL) and the analysis worker.

Both functions run the same zip package (infra/app). The API keeps games, reviews
and jobs in DynamoDB and hands each job to the worker with an asynchronous invoke;
the worker runs it and writes its progress back to the table, where /api/jobs reads
it. The worker evaluates Maia-3 with numpy (weights in two Lambda layers) and fetches
Stockfish from its GitHub release on a cold start: neither torch nor Stockfish fits
in the 250 MB a zip package may hold next to the weights.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
from pathlib import Path

import boto3
import requests
from mangum import Mangum

from .app import create_app
from .service import Service
from .store import DynamoStore

STOCKFISH_URL = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz"
STOCKFISH_SHA256 = "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f"
STOCKFISH_PATH = Path("/tmp/stockfish/stockfish")


def _launch(payload: dict) -> None:
    boto3.client("lambda").invoke(
        FunctionName=os.environ["SMARTCHESS_WORKER"], InvocationType="Event", Payload=json.dumps(payload).encode()
    )


def _maia():
    from ..maia_np import MaiaNumpy

    return MaiaNumpy.from_dir(os.environ.get("SMARTCHESS_MAIA_WEIGHTS", "/opt/maia"))


def _stockfish() -> str:
    """The Stockfish binary in /tmp, which lasts as long as the warm instance."""
    if not STOCKFISH_PATH.exists():
        data = requests.get(STOCKFISH_URL, timeout=60).content
        if hashlib.sha256(data).hexdigest() != STOCKFISH_SHA256:
            raise RuntimeError("Stockfish download does not match its checksum")
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            member = next(m for m in tar.getmembers() if m.isfile() and Path(m.name).name.startswith("stockfish-linux"))
            binary = tar.extractfile(member).read()
        STOCKFISH_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STOCKFISH_PATH.with_suffix(".part")
        tmp.write_bytes(binary)
        tmp.chmod(0o755)
        tmp.rename(STOCKFISH_PATH)
    return str(STOCKFISH_PATH)


_store = DynamoStore(os.environ["SMARTCHESS_TABLE"], expire_days={"jobs": 7})
service = Service(
    store=_store,
    jobs=_store,
    launch=_launch,
    # Past the worker's timeout a job still marked as running was killed.
    job_timeout=int(os.environ.get("SMARTCHESS_WORKER_TIMEOUT", "900")) + 60,
    save_every=2.0,
    human_model=_maia,
    # Lambda gives CPU in proportion to memory; Stockfish and Maia share what is there.
    threads=os.cpu_count() or 2,
    workers=min(3, os.cpu_count() or 2),
)

api = Mangum(create_app(service), lifespan="off")


def worker(event: dict, context) -> None:
    os.environ.setdefault("SMARTCHESS_STOCKFISH", _stockfish())
    service.run(event["job"], event["args"])
