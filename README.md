# aero-tape-data — data branch

The tape: hourly, append-only samples of the Aero v3 allocation market on 7 chains,
written by `.github/workflows/archive.yml` on the `main` branch of this repository.

- Raw: `v1/<chainId>/<metric>/<yyyy-mm>/<yyyy-mm-dd>.jsonl`, one JSON object per line.
  Metrics: `gauge-state`, `gauge-registry`, `incentive-program`, `fee-checkpoint`,
  `allocation-change`, `gauge-slope-change`, `relay-registry`, `token-registry`,
  `leaf-state`, `root-state` (Base only).
- `v1/manifest.json`: sha256, byte length and line count of every file, each chain's last
  archived hour (`cursors`) and per-metric cursors.
- `derived/v1/`: candles of the core series per gauge (1h, 4h, 1d, 1w) and `index.json`.
- `state/`: working state of the archiver (not tape data).

The sample for hour H is read at the first block whose timestamp is >= H. Every line
carries `schemaVersion`, `chainId`, `blockNumber`, `blockTimestamp`, `bucket`, `source`,
`class`; amounts are decimal strings in base units. Lines are only ever appended.
History before 2026-10-23T14:33Z was written in a private repository and moved here
unchanged.
