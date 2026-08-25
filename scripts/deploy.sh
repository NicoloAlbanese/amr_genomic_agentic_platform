#!/usr/bin/env bash
#
# Deploy the AMR Genomic Surveillance Platform.
#
# This wraps the AWS CDK's own dependency-ordered orchestration. CDK already
# knows the stack graph (see infra/bin/app.ts), so `cdk deploy --all` deploys
# every stack in the correct order and skips unchanged stacks. This script only
# adds the prerequisites CDK does not do for you: validating inputs, bootstrapping
# both required regions, and building the React frontend before the FrontendStack
# packages it.
#
# Usage:
#   scripts/deploy.sh                 # deploy all stacks (dependency order)
#   scripts/deploy.sh <stack-suffix>  # deploy a single stack, e.g. "api" or "pipeline"
#   scripts/deploy.sh --list          # list the stack suffixes
#
# Required environment variables:
#   RESOURCE_PREFIX   Resource name prefix, e.g. "amr-demo" (lowercase, digits, hyphens)
#   AWS credentials   Standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
#
# Optional environment variables:
#   AWS_REGION        Primary region (default: us-west-2)
#   RUN_ID            Deployment tag value (default: derived from timestamp)
#   SKIP_FRONTEND_BUILD=1   Skip the frontend build (use an existing frontend/dist)
#   SKIP_BOOTSTRAP=1        Skip cdk bootstrap (use when already bootstrapped)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"
FRONTEND_DIR="${REPO_ROOT}/frontend"

STACK_SUFFIXES=(foundation storage containers genomics pipeline api waf frontend)

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--list" ]]; then
  printf 'Available stack suffixes:\n'
  printf '  %s\n' "${STACK_SUFFIXES[@]}"
  exit 0
fi

# ---- Validate inputs -------------------------------------------------------
: "${RESOURCE_PREFIX:?RESOURCE_PREFIX is required, e.g. export RESOURCE_PREFIX=amr-demo}"
AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
RUN_ID="${RUN_ID:-deploy-$(date +%Y%m%d-%H%M%S)}"
export RESOURCE_PREFIX RUN_ID

command -v aws >/dev/null 2>&1 || die "aws CLI not found on PATH"
command -v npx >/dev/null 2>&1 || die "npx (Node.js) not found on PATH"

log "Resolving AWS account"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || die "Unable to resolve AWS account. Are your credentials valid?"
export CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}"
echo "Account: ${ACCOUNT_ID}   Region: ${AWS_REGION}   Prefix: ${RESOURCE_PREFIX}"

# ---- Resolve target stacks -------------------------------------------------
TARGET_SUFFIX="${1:-}"
if [[ -n "${TARGET_SUFFIX}" ]]; then
  # shellcheck disable=SC2076
  [[ " ${STACK_SUFFIXES[*]} " =~ " ${TARGET_SUFFIX} " ]] \
    || die "Unknown stack '${TARGET_SUFFIX}'. Run with --list to see valid suffixes."
  CDK_TARGET="${RESOURCE_PREFIX}-amr-${TARGET_SUFFIX}"
else
  CDK_TARGET="--all"
fi

# ---- Install infra deps if needed ------------------------------------------
if [[ ! -d "${INFRA_DIR}/node_modules" ]]; then
  log "Installing infra dependencies"
  (cd "${INFRA_DIR}" && npm ci)
fi
if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  log "Installing root dependencies (esbuild for Lambda bundling)"
  (cd "${REPO_ROOT}" && npm ci)
fi

