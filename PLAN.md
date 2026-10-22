# SmartChess: plan

## Goal
A game-review analyser. For each critical position it proposes three moves, each with an explanation:
1. **Best**: Stockfish's choice.
2. **Simplest**: within 0.6 pawns of the best (measured in win%), the move with which *you*, at your level, best keep your advantage.
3. **Trickiest**: within 1 pawn, the move that scores best against a real opponent of their level. Hope chess, with a bounded risk.

Constraints: CPU only (i7-1360P), no model training, open source (AGPL), personal use.
User: 1400 rapid on Chess.com, about 1700 on the Maia scale (Lichess blitz).

## Components
- **Stockfish 19**: the objective oracle.
- **Maia-3 (23M)**: human move probabilities for a pair of ratings, using the last 8 positions. About 25 ms per position on CPU.
- **Expectimax** in three modes (see README): Maia weights the human nodes, Stockfish plays the engine nodes and evaluates the leaves.

## Phases
- [x] **0. Setup**: uv, Python 3.12, Stockfish 19, Maia-3.
- [x] **1. MVP**: single-position analysis, review of PGN and Chess.com games, template explanations, HTML report, basic tests.
- [ ] **2. Validation** (the most important phase):
  - check on real Lichess games that Maia's predicted error rates match the real ones, especially in the tail (the mistakes);
  - calibrate the user's own Elo by maximum likelihood over their moves;
  - compare results across depths and parameters.
- [x] **3. LLM explanations** (Groq): facts and template drafts go to the LLM, the moves it mentions are checked, and the templates remain as a fallback.
  - [ ] Chat ("why not Nxe5?") with the LLM querying the engines through tools.
- [x] **4. Theme recognition** (`motifs.py`): forks, pins, discovered attacks and checks, threats (mate included), rescued and defended pieces, passed pawns, open files, the opponent's threats.
- [x] **5. Local "cozy" web app** in the style of Chess.com: game list, review with eval bar, graph, accuracy, move icons, key moments with three options, variations, and analysis of any position.
  - [ ] Lichess import and openings from the Lichess Opening Explorer.
  - [ ] Optional: AWS Lambda to analyse the critical positions in parallel.
  - [x] Static showcase on S3 + CloudFront (`scripts/deploy.sh`): https://d10viis4vhdzq8.cloudfront.net/
  - [x] Stockfish (WASM) and Maia-3 (ONNX) in the browser (`src/smartchess/web/analysis/`): the public site needs no backend. Chess.com and Lichess import, pasted PGN, reviews kept in IndexedDB. The JS port is tested against Python fixtures and gives reproducible reviews.
  - [ ] Validate the Lichess import end to end (its export answered 404 for every account from the development network).
  - [ ] Explanations with an LLM on the public site: needs a small proxy that keeps the key and limits requests.
  - [ ] Share a review by link (needs a tiny store; the review JSON is about 15 KB compressed).
- [x] **6. Performance**: pool of 3 Stockfish instances in parallel (reviews about 2.3x faster: 309 s → 132 s).
  - [ ] Batched Maia inference per node.

## Findings that shape the browser version (2026-10-22)
- Maia 5M predicts real moves as well as 23M (54.3% vs 54.8% top-1 on 1,449 positions) and is 4x smaller: it is the browser default.
- Stockfish lite shifts evals by about 2 win% points on average and changes about a third of the move classes against full Stockfish; the review differences between configurations are of the size of the run-to-run noise of the Python pipeline (two runs of the same config agree on 63% of key moments).
- The Python pipeline is not reproducible (shared hash, time limits, task order). The browser one is: node-limited searches, clean engine per task.
- Also fixed: `format_cp` showed mate in 3 as `#2` (Stockfish counts moves, not plies).

## Parameters to revisit
- Margins: 0.6 pawns for the simplest move (`--margin 60`) and 1 pawn for the trickiest (`--tricky-margin 100`). Measured on 16 positions: a wider margin only helps the tricky move.
- Key moments: up to 5 mistakes (at least 6 win% points lost) and up to 5 practical choices (win% between 15 and 85, practical gain of at least 3 points).
- Depths: 18 for candidate moves, 12 inside the search, 14 in the first pass.
- A reply counts as a mistake if it gives up at least 10 win% points.
- Human nodes explore 90% of the probability mass, with at most 5 moves.
- Horizon: 4 plies for "simplest", 2 for "trickiest".

## Risks
- **Calibration of Maia's tails.** The search relies on the probabilities of wrong moves: if they are off, the advice is off.
- **Speed.** Each position takes 10-20 seconds, so a game review takes a few minutes.
- **Elo.** Maia-3 is trained on blitz while the user plays rapid, and the Elo conversion is approximate.
