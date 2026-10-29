import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { GENERIC_UA, secUserAgent } from "./config.js";
import { log } from "./log.js";

export class FetchError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* Destination safety: reject private / reserved / metadata addresses  */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, includes cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => {
  const mask = (~0 << (32 - bits)) >>> 0;
  return { net: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function v4Public(ip) {
  const n = ipv4ToInt(ip);
  return !V4_BLOCKS.some((b) => ((n & b.mask) >>> 0) === b.net);
}

function expandV6(ip) {
  let addr = ip.split("%")[0].toLowerCase();
  const v4tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const n = ipv4ToInt(v4tail[1]);
    addr = addr.replace(v4tail[1], `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = addr.includes("::") ? new Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || "0", 16));
}

function v6Public(ip) {
  const g = expandV6(ip);
  if (g.length !== 8) return false;
  const allZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (allZeroPrefix && g[5] === 0xffff) {
    return v4Public(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // IPv4-mapped
  }
  if (allZeroPrefix) return false; // ::, ::1, deprecated IPv4-compatible
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false; // NAT64
  if (g[0] === 0x2002) return false; // 6to4
  return true;
}

export function isPublicIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return v4Public(ip);
  if (fam === 6) return v6Public(ip);
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "kubernetes.default.svc",
]);

export function assertSafeUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new FetchError("The URL is not valid.", "invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError("Only http and https URLs are allowed.", "unsupported_protocol");
  }
  if (u.username || u.password) {
    throw new FetchError("URLs containing credentials are not allowed.", "credentials_in_url");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) {
    throw new FetchError("Only the default HTTP/HTTPS ports are allowed.", "port_not_allowed");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  ) {
    throw new FetchError("Local and internal hostnames are blocked.", "blocked_destination");
  }
  if (net.isIP(host) && !isPublicIp(host)) {
    throw new FetchError("Private or reserved network addresses are blocked.", "blocked_destination");
  }
  return u;
}

/** DNS lookup that validates every resolved address so sockets connect only to public IPs. */
function safeLookup(hostname, options, callback) {
  const opts = typeof options === "function" ? {} : options || {};
  const cb = typeof options === "function" ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
      return cb(new FetchError("Host resolves to a private or reserved address.", "blocked_destination"));
    }
    if (opts.all) return cb(null, addresses);
    return cb(null, addresses[0].address, addresses[0].family);
  });
}

/* ------------------------------------------------------------------ */
/* SEC rate limiting: <= 5 requests/second across the whole server     */
/* ------------------------------------------------------------------ */

const SEC_MIN_INTERVAL_MS = 250; // 4 req/s including retries
let secNextSlot = 0;

async function secWait() {
  const now = Date.now();
  const slot = Math.max(now, secNextSlot);
  secNextSlot = slot + SEC_MIN_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export function isSecHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "sec.gov" || h.endsWith(".sec.gov");
}

/* ------------------------------------------------------------------ */
/* Low-level request                                                   */
/* ------------------------------------------------------------------ */

function requestOnce(u, { method, headers, timeoutMs, maxBytes, truncate }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method, headers, lookup: safeLookup, agent: false, minVersion: "TLSv1.2", timeout: timeoutMs },
      (res) => {
        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let total = 0;
        let truncated = false;
        let finished = false;
        const done = (err) => {
          if (finished) return;
          finished = true;
          if (err) return reject(err);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        stream.on("data", (chunk) => {
          if (finished) return;
          total += chunk.length;
          if (total > maxBytes) {
            if (!truncate) {
              req.destroy();
              return done(new FetchError("The response is larger than the allowed size.", "response_too_large"));
            }
            chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
            truncated = true;
            req.destroy();
            return done();
          }
          chunks.push(chunk);
        });
        stream.on("end", () => done());
        stream.on("error", (e) => done(e));
        res.on("error", (e) => done(e));
      }
    );
    req.on("timeout", () => req.destroy(new FetchError("The request timed out.", "timeout")));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

/**
 * Safe GET/HEAD. Validates the URL and every redirect hop, enforces size/time limits,
 * applies the SEC User-Agent and rate limit for sec.gov hosts, and retries transient failures.
 */
export async function safeRequest(
  urlStr,
  { method = "GET", headers = {}, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, truncate = false, maxRedirects = 5, retries = 2 } = {}
) {
  let current = urlStr;
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertSafeUrl(current);
    const sec = isSecHost(u.hostname);
    const h = {
      "user-agent": sec ? secUserAgent() : GENERIC_UA,
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
      ...headers,
    };
    let res;
    for (let attempt = 0; ; attempt++) {
      if (sec) await secWait();
      try {
        res = await requestOnce(u, { method, headers: h, timeoutMs, maxBytes, truncate });
      } catch (e) {
        const retryable = !(e instanceof FetchError) || e.code === "timeout";
        if (attempt < retries && retryable) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (e instanceof FetchError) throw e;
        throw new FetchError(`Network request failed (${e.code || e.message}).`, "network_error");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        log.warn("transient HTTP status, retrying", { host: u.hostname, status: res.status });
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      let next;
      try {
        next = new URL(res.headers.location, u).toString();
      } catch {
        throw new FetchError("The server sent an invalid redirect.", "bad_redirect");
      }
      redirects.push(next);
      current = next; // re-validated at the top of the loop
      continue;
    }
    return { ...res, finalUrl: u.toString(), redirects };
  }
  throw new FetchError("Too many redirects.", "too_many_redirects");
}

export function decodeBody(buf, contentType = "") {
  const m = /charset=([^;]+)/i.exec(contentType);
  const label = m ? m[1].trim().replace(/["']/g, "") : "utf-8";
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
