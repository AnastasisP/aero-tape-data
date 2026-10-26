// Append-only JSONL store with a manifest of content hashes.
// Layout under <root>/v1: <chainId>/<metric>/<yyyy-mm>/<yyyy-mm-dd>.jsonl, manifest.json.
// Day files, not month files: a month of Base gauge-state is ~150 MB, over GitHub's 100 MB file cap.
// Integrity rule: a file's bytes up to manifest.bytes must hash to manifest.sha256.
// Bytes past that point are an interrupted append and are cut back on open.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { assertRecord } from "./schema.mjs";

export const STORE_VERSION = "v1";
export const SPARSE_DAYS = 32;

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function dayOf(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export function recordPath(chainId, metric, bucket) {
  const day = dayOf(bucket);
  return `${chainId}/${metric}/${day.slice(0, 7)}/${day}.jsonl`;
}

export class TapeStore {
  /**
   * @param root     store root (the tape-data checkout)
   * @param readOnly verify only: an interrupted append is an error instead of being cut
   */
  constructor(root, { readOnly = false } = {}) {
    this.readOnly = readOnly;
    this.root = root;
    this.dir = join(root, STORE_VERSION);
    this.manifestPath = join(this.dir, "manifest.json");
    this.manifest = existsSync(this.manifestPath)
      ? JSON.parse(readFileSync(this.manifestPath, "utf8"))
      : { schemaVersion: 1, files: {}, cursors: {}, metricCursors: {}, programs: {}, gauges: {}, feeCheckpoints: {} };
    this.manifest.metricCursors ??= {};
    this.manifest.slopeChanges ??= {};
    this.manifest.relays ??= {};
    this.manifest.tokens ??= {};
    this.manifest.gauges ??= {};
    this.manifest.feeCheckpoints ??= {};
    this.repairs = [];
    this.#checkIntegrity();
  }

  #checkIntegrity() {
    // A sparse checkout (the workflow) holds only recent months. Day files older than
    // SPARSE_DAYS before the newest cursor are never written again, so they may be absent.
    const newest = Math.max(0, ...Object.values(this.manifest.cursors));
    const oldestRequired = dayOf(newest - SPARSE_DAYS * 86400);
    for (const [rel, m] of Object.entries(this.manifest.files)) {
      const abs = join(this.dir, rel);
      if (!existsSync(abs)) {
        if (rel.slice(-16, -6) < oldestRequired) continue;
        throw new Error(`tape: ${rel} is in the manifest but missing`);
      }
      const buf = readFileSync(abs);
      if (buf.length < m.bytes) throw new Error(`tape: ${rel} is shorter than the manifest (${buf.length} < ${m.bytes})`);
      if (sha(buf.subarray(0, m.bytes)) !== m.sha256) throw new Error(`tape: ${rel} content does not match the manifest hash`);
      if (buf.length > m.bytes) {
        if (this.readOnly) throw new Error(`tape: ${rel} has ${buf.length - m.bytes} bytes past the manifest`);
        truncateSync(abs, m.bytes);
        this.repairs.push(`${rel}: cut ${buf.length - m.bytes} bytes of an interrupted append`);
      }
    }
  }

  /** Last archived hour for a chain, or null. */
  cursor(chainId) {
    return this.manifest.cursors[chainId] ?? null;
  }

  /** Map rewards -> highest archived incentive program id, for one chain. */
  programs(chainId) {
    return new Map(Object.entries(this.manifest.programs[chainId] ?? {}));
  }

  /**
   * Working state kept between runs (not tape data, not in the manifest, may be lost):
   * <root>/state/<chainId>/<name>.json. Losing it only makes the next run write a full
   * snapshot instead of a delta.
   */
  readState(chainId, name) {
    const abs = join(this.root, "state", String(chainId), `${name}.json`);
    return existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : null;
  }

  /**
   * Appends one JSON line to <root>/state/<chainId>/<name>/<yyyy-mm-dd>.jsonl (A42 run log;
   * working state like the rest of state/, kept in the data branch, not in the manifest).
   */
  appendStateLog(chainId, name, day, value) {
    const abs = join(this.root, "state", String(chainId), name, `${day}.jsonl`);
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, JSON.stringify(value) + "\n");
  }

  writeState(chainId, name, value) {
    const abs = join(this.root, "state", String(chainId), `${name}.json`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(`${abs}.tmp`, JSON.stringify(value));
    renameSync(`${abs}.tmp`, abs);
  }

  /**
   * Last hour processed for a metric added after the chain's first hour (its rows may be
   * empty for an hour). null = never processed: the archiver backfills it from activation (core metrics) or from the start of the 48h ring, or from the next hour (LP-side context, archive.mjs LATE_METRICS).
   */
  metricCursor(chainId, metric) {
    return this.manifest.metricCursors[chainId]?.[metric] ?? null;
  }

  /**
   * Appends one backfilled hour of a single metric. Its rows go to that metric's own
   * files, so they stay in hour order even though the chain cursor is further ahead.
   */
  appendMetricHour(chainId, metric, bucket, records) {
    const prev = this.metricCursor(chainId, metric);
    if (prev !== null && bucket <= prev) throw new Error(`tape: ${metric} hour ${bucket} <= its cursor ${prev}`);
    if (records.some((r) => r.metric !== metric)) throw new Error(`tape: backfill of ${metric} carries another metric`);
    this.#append(chainId, bucket, records);
    (this.manifest.metricCursors[chainId] ??= {})[metric] = bucket;
    this.#writeManifest();
  }

  /** Map rewards -> highest archived fee checkpoint index, for one chain. */
  feeCheckpoints(chainId) {
    return new Map(Object.entries(this.manifest.feeCheckpoints[chainId] ?? {}));
  }

  /** Set of token addresses whose symbol / decimals are archived, for one chain. */
  tokens(chainId) {
    return new Set(this.manifest.tokens[chainId] ?? []);
  }

  /** Set of relay addresses archived, for one chain. */
  relays(chainId) {
    return new Set(this.manifest.relays[chainId] ?? []);
  }

  /** Set of "gauge:boundary" whose gauge slope change is archived, for one chain. */
  slopeChanges(chainId) {
    return new Set(this.manifest.slopeChanges[chainId] ?? []);
  }

  /** Map gauge -> archived links key, for one chain. */
  gauges(chainId) {
    return new Map(Object.entries(this.manifest.gauges[chainId] ?? {}));
  }

  /**
   * Appends one hour of records for a chain and advances its cursor. The manifest
   * is rewritten (atomic rename) after the data files, so a crash leaves at most an
   * uncommitted tail that the next open cuts away.
   */
  appendHour(chainId, bucket, records, programs, registry, feeCheckpoints = [], processedMetrics = []) {
    const prev = this.cursor(chainId);
    if (prev !== null && bucket <= prev) throw new Error(`tape: chain ${chainId} hour ${bucket} <= cursor ${prev}`);
    for (const m of processedMetrics) {
      const mc = this.metricCursor(chainId, m);
      if (mc !== null && bucket <= mc) throw new Error(`tape: ${m} hour ${bucket} <= its cursor ${mc}`);
    }
    this.#append(chainId, bucket, records);
    this.manifest.cursors[chainId] = bucket;
    for (const m of processedMetrics) (this.manifest.metricCursors[chainId] ??= {})[m] = bucket;
    for (const p of programs) {
      const m = (this.manifest.programs[chainId] ??= {});
      m[p.rewards] = Math.max(m[p.rewards] ?? 0, p.programId);
    }
    for (const g of registry) {
      (this.manifest.gauges[chainId] ??= {})[g.gauge] = [g.pool, g.rewards, g.token0, g.token1].join(",");
    }
    for (const c of feeCheckpoints) {
      const m = (this.manifest.feeCheckpoints[chainId] ??= {});
      m[c.rewards] = Math.max(m[c.rewards] ?? 0, c.index);
    }
    for (const r of records) {
      if (r.metric === "gauge-slope-change") (this.manifest.slopeChanges[chainId] ??= []).push(`${r.gauge}:${r.boundary}`);
      if (r.metric === "relay-registry") (this.manifest.relays[chainId] ??= []).push(r.relay);
      if (r.metric === "token-registry") (this.manifest.tokens[chainId] ??= []).push(r.token);
    }
    this.#writeManifest();
  }

  #append(chainId, bucket, records) {
    const byFile = new Map();
    for (const r of records) {
      assertRecord(r);
      if (r.chainId !== chainId || r.bucket !== bucket) throw new Error(`tape: record for ${r.chainId}@${r.bucket} in hour ${chainId}@${bucket}`);
      const rel = recordPath(chainId, r.metric, bucket);
      byFile.set(rel, (byFile.get(rel) ?? "") + JSON.stringify(r) + "\n");
    }
    const staged = {};
    for (const [rel, text] of byFile) {
      const abs = join(this.dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      appendFileSync(abs, text);
      const buf = readFileSync(abs);
      const lines = (this.manifest.files[rel]?.lines ?? 0) + text.split("\n").length - 1;
      staged[rel] = { sha256: sha(buf), bytes: buf.length, lines };
    }
    Object.assign(this.manifest.files, staged);
  }

  #writeManifest() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.manifestPath}.tmp`;
    const sorted = { ...this.manifest, files: Object.fromEntries(Object.entries(this.manifest.files).sort()) };
    writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n");
    renameSync(tmp, this.manifestPath);
  }
}
