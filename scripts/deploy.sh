#!/usr/bin/env bash
# Publish the read-only showcase: export the reviewed games, upload them with
# Terraform (S3 + CloudFront), then invalidate the CloudFront cache.
# Usage: bash scripts/deploy.sh [terraform apply options, e.g. -auto-approve]
# Env: SMARTCHESS_USER (default tommasobersani), AWS_PROFILE_NAME (default job-radar),
#      TF_VAR_password to protect the site with basic auth (user "smartchess").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USER_NAME="${SMARTCHESS_USER:-tommasobersani}"
PROFILE="${AWS_PROFILE_NAME:-job-radar}"

uv run smartchess export --user "$USER_NAME" --out site
terraform -chdir=infra init -input=false >/dev/null
terraform -chdir=infra apply -input=false "$@"

DIST="$(terraform -chdir=infra output -raw distribution_id)"
aws cloudfront create-invalidation --profile "$PROFILE" --distribution-id "$DIST" --paths "/*" >/dev/null
echo
echo "SmartChess: $(terraform -chdir=infra output -raw url)"