# ---- Build the frontend ----------------------------------------------------
# The FrontendStack packages frontend/dist. The SPA is account-agnostic and
# reads /runtime-config.json at runtime, so this build does not need any
# account-specific values.
if [[ "${SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  log "Building frontend"
  (cd "${FRONTEND_DIR}" && { [[ -d node_modules ]] || npm ci; } && npm run build)
else
  warn "SKIP_FRONTEND_BUILD=1 set; using existing frontend/dist"
fi

# ---- Bootstrap both regions ------------------------------------------------
# The WAF stack must live in us-east-1 (CloudFront scope); everything else is in
# the primary region. Both environments must be bootstrapped once per account.
if [[ "${SKIP_BOOTSTRAP:-0}" != "1" ]]; then
  log "Bootstrapping CDK (primary region ${AWS_REGION} and us-east-1)"
  (cd "${INFRA_DIR}" \
    && npx cdk bootstrap "aws://${ACCOUNT_ID}/${AWS_REGION}" \
    && npx cdk bootstrap "aws://${ACCOUNT_ID}/us-east-1")
else
  warn "SKIP_BOOTSTRAP=1 set; skipping cdk bootstrap"
fi

# ---- Deploy ----------------------------------------------------------------
# For a single stack, pass --exclusively so CDK does not re-run no-op changesets
# on every dependency stack (much faster iteration). For --all, use concurrency
# so independent stacks (e.g. the us-east-1 WAF) deploy in parallel.
log "Deploying ${CDK_TARGET}"
if [[ -n "${TARGET_SUFFIX}" ]]; then
  (cd "${INFRA_DIR}" && npx cdk deploy "${CDK_TARGET}" --exclusively --require-approval never)
else
  (cd "${INFRA_DIR}" && npx cdk deploy --all --require-approval never --concurrency 4)
fi

# ---- Upload the Glue ETL script -------------------------------------------
# The Glue job reads its PySpark script from s3://<data-lake>/glue-scripts/. A
# CDK BucketDeployment cannot write to the data-lake bucket (its Lambda has no
# grant on the data-lake CMK), so the script is synced here after deploy. The
# Glue job only reads this at pipeline execution time, so post-deploy timing is
# correct. This keeps the deploy a single command (no manual step).
if [[ "${CDK_TARGET}" == "--all" || "${CDK_TARGET}" == *-pipeline || "${CDK_TARGET}" == *-storage ]]; then
  log "Uploading Glue ETL script to the data lake bucket"
  DATA_LAKE_BUCKET="${RESOURCE_PREFIX}-amr-data-lake"
  aws s3 cp "${REPO_ROOT}/src/glue-scripts/amr_etl.py" \
    "s3://${DATA_LAKE_BUCKET}/glue-scripts/amr_etl.py" --region "${AWS_REGION}"

  # The Glue ETL writes to S3 Tables via the Amazon S3 Tables Catalog for Apache
  # Iceberg client JAR (referenced by the job's --extra-jars). Fetch it from Maven
  # Central once and stage it in the data lake bucket (Glue --extra-jars needs an
  # S3 path). Keeps the deploy a single command with no manual steps.
  JAR_KEY="glue-jars/s3-tables-catalog-runtime.jar"
  if ! aws s3 ls "s3://${DATA_LAKE_BUCKET}/${JAR_KEY}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    log "Staging the S3 Tables Iceberg catalog client JAR"
    JAR_VER="$(curl -fsSL https://repo1.maven.org/maven2/software/amazon/s3tables/s3-tables-catalog-for-iceberg-runtime/maven-metadata.xml | grep -oP '(?<=<latest>)[^<]+')"
    JAR_URL="https://repo1.maven.org/maven2/software/amazon/s3tables/s3-tables-catalog-for-iceberg-runtime/${JAR_VER}/s3-tables-catalog-for-iceberg-runtime-${JAR_VER}.jar"
    TMP_JAR="$(mktemp).jar"
    curl -fsSL "${JAR_URL}" -o "${TMP_JAR}"
    aws s3 cp "${TMP_JAR}" "s3://${DATA_LAKE_BUCKET}/${JAR_KEY}" --region "${AWS_REGION}"
    rm -f "${TMP_JAR}"
  else
    log "S3 Tables catalog JAR already staged; skipping download"
  fi
fi

log "Deployment complete"
if [[ "${CDK_TARGET}" == "--all" ]]; then
  cat <<EOF

Retrieve the live endpoints:

  aws cloudformation describe-stacks --region ${AWS_REGION} \\
    --stack-name ${RESOURCE_PREFIX}-amr-frontend \\
    --query "Stacks[0].Outputs" --output table

Retrieve the demo admin password:

  aws secretsmanager get-secret-value --region ${AWS_REGION} \\
    --secret-id ${RESOURCE_PREFIX}/amr/cognito/admin-password \\
    --query SecretString --output text
EOF
fi
