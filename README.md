# SmartChess

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

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12.

```sh
uv sync --python 3.12
```

Put a Stockfish binary under `engines/stockfish/`, or set `SMARTCHESS_STOCKFISH`. The Maia-3 weights are downloaded from Hugging Face on first use.

## Usage

```sh
# Web app (Chess.com-like review, local): http://127.0.0.1:8765
uv run smartchess web --user <chess.com username>

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

## Sharing (read-only showcase)

`smartchess export --user <name>` writes the reviewed games to `site/` as a static site. There the frontend runs in read-only mode: no backend, no live analysis, no API keys. `bash scripts/deploy.sh -auto-approve` exports the site and uploads it with Terraform (`infra/`) to a private S3 bucket behind CloudFront, using the `job-radar` AWS profile, then invalidates the cache. Set `TF_VAR_password` to protect the site with basic auth (user `smartchess`).

## Explanations

Explanations are built from facts: candidate lines, traps, critical moments, and simple motifs such as captures, checks and attacks on undefended pieces. When `GROQ_API_KEY` is set (in the environment or in `.env`), an LLM on Groq rewrites these facts as friendly Italian prose. It uses `qwen3.8-27b` and falls back to `gpt-oss-120b`; when both are rate limited it waits instead of switching to a weaker model. Any piece move the LLM mentions that is not in the facts makes the answer rejected, and the template text is used instead.

## License

AGPL-3.0-or-later. Maia-3 is AGPL-3.0 and Stockfish is GPL-3.0.
