import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, CACHE_TTL_MS } from "./config.js";

function keyPath(key) {
  const h = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(CACHE_DIR, `${h}.json`);
}

/** 24h cache for public research responses. Returns undefined on miss/expiry/corruption. */
export async function cacheGet(key) {
  try {
    const raw = await fs.readFile(keyPath(key), "utf8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.stored_at > CACHE_TTL_MS) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export async function cacheSet(key, value) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const target = keyPath(key);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ stored_at: Date.now(), value }), "utf8");
  await fs.rename(tmp, target);
}

/** Return cached value or compute and store it. Only caches when `shouldCache(value)` is true. */
export async function cached(key, compute, shouldCache = () => true) {
  const hit = await cacheGet(key);
  if (hit !== undefined) return { value: hit, fromCache: true };
  const value = await compute();
  if (shouldCache(value)) {
    try {
      await cacheSet(key, value);
    } catch {
      // cache failures must never break a tool
    }
  }
  return { value, fromCache: false };
}

/** Cached GET returning {finalUrl,status,contentType,text,truncated,retrieved_at}. */
export async function cachedText(url, fetcher) {
  const { value } = await cached(`GET ${url}`, fetcher, (v) => v && v.status >= 200 && v.status < 300);
  return value;
}
