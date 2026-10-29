/**
 * Session registry of URLs that tools have actually returned. export_pdf only accepts
 * citation links that appear here, which enforces "cite only URLs returned by tools".
 */
const known = new Set();
const MAX_KNOWN = 5000;
const URL_KEY = /(^|_)(url|href)$/i;

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return null;
  }
}

export function registerKnownUrl(u) {
  const n = normalizeUrl(u);
  if (!n || known.size >= MAX_KNOWN) return;
  known.add(n);
}

export function isKnownUrl(u) {
  const n = normalizeUrl(u);
  return Boolean(n) && known.has(n);
}

/** Register URL-valued fields (keys ending in url/href) from a tool envelope. Page text is never scanned. */
export function registerUrlsFrom(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const x of node) registerUrlsFrom(x, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && URL_KEY.test(k) && /^https?:\/\//i.test(v) && v.length <= 2048) registerKnownUrl(v);
    else if (v && typeof v === "object") registerUrlsFrom(v, depth + 1);
  }
}

export function clearKnownUrls() {
  known.clear();
}
