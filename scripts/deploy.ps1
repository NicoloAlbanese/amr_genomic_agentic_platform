<#
.SYNOPSIS
  Deploy the AMR Genomic Surveillance Platform (PowerShell / Windows).

.DESCRIPTION
  Wraps the AWS CDK's own dependency-ordered orchestration. CDK knows the stack
  graph (see infra/bin/app.ts), so `cdk deploy --all` deploys every stack in the
  correct order and skips unchanged stacks. This script adds the prerequisites
  CDK does not do for you: validating inputs, bootstrapping both required
  regions, and building the React frontend before the FrontendStack packages it.

.PARAMETER Stack
  Optional single stack suffix to deploy (e.g. "api", "pipeline"). Omit to
  deploy all stacks in dependency order. Use -List to see valid suffixes.

.PARAMETER List
  List the available stack suffixes and exit.

.NOTES
  Required environment: RESOURCE_PREFIX and valid AWS credentials
    ($Env:AWS_ACCESS_KEY_ID / $Env:AWS_SECRET_ACCESS_KEY / $Env:AWS_SESSION_TOKEN).
  Optional environment: AWS_REGION (default us-west-2), RUN_ID,
    SKIP_FRONTEND_BUILD=1, SKIP_BOOTSTRAP=1.

.EXAMPLE
  $Env:RESOURCE_PREFIX = "amr-demo"; ./scripts/deploy.ps1

.EXAMPLE
  $Env:RESOURCE_PREFIX = "amr-demo"; ./scripts/deploy.ps1 -Stack api
#>
[CmdletBinding()]
param(
  [string]$Stack,
  [switch]$List
)

$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$InfraDir    = Join-Path $RepoRoot 'infra'
$FrontendDir = Join-Path $RepoRoot 'frontend'

$StackSuffixes = @('foundation', 'storage', 'containers', 'genomics', 'pipeline', 'api', 'waf', 'frontend')

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "WARNING: $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if ($List) {
  Write-Host 'Available stack suffixes:'
  $StackSuffixes | ForEach-Object { Write-Host "  $_" }
  exit 0
}

# ---- Validate inputs -------------------------------------------------------
if (-not $Env:RESOURCE_PREFIX) {
  Die 'RESOURCE_PREFIX is required, e.g. $Env:RESOURCE_PREFIX = "amr-demo"'
}
if (-not $Env:AWS_REGION) { $Env:AWS_REGION = 'us-west-2' }
$Env:AWS_DEFAULT_REGION = $Env:AWS_REGION
if (-not $Env:RUN_ID) { $Env:RUN_ID = "deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }

Write-Step 'Resolving AWS account'
$AccountId = (aws sts get-caller-identity --query Account --output text)
if ($LASTEXITCODE -ne 0 -or -not $AccountId) {
  Die 'Unable to resolve AWS account. Are your credentials valid?'
}
$Env:CDK_DEFAULT_ACCOUNT = $AccountId
Write-Host "Account: $AccountId   Region: $($Env:AWS_REGION)   Prefix: $($Env:RESOURCE_PREFIX)"

# ---- Resolve target stacks -------------------------------------------------
if ($Stack) {
  if ($StackSuffixes -notcontains $Stack) {
    Die "Unknown stack '$Stack'. Run with -List to see valid suffixes."
  }
  $CdkTarget = "$($Env:RESOURCE_PREFIX)-amr-$Stack"
} else {
  $CdkTarget = '--all'
}

# ---- Install deps if needed ------------------------------------------------
if (-not (Test-Path (Join-Path $InfraDir 'node_modules'))) {
  Write-Step 'Installing infra dependencies'
  Push-Location $InfraDir; npm ci; Pop-Location
}
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
  Write-Step 'Installing root dependencies (esbuild for Lambda bundling)'
  Push-Location $RepoRoot; npm ci; Pop-Location
}

# ---- Build the frontend ----------------------------------------------------
# The FrontendStack packages frontend/dist. The SPA is account-agnostic and
# reads /runtime-config.json at runtime, so this build needs no account values.
if ($Env:SKIP_FRONTEND_BUILD -ne '1') {
  Write-Step 'Building frontend'
  Push-Location $FrontendDir
  if (-not (Test-Path 'node_modules')) { npm ci }
  npm run build
  Pop-Location
} else {
  Write-Warn 'SKIP_FRONTEND_BUILD=1 set; using existing frontend/dist'
}

