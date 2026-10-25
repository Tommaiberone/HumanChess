# HumanChess

*Formerly SmartChess: the Python package, the `smartchess` command and the AWS resources keep that name.*

Human-aware chess game review. For each critical position of your game it shows three moves:

- **Best**: what Stockfish plays.
- **Simplest**: within 0.6 pawns of the best (measured in win%, so the margin grows when you are winning), the move whose advantage *you* can keep up while playing at your own level.
- **Trickiest**: within 1 pawn, the move that scores best against a real opponent of their level ("hope chess" with bounded risk).

Key moments are of two kinds, each with its own budget:
- **mistakes** (up to 5): your moves that lost at least 6 win% points;
- **practical choices** (up to 5): open positions (win% between 15 and 85) with several near-equal moves where the best one is unnatural at your level. One is kept only if the simple or tricky move gains at least 3 win% points over the best, at your level or against a human.

The margins were chosen by measuring the user's games. Proposals that differ from the best move are frequent even at 0.4. What a wider margin adds is a real practical gain, and only for the tricky move (2 → 4 useful ones out of 16 positions at 1 pawn).

Stockfish is the objective oracle. [Maia-3](https://github.com/CSSLab/maia3) predicts the moves humans play at a given rating. An expectimax search combines the two, and each move comes with an explanation built from these facts.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12, plus Node 22 for the web part (`pnpm install`).

```sh
uv sync --python 3.12
```

Put a Stockfish binary under `engines/stockfish/`, or set `SMARTCHESS_STOCKFISH`. The Maia-3 weights are downloaded from Hugging Face on first use.

## Usage

```sh
# Web app with the Python backend (Chess.com-like review, local): http://127.0.0.1:8765
uv run smartchess web --user <chess.com username>

# The public site, analysis in the browser: build it once, then serve the folder
pnpm install && pnpm run build
uv run --no-sync --with onnx --with onnxruntime python scripts/export_onnx.py maia3-5m models   # once
uv run smartchess export --out site && python -m http.server -d site 8000

# One position (you are the side to move); --moves keeps the history Maia uses
uv run smartchess position --moves "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5"

# Your latest Chess.com rapid games
uv run smartchess review --chesscom <username> --games 3

# A PGN file
uv run smartchess review --pgn game.pgn --user <name>
```

`review` writes an HTML report to `reports/`. Add `--llm` to `position` or `review` for Groq-written explanations. Ratings are converted to the Maia scale (Lichess blitz): Chess.com 1400 is about 1700. Override the conversion with `--elo` / `--opp-elo`.

## How the three moves are scored

All values are win% from your point of view, using the Lichess conversion from centipawns.

| Mode | Opponent | You | Meaning |
|---|---|---|---|
| objective | engine | engine | Stockfish eval |
| simple | engine | Maia at your rating | can you hold it, even against perfect replies? |
| tricky | Maia at their rating | Maia at your rating | expected result against a real opponent, with you finding the follow-up |

In both Maia modes, human nodes are weighted by Maia's probabilities, and the leaves are Stockfish evals. Opponent probability mass that the model leaves unexplored is assigned to the opponent's best reply, so the search never counts on mistakes it cannot see.

## The public site: analysis in the visitor's browser

Anyone can use HumanChess without a server doing the work. `smartchess export --out site` writes a static folder (HTML, JS, WebAssembly and the Maia-3 model) that any static host can serve; the visitor's own device runs the analysis:

- games come straight from the **Chess.com** and **Lichess** public APIs (both allow requests from any page), or from a pasted **PGN**;
- **Stockfish 19 lite** (WebAssembly, single thread, `stockfish` on npm) and **Maia-3 5M** (ONNX on ONNX Runtime Web, `scripts/export_onnx.py`) run in a pool of Web Workers, 4 on a desktop and 2 on a phone. The search is the same expectimax as the Python one (`src/smartchess/web/analysis/`, a port of `practical.py`, `review.py`, `facts.py`, `motifs.py` and `explain.py` on top of [chessops](https://github.com/lichess-org/chessops));
- reviews are kept in the browser (IndexedDB), nothing is uploaded, and there are no accounts or cookies. If the site is exported with `--stats-url`, it also reports anonymous counters (below);
- explanations are the template ones by default; "rewrite with AI" under a review sends the facts of each key moment (no names) to an explanation proxy that holds the Groq key (below). The demo games keep their hand-written ones.

**Anonymous counters, no banner.** The page sends names from a closed list ("view", "review_done", "ai_busy", a device class, a language, a coarse origin such as "reddit", time buckets), never text: no usernames, games, positions or error messages. Nothing is stored on the visitor's device and nothing is sent when the browser says Do Not Track or Global Privacy Control, or for `?from=me`. A visitor is counted once a day through a marker (hash of IP + browser + date + a secret) that expires after 48 hours; the IP is never written. `src/smartchess/web/stats_lambda.py` adds the counters to DynamoDB (free tier) and `uv run --no-project --with boto3 python scripts/stats.py` prints them: visitors per day, the funnel (loaded games, started and finished reviews, AI), origins, devices, ratings, review times, failures. A link can carry `?from=chess` to count visits per post (the names are in `infra/app` `stats_campaigns`). This is the same model as Plausible or Fathom, not legal advice: the About page of the site says it in plain words.

Measured on this laptop, a 92-ply game takes about 1 minute with 4 workers (Node, same code), against 3.5 minutes on the Lambda below. The first visit downloads about 37 MB (model 21 MB, ONNX Runtime 14 MB, Stockfish 2 MB), then it is cached.

Searches stop at a node count, never at a time limit, and every task starts from a clean engine: **the same game always gives the same review**, on any device. (The Python reviews depend on timing and on the order engines pick up positions: two runs of the same game agree on only about 60% of their key moments.)

`web-tests/` checks the port against the Python code: `scripts/make_web_fixtures.py` records what Python says for 97 positions (every legal move with its SAN, motifs and threats, Maia probabilities) and `pnpm test` requires the same from JavaScript. `node web-tests/e2e.mjs` drives the exported site in Chromium, and `pnpm run fit` opens every view of the review in the room phone browsers really leave (with their bars) and reports the board's width, the smallest text and whether the explanation starts in sight; it fails if the page scrolls or a text is under 12px.

On a phone the review is a single screen laid out like the chess apps: the board as wide as the screen (a thin eval strip above it), the coach panel below with cards for "your move", best, simplest and trickiest and only the chosen one explained, and the controls at the bottom, under the thumb. The text stays readable (16px explanations): when it is longer than the room left, the panel scrolls and the board stays put. In landscape the board takes the full height on the left. Added to the home screen (a web app manifest, `scripts/make_icons.mjs` draws the icons) the site opens without the browser's bars, which leaves the panel twice the room.

**Explanation proxy** (`src/smartchess/web/llm_lambda.py`, `infra/app/`, free tier): a Lambda with a function URL whose CORS allows only the site. It accepts just the shape the analysis produces, with bounded sizes (it cannot be used as a free chat), limits each visitor (hashed IP, 40 requests per hour) and the whole site (1,500 per day) with DynamoDB counters, and keeps the key in its environment. `smartchess.llm` rejects any answer that mentions a move not in the facts, and past a limit or an error the site keeps its template text. Apply it with `bash scripts/deploy_app.sh -auto-approve`; `scripts/deploy.sh` then reads its URL (`terraform -chdir=infra/app output -raw llm_url`) and adds it to the site's CSP.

Deploy with `bash scripts/deploy.sh -auto-approve` (private S3 bucket behind CloudFront, `infra/`). Set `TF_VAR_password` to keep the site behind basic auth until it is public. The footer links to the source code, as the AGPL requires for a service built on Maia-3.

## Private server mode: AWS Lambda

Before the browser version, the app ran on AWS Lambda (`infra/app/`, `scripts/deploy_app.sh`). It still works, as a private instance with a sign-in page, and it is the only way to get the Groq explanations. It is not meant for the public: every review costs server time, so it needs quotas to be exposed. It uses only always-free services: Lambda (zip packages and a function URL), DynamoDB with provisioned capacity and CloudWatch Logs. Two functions share one zip package:

- `smartchess-api` (1 GB) serves the frontend and the API behind a function URL, with a password on a sign-in page and a session cookie. A cold start takes about 2 s.
- `smartchess-worker` (3008 MB, about 2 vCPU, 15 min timeout) runs Stockfish and Maia-3. The API hands it every analysis with an asynchronous invoke; the worker writes its progress to DynamoDB and the frontend polls `/api/jobs/{id}`.

A zip package holds at most 250 MB, so on Lambda Maia-3 runs on numpy (`smartchess.maia_np`, checked against torch in `tests/test_maia_np.py`) and Stockfish is downloaded from its GitHub release on a cold start. A 92-ply game takes about 3.5 minutes. Games, reviews and jobs are JSON documents (`smartchess.web.store`): files under `data/` locally, zlib-compressed DynamoDB items on Lambda. `bash scripts/deploy_app.sh -auto-approve` exports the Maia weights, builds the zips (`scripts/build_lambda.py`, which leaves the browser analysis out), applies Terraform and copies the demo games to DynamoDB. The password is generated unless `TF_VAR_app_password` is set (`terraform -chdir=infra/app output -raw password`).

## Explanations

Explanations are built from facts: candidate lines, traps, critical moments, and simple motifs such as captures, checks and attacks on undefended pieces. In the Python app, when `GROQ_API_KEY` is set (in the environment or in `.env`), an LLM on Groq rewrites these facts as friendly prose. It uses `qwen3.8-27b` and falls back to `gpt-oss-120b`; when both are rate limited it waits instead of switching to a weaker model. Any piece move the LLM mentions that is not in the facts makes the answer rejected, and the template text is used instead.

## License

AGPL-3.0-or-later. Maia-3 is AGPL-3.0 and Stockfish is GPL-3.0.
