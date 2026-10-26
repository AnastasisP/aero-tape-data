// Archive health (A42): per chain over the 7 days up to the newest archiver run, from the
// run log the archiver appends (state/all/runs/<day>.jsonl, one line per run): runs, runs
// that failed on the chain, the largest lag seen (complete hours behind its head), the last
// successful run and the lag now. Pure: no I/O.
export const HEALTH_WINDOW = 7 * 86_400;

/**
 * @param {Array<{ at: number, runId: string | null, chains: Record<string, { ok: boolean, cursor: number | null, lag: number | null }> }>} lines
 * @returns {{ from: number, to: number, runs: number, chains: Record<string, { runs: number, failed: number, maxLag: number | null, lastOkAt: number | null, lastRunAt: number | null, lag: number | null }> } | null}
 */
export function archiveHealth(lines) {
  if (!lines.length) return null;
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  const to = sorted.at(-1).at;
  const from = to - HEALTH_WINDOW;
  const inWindow = sorted.filter((l) => l.at > from);
  /** @type {Record<string, { runs: number, failed: number, maxLag: number | null, lastOkAt: number | null, lastRunAt: number | null, lag: number | null }>} */
  const chains = {};
  for (const l of inWindow) {
    for (const [id, c] of Object.entries(l.chains)) {
      const h = (chains[id] ??= { runs: 0, failed: 0, maxLag: null, lastOkAt: null, lastRunAt: null, lag: null });
      h.runs++;
      if (!c.ok) h.failed++;
      else h.lastOkAt = l.at;
      if (c.lag !== null) h.maxLag = h.maxLag === null ? c.lag : Math.max(h.maxLag, c.lag);
      h.lastRunAt = l.at;
      h.lag = c.lag;
    }
  }
  return { from, to, runs: inWindow.length, chains };
}