# ---- Bootstrap both regions ------------------------------------------------
# WAF must live in us-east-1 (CloudFront scope); everything else is in the
# primary region. Both must be bootstrapped once per account.
if ($Env:SKIP_BOOTSTRAP -ne '1') {
  Write-Step "Bootstrapping CDK (primary region $($Env:AWS_REGION) and us-east-1)"
  Push-Location $InfraDir
  npx cdk bootstrap "aws://$AccountId/$($Env:AWS_REGION)"
  npx cdk bootstrap "aws://$AccountId/us-east-1"
  Pop-Location
} else {
  Write-Warn 'SKIP_BOOTSTRAP=1 set; skipping cdk bootstrap'
}

# ---- Deploy ----------------------------------------------------------------
# For a single stack, pass --exclusively so CDK does not re-run no-op changesets
# on every dependency stack (much faster iteration). For --all, use concurrency
# so independent stacks (e.g. the us-east-1 WAF) deploy in parallel.
Write-Step "Deploying $CdkTarget"
Push-Location $InfraDir
if ($CdkTarget -eq '--all') {
  npx cdk deploy --all --require-approval never --concurrency 4
} else {
  npx cdk deploy $CdkTarget --exclusively --require-approval never
}
Pop-Location

# ---- Upload the Glue ETL script -------------------------------------------
# The Glue job reads its PySpark script from s3://<data-lake>/glue-scripts/.
# A CDK BucketDeployment cannot write to the data-lake bucket (its Lambda has no
# grant on the data-lake CMK), so the script is synced here after deploy. The
# Glue job only reads this at pipeline execution time, so post-deploy timing is
# correct. This keeps the deploy a single command (no manual step).
if ($CdkTarget -eq '--all' -or $CdkTarget -like '*-pipeline' -or $CdkTarget -like '*-storage') {
  Write-Step 'Uploading Glue ETL script to the data lake bucket'
  $DataLakeBucket = "$($Env:RESOURCE_PREFIX)-amr-data-lake"
  aws s3 cp (Join-Path $RepoRoot 'src/glue-scripts/amr_etl.py') "s3://$DataLakeBucket/glue-scripts/amr_etl.py" --region $Env:AWS_REGION
  if ($LASTEXITCODE -ne 0) { Die 'Failed to upload Glue ETL script' }

  # The Glue ETL writes to S3 Tables via the Amazon S3 Tables Catalog for Apache
  # Iceberg client JAR (referenced by the job's --extra-jars). Fetch it from Maven
  # Central once and stage it in the data lake bucket. Glue --extra-jars needs an
  # S3 path (Maven coordinates are not supported), so this is the CDK-friendly way
  # to keep the deploy a single command with no manual steps.
  Write-Step 'Staging the S3 Tables Iceberg catalog client JAR'
  $JarKey = 'glue-jars/s3-tables-catalog-runtime.jar'
  $JarExists = (aws s3 ls "s3://$DataLakeBucket/$JarKey" --region $Env:AWS_REGION) 2>$null
  if (-not $JarExists) {
    $Meta = [xml](Invoke-WebRequest -UseBasicParsing -Uri 'https://repo1.maven.org/maven2/software/amazon/s3tables/s3-tables-catalog-for-iceberg-runtime/maven-metadata.xml').Content
    $JarVer = $Meta.metadata.versioning.latest
    $JarUrl = "https://repo1.maven.org/maven2/software/amazon/s3tables/s3-tables-catalog-for-iceberg-runtime/$JarVer/s3-tables-catalog-for-iceberg-runtime-$JarVer.jar"
    $TmpJar = Join-Path $env:TEMP 's3-tables-catalog-runtime.jar'
    Invoke-WebRequest -UseBasicParsing -Uri $JarUrl -OutFile $TmpJar
    aws s3 cp $TmpJar "s3://$DataLakeBucket/$JarKey" --region $Env:AWS_REGION
    if ($LASTEXITCODE -ne 0) { Die 'Failed to upload S3 Tables catalog JAR' }
    Remove-Item $TmpJar -Force
  } else {
    Write-Host 'S3 Tables catalog JAR already staged; skipping download.'
  }
}

Write-Step 'Deployment complete'
if ($CdkTarget -eq '--all') {
  Write-Host @"

Retrieve the live endpoints:

  aws cloudformation describe-stacks --region $($Env:AWS_REGION) ``
    --stack-name $($Env:RESOURCE_PREFIX)-amr-frontend ``
    --query "Stacks[0].Outputs" --output table

Retrieve the demo admin password:

  aws secretsmanager get-secret-value --region $($Env:AWS_REGION) ``
    --secret-id $($Env:RESOURCE_PREFIX)/amr/cognito/admin-password ``
    --query SecretString --output text
"@
}
