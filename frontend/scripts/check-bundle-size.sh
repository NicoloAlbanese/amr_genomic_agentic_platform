#!/usr/bin/env bash
# check-bundle-size.sh — Verify that no individual JS chunk exceeds the size limit.
# Usage: ./scripts/check-bundle-size.sh [max-kb]
# Default limit: 500 KB per chunk

set -euo pipefail

MAX_KB=${1:-500}
DIST_DIR="$(dirname "$0")/../dist/assets"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: dist/assets not found. Run 'npm run build' first." >&2
  exit 1
fi

FAILED=0
while IFS= read -r -d '' file; do
  size_kb=$(( $(wc -c < "$file") / 1024 ))
  filename=$(basename "$file")
  if (( size_kb > MAX_KB )); then
    echo "FAIL  ${filename}: ${size_kb} KB > ${MAX_KB} KB limit" >&2
    FAILED=1
  else
    echo "OK    ${filename}: ${size_kb} KB"
  fi
done < <(find "$DIST_DIR" -name "*.js" -print0)

if (( FAILED )); then
  echo ""
  echo "Bundle size check FAILED — at least one chunk exceeds ${MAX_KB} KB." >&2
  exit 1
fi

echo ""
echo "Bundle size check PASSED — all chunks within ${MAX_KB} KB limit."
