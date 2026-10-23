# Allocation Tape — data branch

Append-only hourly samples of the Aero v3 allocation market, written by
`.github/workflows/tape-archive.yml` on `main` (code: `scripts/tape/`).
Goal and definitions: `specs/goal/ALLOCATION-TAPE-GOAL.md` on `main`.

- Layout: `v1/<chainId>/<metric>/<yyyy-mm>/<yyyy-mm-dd>.jsonl`, one JSON object per line.
- `v1/manifest.json`: sha256, byte length and line count of every file, plus each
  chain's last archived hour (`cursors`).
- Sample for hour H = state read at the first block whose timestamp is >= H.
  Every line carries `schemaVersion`, `chainId`, `blockNumber`, `blockTimestamp`,
  `bucket` (= H), `source`, `class`. Amounts are decimal strings (wei, no floats).
- Metrics: `gauge-state`, `gauge-registry`, `incentive-program`, `leaf-state`,
  `root-state` (Base only). Raw chain reads only (class E). Nothing here is a forecast.
- Lines are only ever appended. Reproduce any line with an `eth_call` at its
  `blockNumber` on its `chainId`.
