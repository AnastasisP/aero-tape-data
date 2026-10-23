// Shared by sync-registry.mjs and verify-registry.mjs. Node built-ins only.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const REGISTRY_DIR = resolve(process.cwd(), "lib/data/aero-v3/registry");
export const CHAINS_PATH = resolve(REGISTRY_DIR, "chains.json");
export const DEPLOYMENTS_PATH = resolve(REGISTRY_DIR, "deployments.json");
export const UPSTREAM_REPO = "dromos-labs/metadex-public";
export const UPSTREAM_DIR = "deployment-addresses";

export function loadChains() {
  return JSON.parse(readFileSync(CHAINS_PATH, "utf8")).chains;
}

export function loadDeployments() {
  return JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
}

/** RPC urls in fallback order. TAPE_RPC_<SLUG> (comma-separated) replaces the registry list. */
export function rpcsFor(chain) {
  const env = process.env[`TAPE_RPC_${chain.slug.toUpperCase()}`];
  return env ? env.split(",").map((u) => u.trim()).filter(Boolean) : chain.rpcs;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** "<group>-<slug>.json" -> { group, slug }. The slug is the LAST dash segment. */
export function parseFileName(name) {
  const m = /^([a-z0-9]+)-([a-z0-9]+)\.json$/.exec(name);
  if (!m) throw new Error(`unexpected upstream file name: ${name}`);
  return { group: m[1], slug: m[2] };
}

export function rawUrl(commit, name) {
  return `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${commit}/${UPSTREAM_DIR}/${name}`;
}

export async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "aero-tape" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

/** Upstream values that are addresses. Constructor args and anything non-address are dropped. */
export function addressEntries(obj) {
  return Object.entries(obj).filter(
    ([k, v]) => !k.endsWith("ConstructorArgs") && typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
  );
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Keys whose address lives on another chain than the file's. Upstream fact (pin
 * 8b506b4): leaf-<slug>.json:expectedRootAdapter == rootadapters-base.json:
 * rootAdapter<chainId of slug>, a contract on the ROOT chain (Base).
 */
export const ROOT_SIDE_KEYS = new Set(["expectedRootAdapter"]);
