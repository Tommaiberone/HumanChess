# SmartChess

## Package manager: pnpm, never npm

Always use `pnpm` for the JavaScript side (`pnpm install`, `pnpm run build`, `pnpm test`), never `npm` or `npx`. The lockfile is `pnpm-lock.yaml`; build scripts are allowed in `pnpm-workspace.yaml` (`allowBuilds`).

## After every change: commit and deploy

When a change is done and its checks pass, always commit it and deploy it, without asking first.

- **Commit** on `main` (as the history does), only the files of the change; do not push unless asked.
- **Deploy the public site** (S3 + CloudFront, analysis in the visitor's browser): `bash scripts/deploy.sh -auto-approve`
- **Deploy the explanation proxy** too when `src/smartchess/web/llm_lambda.py` or `infra/app/` changed: `bash scripts/deploy_app.sh -auto-approve`, then `scripts/deploy.sh` again so the site gets its URL.

## Checks before committing

- `pnpm test` (the JavaScript port against the Python fixtures) and `uv run --no-sync pytest -q`
- After a frontend change: `pnpm run build && uv run --no-sync smartchess export --out site`, then `node web-tests/e2e.mjs`, and `pnpm run fit` for anything that shows on a phone.
