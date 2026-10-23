# PRE-REGISTRATION — measurements on the Allocation Tape (A13)

> Committed 2026-10-23, before the archiver (A3) has written any file and before any v3
> accrual series has been viewed. Binding for every Builder, Implementer, and agent.
> Goal: `specs/goal/ALLOCATION-TAPE-GOAL.md` (A13). Method source:
> `specs/phase-25/25a.38-RESEARCH-v3-allocation-science.md` §2d, and
> `.claude/ml-kill-criteria.md`. If this file contradicts a test, the test wins.
> This file may be extended (new hypotheses, see §8). Registered values in §2–§7 may not be
> changed after the first archived accrual file exists. A change = a new registration with a
> new holdout window (§8).

## 0. Why this exists when the product does not forecast

The tape shows data and makes no forecast. This registration keeps that line honest. Any
future statement that a tape series, an indicator, or a rule "predicts", "leads", "beats",
or "has edge" is allowed only if it passes §6 on data collected after this commit. Until then
every indicator is descriptive, and `SIGNAL_GATE_PASSED` stays `false`.

## 1. Viewing rule (what may be looked at before the evaluation)

- Allowed at any time: reading accrual series to verify exactness (A5) and protocol parity
  (A6), coverage (A4), and idle-weight reconciliation (A8). These compare archived values to
  chain reads. They never compare a rule or a forecast to an outcome.
- Allowed at any time: showing the series in the UI and the MCP server (A10, A11). Display is
  not an evaluation.
- Forbidden before §5's sample size is reached: computing the performance of any candidate
  rule, indicator, or forecast against realized staker yield on any window of tape data,
  including "quick looks", plots of rule returns, or tuning parameters on the data.
- Baselines B0–B3 (§4) may be implemented and unit-tested on synthetic data at any time.

## 2. The quantity (only this one)

Realized staker revenue per unit of allocated weight, per gauge g, per decision period:

- Numerator = exchange revenue streamed by `FeeDistribution` to stakers on g + incentives
  streamed by `IncentiveStreaming` on g. Token-native first. Priced to USD only at
  evaluation, with the provider and price timestamp recorded (class P, §4 of the goal).
- Never in the numerator: gross pool swap fees, LP emissions, `GaugeTape.rewardPerToken` if
  it is LP-side (A7). This is the $1,132 lesson; `economicLineage` applies.
- Denominator = allocated weight W_g(s), evaluated continuously (bias/slope decay), plus the
  allocator's own size x for diluted yield.
- Realized yield of an allocation of size x on g over [t, t+τ]:
  `Y_g(t, τ; x) = ∫ r_g(s) · x / (W_g(s) + x) ds`, r_g = numerator rate.

## 3. Universe, cadence, sizes

- Universe: every gauge on every chain in the A2 universe with W_g > 0 at the decision time
  and active for at least one full decision period before it.
- Strata (every metric is reported per stratum, never aggregate only):
  dead (r_g = 0 over the period), active, movers (top quintile of |Δ rank of y_g| between
  consecutive periods), and depth deciles of W_g.
- Decision period τ = `LeafVoter.allocationCooldown()` read on-chain at each period start
  (169,200 s at registration) plus the measured cross-chain delivery delay. Periods do not
  overlap.
- Sizes x ∈ {10k, 100k, 1M, 10M} voting power.

## 4. Baselines (fixed)

- **B0 market**: allocate pro rata to current W. Yield ratio π = 1 by definition.
- **B1 naive trailing**: allocate by the water-filling rule (goal §5d, research §2d) on the
  previous period's realized diluted yield.
- **B2 equal-yield null**: all gauges assumed equal yield → equivalent to B0 at the margin;
  used as the null in IC tests.
- **B3 public**: the water-filling rule on public, known-in-advance terms only: posted
  incentive streams (`rate`, `start`, `end`) for [t, t+τ] + trailing exchange revenue, over
  decay-projected W_g (`gaugeSlopeChanges`). Anyone can build B3; a candidate that does not
  beat B3 has no edge a clone lacks.

## 5. Metrics and sample size

- π(x) = realized yield of the rule ÷ realized yield of B0, same x, same period.
- Rank IC: Spearman between the rule's ranking and realized diluted yield, with a HAC
  (Newey–West, lag = 2 periods) t-statistic.
- Regret vs the hindsight optimum and vs the best fixed rule.
- Costs: gas + bridge fee per switch, at the recorded on-chain cost at the switch time.
- Minimum sample: 30 non-overlapping decision periods (≈ 59 days at τ = 47h) starting at the
  first period that begins after the first archived accrual file. One look only, at N = 30.
  No optional stopping. If the period length changes, the count stays 30.

## 6. PASS / FAIL (binding)

A candidate passes only if ALL hold on the active and movers strata at x = 1M:

1. π(1M) after costs > π of B1 and > π of B3, Diebold–Mariano one-sided p < 0.05 for each.
2. Rank IC HAC t > 3 (Harvey–Liu–Zhu threshold).
3. Lift is not fee persistence: the IC gap between a fees-only version and the full version
   is > 0 with HAC t > 2.
4. Lift is not a settlement artifact: a lag sweep τ ∈ {−2, −1, 0, +1, +2} periods shows no
   clean lag-1 identity (the b_lag ≫ b_same pattern of v2).
5. If more than one candidate is tested, Hansen SPA p < 0.05 against B1 and B3.

Any condition false → FAIL. Outcome = descriptive only. `SIGNAL_GATE_PASSED` stays `false`.
No re-run with changed thresholds, sizes, strata, or windows on the same data.

## 7. What is not tested here

The tape's exactness (A5), parity (A6) and reconciliation (A8) are correctness checks, not
hypotheses. They are not subject to the viewing rule and do not need a holdout.

## 8. Adding a hypothesis later

A new hypothesis (a new rule or indicator claim) needs its own section appended to this file
in a commit that precedes its evaluation. Its holdout window starts at the first decision
period after that commit. Data seen before that commit may not be part of its evaluation.

| # | Hypothesis | Registered | Holdout starts |
|---|---|---|---|
| H0 | No rule beats B1 and B3 under §6 (the null; current belief) | 2026-10-23 | first period after first archived accrual file |
