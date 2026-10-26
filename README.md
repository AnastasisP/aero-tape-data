# aero-tape-data

Hourly, append-only samples of the Aero v3 allocation market on 7 chains (Base, OP
Mainnet, Ethereum, Arbitrum One, Ink, Robinhood Chain, Arc), read directly from chain
state. Descriptive data only: no forecast, no recommendation.

- **`data` branch**: the tape. `v1/<chainId>/<metric>/<yyyy-mm>/<yyyy-mm-dd>.jsonl`, one
  JSON object per line, `v1/manifest.json` with the sha256 of every file.
- **`derived` branch**: `derived/v1/` — candles (1h / 4h / 1d / 1w) per gauge, LP-side and
  emission series, decay calendars, position-history shards, the index. A deterministic
  rebuild of `v1/` (`scripts/tape/build-derived.mjs`), so it is one commit replaced every
  run and never grows the history.
- **`main` branch**: the archiver (`scripts/tape/archive.mjs`), its verifiers and the
  hourly workflow (`.github/workflows/archive.yml`). Public RPCs only, no keys.

Every line carries `schemaVersion`, `chainId`, `blockNumber`, `blockTimestamp`, `bucket`,
`source`, `class`. The sample for hour H is read at the first block whose timestamp is
>= H; reproduce any line with an `eth_call` at its `blockNumber`. Amounts are decimal
strings in base units. Lines are only ever appended. Every read is pinned: each
`eth_call` also returns the block it executed at (block timestamp on Arbitrum and
Robinhood, where `block.number` is the parent chain's), and a mismatch is retried.

`pool-state` lines (pool balances and pool-tape cumulative fees / volume / swaps) are
LP-side context only, never staker revenue; they start 48 hours before the first run that
archived them.

Checks run on every archive: integrity and continuity (`verify-archive`), exactness of 50
random points re-read at their blocks (`verify-exact`), total = allocated + idle voting
power token by token (`verify-idle`), staker fee revenue rebuilt from the tape equals the
protocol's `earnedFees` for 25 real veNFTs (`verify-parity`).

Contract addresses come from `dromos-labs/metadex-public` `deployment-addresses/` at a
pinned commit (`lib/data/aero-v3/registry/deployments.json`). Measurement rules that bind
any future claim made from this data: `PREREG.md`.
