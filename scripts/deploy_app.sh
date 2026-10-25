#!/usr/bin/env bash
# Deploy the live web app on AWS Lambda (infra/app), within the free tier: build the
# zip package and its layers, apply Terraform, then copy the local demo games and
# reviews to DynamoDB.
# Usage: bash scripts/deploy_app.sh [terraform apply options, e.g. -auto-approve]
# Env: AWS_PROFILE_NAME (default job-radar), AWS_REGION (default eu-west-1),
#      TF_VAR_username (default tommasobersani), TF_VAR_app_password (default: a
#      generated one, see `terraform -chdir=infra/app output -raw password`),
#      GROQ_API_KEY (default: read from .env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export AWS_PROFILE="${AWS_PROFILE_NAME:-job-radar}"
export AWS_REGION="${AWS_REGION:-eu-west-1}" AWS_DEFAULT_REGION="${AWS_REGION:-eu-west-1}"
TF="terraform -chdir=infra/app"

if [ -z "${GROQ_API_KEY:-}" ] && [ -f .env ]; then
  GROQ_API_KEY="$(sed -n 's/^GROQ_API_KEY=//p' .env | tr -d '\r"' | tail -n 1)"
fi
export TF_VAR_groq_api_key="${GROQ_API_KEY:-}"

# 1. The package. Exporting the Maia-3 weights needs torch, so it runs once in the
#    project environment; the build itself needs only uv and Python 3.12.
if ! ls models/maia3-23m/part-*.npz >/dev/null 2>&1; then
  uv run --no-sync python scripts/export_maia.py
fi
uv run --no-project --python 3.12 python scripts/build_lambda.py

# 2. The infrastructure; Terraform uploads a zip only when its hash changes.
$TF init -input=false >/dev/null
$TF apply -input=false "$@"

# 3. Local data that the table lacks.
PYTHONPATH=src uv run --no-project --python 3.12 --with boto3 python -m smartchess.web.seed "$($TF output -raw table)" data

echo
echo "HumanChess: $($TF output -raw url)"
echo "Password: terraform -chdir=infra/app output -raw password"
