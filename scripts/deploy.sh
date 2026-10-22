#!/usr/bin/env bash
# Publish the public site: build the browser analysis, export the static site, upload it
# with Terraform (S3 + CloudFront), then invalidate the CloudFront cache.
# The site has no backend: visitors' browsers run Stockfish and Maia themselves.
# Usage: bash scripts/deploy.sh [terraform apply options, e.g. -auto-approve]
# Env: AWS_PROFILE_NAME (default job-radar), TF_VAR_password to put basic auth in front
#      of the site while it is private (user "smartchess").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE="${AWS_PROFILE_NAME:-job-radar}"

# The Maia-3 ONNX model is not in git: export it once.
if [ ! -f models/maia3-5m.onnx ]; then
  uv run --no-sync --with onnx --with onnxruntime python scripts/export_onnx.py maia3-5m models
fi
npm ci
npm run build
# The explanation proxy (infra/app) is optional: without it the site keeps the template explanations.
LLM_URL="${SMARTCHESS_LLM_URL:-$(terraform -chdir=infra/app output -raw llm_url 2>/dev/null || true)}"
uv run smartchess export --out site --llm-url "$LLM_URL"
terraform -chdir=infra init -input=false >/dev/null
terraform -chdir=infra apply -input=false "$@"

DIST="$(terraform -chdir=infra output -raw distribution_id)"
aws cloudfront create-invalidation --profile "$PROFILE" --distribution-id "$DIST" --paths "/*" >/dev/null
echo
echo "SmartChess: $(terraform -chdir=infra output -raw url)"
