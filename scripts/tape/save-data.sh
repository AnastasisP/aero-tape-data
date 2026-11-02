#!/bin/sh
# Commits and pushes the raw hours and state in tape-data to the `data` branch. Run from the repo root.
set -eu
cd tape-data
git config user.name "aero-tape-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
# derived/ lives on its own branch (A46): drop it from the data branch once, never add it again
if git ls-files --error-unmatch derived/v1/index.json > /dev/null 2>&1; then git rm -r -q --cached --sparse derived; fi
git add v1 state
if git diff --cached --quiet; then
  echo "nothing new"
  exit 0
fi
git commit -q -m "tape: archive run ${GITHUB_RUN_ID}"
git push origin HEAD:data
