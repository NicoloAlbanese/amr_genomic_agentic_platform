#!/usr/bin/env bash
#
# sra-fetcher entrypoint
# ----------------------
# Fetches a public SRA run from the AWS Open Data SRA mirror
# (s3://sra-pub-run-odp, no credentials, free egress) and converts it to
# gzipped paired-end FASTQ with fasterq-dump, then uploads the reads to the
# genomics data lake under raw/<isolate_id>/.
#
# Required environment:
#   SRA_ACCESSION   - e.g. SRR1583085
#   S3_OUTPUT_BUCKET- destination data-lake bucket
# Optional:
#   ISOLATE_ID      - defaults to isolate-<accession>
#   OUTPUT_DIR      - scratch dir (defaults to /tmp/fastq)
#
# The task runs as a non-root user with a read-only root filesystem; only
# OUTPUT_DIR (a writable tmpfs mount) is used for scratch.
set -euo pipefail

: "${SRA_ACCESSION:?SRA_ACCESSION is required}"
: "${S3_OUTPUT_BUCKET:?S3_OUTPUT_BUCKET is required}"
ISOLATE_ID="${ISOLATE_ID:-isolate-${SRA_ACCESSION}}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/fastq}"

log() { printf '{"stage":"sra-fetcher","level":"%s","accession":"%s","isolate_id":"%s","message":"%s"}\n' "$1" "${SRA_ACCESSION}" "${ISOLATE_ID}" "$2"; }

mkdir -p "${OUTPUT_DIR}"
# fasterq-dump writes a VDB config here; keep it inside the writable scratch
# mount because the container root filesystem is read-only.
mkdir -p "${OUTPUT_DIR}/.ncbi"
printf '/LIBS/GUID = "%s"\n/libs/cloud/report_instance_identity = "false"\n' \
  "$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000-0000-0000-0000-000000000000)" \
  > "${OUTPUT_DIR}/.ncbi/user-settings.mkfg"
cd "${OUTPUT_DIR}"

# The AWS Open Data SRA mirror stores each run as a single object at
# s3://sra-pub-run-odp/sra/<ACC>/<ACC>. Pull it directly (unsigned, free) rather
# than going through NCBI prefetch, which avoids credentials and rate limits.
SRA_S3_URI="s3://sra-pub-run-odp/sra/${SRA_ACCESSION}/${SRA_ACCESSION}"
log "info" "downloading SRA object from AWS Open Data"
aws s3 cp --no-sign-request "${SRA_S3_URI}" "${OUTPUT_DIR}/${SRA_ACCESSION}.sra"

log "info" "converting to FASTQ with fasterq-dump"
# --split-files writes _1/_2 for paired-end runs; single-end writes one file.
fasterq-dump "${OUTPUT_DIR}/${SRA_ACCESSION}.sra" \
  --split-files \
  --outdir "${OUTPUT_DIR}" \
  --temp "${OUTPUT_DIR}" \
  --threads "$(nproc)" \
  --force

# Gzip and upload whatever fasterq-dump produced. Paired-end runs yield
# <ACC>_1.fastq and <ACC>_2.fastq; single-end yields <ACC>.fastq.
DEST_PREFIX="s3://${S3_OUTPUT_BUCKET}/raw/${ISOLATE_ID}"
shopt -s nullglob
produced=0
for fq in "${OUTPUT_DIR}/${SRA_ACCESSION}"*.fastq; do
  gzip -f "${fq}"
  fname="$(basename "${fq}.gz")"
  log "info" "uploading ${fname}"
  aws s3 cp "${fq}.gz" "${DEST_PREFIX}/${fname}"
  produced=$((produced + 1))
done

if [ "${produced}" -eq 0 ]; then
  log "error" "fasterq-dump produced no FASTQ files"
  exit 1
fi

log "info" "sra-fetcher complete (${produced} FASTQ file(s) uploaded to ${DEST_PREFIX}/)"
