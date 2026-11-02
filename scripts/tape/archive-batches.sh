#!/bin/sh
# OPS-3: archives in batches and saves the raw hours after each one, before any derived build. A crash in the
# build or a job timeout loses at most the batch in progress. Exits with the last batch's archive status.
# A batch that fails a verifier saves nothing and stops the run. A batch that ends before its budget has no more
# hours to read, so the run stops there.
set -u
BATCHES=3
MINUTES=10
batch=1
while :; do
  started=$(date +%s)
  node scripts/tape/archive.mjs --out tape-data --max-hours 48 --max-minutes "$MINUTES"
  status=$?
  node scripts/tape/verify-archive.mjs --dir tape-data --offline || exit 2
  node scripts/tape/verify-exact.mjs --dir tape-data --sample 50 || exit 3
  sh scripts/tape/save-data.sh || exit 4
  elapsed=$(( $(date +%s) - started ))
  echo "batch $batch: archive status $status, $elapsed s"
  if [ "$batch" -ge "$BATCHES" ] || [ "$elapsed" -lt $(( (MINUTES - 1) * 60 )) ]; then exit "$status"; fi
  batch=$(( batch + 1 ))
done
