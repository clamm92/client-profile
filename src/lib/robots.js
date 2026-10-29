import { cached } from "./cache.js";
import { safeRequest, decodeBody } from "./http.js";

/** Parse robots.txt into groups of {agents, rules:[{allow, path}]}. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: field === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(p) {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** Longest-match wins; allow beats disallow on ties (RFC 9309). */
export function robotsAllows(groups, pathAndQuery, agentName = "prepbobclientprofile") {
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agentName.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (patternToRegex(r.path).test(pathAndQuery)) {
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
      }
    }
  }
  return best ? best.allow : true;
}

/** Returns {allowed, reason}. A missing robots.txt (404) means allowed; an unreadable one means not allowed. */
export async function checkRobots(urlObj) {
  const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
  const { value } = await cached(
    `ROBOTS ${robotsUrl}`,
    async () => {
      try {
        const res = await safeRequest(robotsUrl, { maxBytes: 512 * 1024, truncate: true, timeoutMs: 10000, retries: 1 });
        if (res.status === 404 || res.status === 410) return { state: "none" };
        if (res.status >= 200 && res.status < 300) return { state: "ok", text: decodeBody(res.body) };
        if (res.status === 401 || res.status === 403) return { state: "disallow_all" };
        return { state: "unavailable" };
      } catch {
        return { state: "unavailable" };
      }
    },
    (v) => v.state === "ok" || v.state === "none"
  );
  if (value.state === "none") return { allowed: true };
  if (value.state === "disallow_all") return { allowed: false, reason: "robots.txt could not be accessed (access denied), so the site is treated as off-limits to automated retrieval." };
  if (value.state === "unavailable") return { allowed: false, reason: "robots.txt could not be retrieved, so automated retrieval was not attempted." };
  const ok = robotsAllows(parseRobots(value.text), urlObj.pathname + urlObj.search);
  return ok ? { allowed: true } : { allowed: false, reason: "The site's robots.txt does not allow automated retrieval of this page." };
}
