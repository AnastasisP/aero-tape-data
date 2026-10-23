# aero-tape-data

Hourly, append-only samples of the Aero v3 allocation market on 7 chains (Base, OP
Mainnet, Ethereum, Arbitrum One, Ink, Robinhood Chain, Arc), read directly from chain
state. Descriptive data only: no forecast, no recommendation.

- **`data` branch**: the tape. `v1/<chainId>/<metric>/<yyyy-mm>/<yyyy-mm-dd>.jsonl`, one
  JSON object per line, `v1/manifest.json` with the sha256 of every file. `derived/v1/`
  holds candles (1h / 4h / 1d / 1w) of the core series per gauge, rebuilt each run.
- **`main` branch**: the archiver (`scripts/tape/archive.mjs`), its verifiers and the
  hourly workflow (`.github/workflows/archive.yml`). Public RPCs only, no keys.

Every line carries `schemaVersion`, `chainId`, `blockNumber`, `blockTimestamp`, `bucket`,
`source`, `class`. The sample for hour H is read at the first block whose timestamp is
>= H; reproduce any line with an `eth_call` at its `blockNumber`. Amounts are decimal
strings in base units. Lines are only ever appended.

Checks run on every archive: integrity and continuity (`verify-archive`), exactness of 50
random points re-read at their blocks (`verify-exact`), total = allocated + idle voting
power token by token (`verify-idle`), staker fee revenue rebuilt from the tape equals the
protocol's `earnedFees` for 25 real veNFTs (`verify-parity`).

Contract addresses come from `dromos-labs/metadex-public` `deployment-addresses/` at a
pinned commit (`lib/data/aero-v3/registry/deployments.json`). Measurement rules that bind
any future claim made from this data: `PREREG.md`.
