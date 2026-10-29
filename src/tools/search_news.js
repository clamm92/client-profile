import { z } from "zod/v4";
import { Sources, ok, noData, error, fromException, clean } from "../lib/envelope.js";
import { cached } from "../lib/cache.js";
import { safeRequest, decodeBody, FetchError } from "../lib/http.js";

/**
 * News source: GDELT DOC 2.0 API (api.gdeltproject.org). It has no robots.txt restriction on
 * automated access (robots.txt returns 404). Google News RSS was NOT used because
 * news.google.com/robots.txt disallows the RSS path for all crawlers.
 *
 * GDELT limitations that this tool reports in diagnostics only:
 *  - the DOC API covers a rolling window of about 3 months, so 12-month lookbacks are partial;
 *  - it returns no snippets, and its date is when GDELT first saw the article, not the publication date.
 */
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const MIN_INTERVAL_MS = 11000; // GDELT asks for 1 request / 5 s but throttles harder in practice
const MAX_WINDOW_DAYS = 90;

export const MODES = ["recent_90d", "trajectory_12m", "material_developments", "relationships", "partners"];

const MODE_TERMS = {
  recent_90d: null,
  trajectory_12m: null,
  material_developments:
    '(layoffs OR "job cuts" OR restructuring OR lawsuit OR "regulatory" OR restatement OR "data breach" OR cyberattack OR resigns OR "steps down" OR "appoints" OR "chief executive" OR acquisition OR divestiture)',
  relationships: "(IBM OR Accenture OR Deloitte OR Cognizant OR Infosys OR Capgemini OR Kyndryl)",
  partners: "(partnership OR partners OR alliance OR collaboration OR \"strategic agreement\")",
};

const WIRE_DOMAINS = ["prnewswire.com", "businesswire.com", "globenewswire.com", "accesswire.com"];
const VENDOR_DOMAINS = ["ibm.com", "microsoft.com", "aws.amazon.com", "google.com", "oracle.com", "sap.com", "accenture.com", "deloitte.com", "nvidia.com", "servicenow.com", "workday.com"];

let nextSlot = 0;
async function gdeltGate() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

const seenByMode = new Map(); // `${companyKey}|${url}` -> mode (cross-mode de-duplication within this server process)

const companyKey = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const coreToken = (q) =>
  companyKey(q)
    .split(" ")
    .filter((t) => t && !["inc", "corp", "corporation", "co", "company", "ltd", "plc", "the", "llc"].includes(t))[0] || "";

export function parseSeenDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

export function classifySource(domain, query) {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  const token = coreToken(query);
  if (WIRE_DOMAINS.some((w) => d === w || d.endsWith("." + w))) return "press_release_wire";
  if (token && token.length > 2 && d.split(".").includes(token)) return "company_announcement";
  if (VENDOR_DOMAINS.some((v) => d === v || d.endsWith("." + v))) return "vendor_announcement";
  return "unknown";
}

export function buildQuery(query, mode) {
  const q = query.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  const terms = MODE_TERMS[mode];
  return `"${q}"${terms ? " " + terms : ""} sourcelang:english`;
}

async function gdeltFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await gdeltGate();
    const res = await safeRequest(url, { retries: 0, timeoutMs: 30000, maxBytes: 4 * 1024 * 1024, headers: { accept: "application/json" } });
    const text = decodeBody(res.body, String(res.headers["content-type"] || ""));
    if (res.status === 429 || /Please limit requests/i.test(text)) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      throw new FetchError("GDELT is rate-limiting requests right now; try again in a minute.", "rate_limited");
    }
    if (res.status < 200 || res.status >= 300) throw new FetchError(`News service returned HTTP ${res.status}.`, "news_http_error");
    if (!text.trim()) return { articles: [] };
    try {
      return JSON.parse(text);
    } catch {
      throw new FetchError("News service returned a non-JSON response.", "news_bad_response");
    }
  }
  throw new FetchError("News service unavailable.", "news_unavailable");
}

export const definition = {
  name: "search_news",
  description: [
    "WHAT: Searches public news coverage through the GDELT DOC API (not Google News, whose robots.txt disallows automated RSS access). Returns article titles, publishers, article URLs, first-seen dates, and a source-type hint. It returns no snippets and performs no sentiment or success/failure judgments; keyword matches are candidate evidence only.",
    "WHEN TO USE: To find recent coverage and candidate developments for a company. Modes: 'recent_90d' general recent coverage; 'trajectory_12m' (GDELT covers only about the last 3 months, so this is partial; use filings and fetch_page for longer history); 'material_developments' leadership change, restructuring, layoffs, litigation, regulatory action, restatement, cyber incident, M&A; 'relationships' public mentions with IBM and consulting/technology providers; 'partners' partnerships and alliances. Headlines alone do not establish details: read the article with fetch_page before relying on it, and confirm each story concerns the intended entity.",
    "PARAMETERS: query (string, company name); mode (one of recent_90d, trajectory_12m, material_developments, relationships, partners); max_results (integer 1-25, default 10).",
    "RETURNS: {status, data:{query, mode, window_days, articles:[{title, publisher, url, resolved_url?, first_seen_at, source_type, title_mentions_query, search_mode, source_id}]}, sources[], diagnostics?}. first_seen_at is when GDELT first saw the article and may be later than publication. Articles already returned for another mode in this session are omitted. Network: sends the company name and search terms to api.gdeltproject.org.",
  ].join("\n"),
  inputSchema: z.object({
    query: z.string().min(2).max(120).describe("Company name"),
    mode: z.enum(MODES),
    max_results: z.number().int().min(1).max(25).default(10).optional(),
  }),
};

export async function handler({ query, mode, max_results = 10 }) {
  try {
    const sources = new Sources();
    const q = buildQuery(query, mode);
    const windowDays = mode === "trajectory_12m" ? MAX_WINDOW_DAYS : mode === "recent_90d" ? 90 : MAX_WINDOW_DAYS;
    const url = `${GDELT}?${new URLSearchParams({ query: q, mode: "ArtList", format: "json", maxrecords: "75", timespan: "90d", sort: "DateDesc" })}`;

    const { value: raw, fromCache } = await cached(
      `NEWS ${url}`,
      async () => ({ retrieved_at: new Date().toISOString(), json: await gdeltFetch(url) }),
      (v) => Array.isArray(v.json?.articles)
    );

    const diagnostics = {};
    const notes = [];
    if (mode === "trajectory_12m") {
      diagnostics.partial = true;
      notes.push("GDELT's DOC API covers only about the last 3 months, so a 12-month trajectory could not be searched. Use 10-K/8-K filings and official pages for longer-term direction.");
    }
    notes.push("GDELT supplies direct publisher URLs without snippets; first_seen_at is GDELT's first-seen time, not necessarily the publication date.");

    const cutoff = Date.now() - windowDays * 86400000;
    const key = companyKey(query);
    const token = coreToken(query);
    const seenUrls = new Set();
    const seenTitles = new Set();
    const articles = [];
    let droppedOutOfWindow = 0;
    let droppedDuplicates = 0;
    let droppedOtherMode = 0;
    for (const a of raw.json.articles || []) {
      const seen = parseSeenDate(a.seendate);
      if (!a.url || !a.title) continue;
      if (seen && Date.parse(seen) < cutoff) {
        droppedOutOfWindow++;
        continue;
      }
      const normTitle = a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenUrls.has(a.url) || seenTitles.has(normTitle)) {
        droppedDuplicates++;
        continue;
      }
      const prior = seenByMode.get(`${key}|${a.url}`);
      if (prior && prior !== mode) {
        droppedOtherMode++;
        continue;
      }
      seenUrls.add(a.url);
      seenTitles.add(normTitle);
      const titleLower = a.title.toLowerCase();
      const mentions = Boolean(token) && titleLower.includes(token);
      const source_type = classifySource(a.domain, query);
      articles.push({ a, seen, mentions, source_type });
    }
    articles.sort((x, y) => Number(y.mentions) - Number(x.mentions) || (y.seen || "").localeCompare(x.seen || ""));
    const out = articles.slice(0, max_results).map(({ a, seen, mentions, source_type }) => {
      seenByMode.set(`${key}|${a.url}`, mode);
      const source_id = sources.add({
        url: a.url,
        title: a.title,
        publisher: a.domain,
        retrieved_at: raw.retrieved_at,
        kind: "news",
      });
      return clean({
        title: a.title.replace(/\s+/g, " ").trim(),
        publisher: a.domain,
        url: a.url,
        first_seen_at: seen || undefined,
        source_type,
        title_mentions_query: mentions,
        search_mode: mode,
        source_id,
      });
    });

    if (droppedOutOfWindow) notes.push(`${droppedOutOfWindow} result(s) outside the ${windowDays}-day window were dropped.`);
    if (droppedDuplicates) notes.push(`${droppedDuplicates} duplicate result(s) were dropped.`);
    if (droppedOtherMode) notes.push(`${droppedOtherMode} result(s) already returned for another mode were omitted.`);
    if (fromCache) notes.push("Served from the 24-hour cache.");
    diagnostics.notes = notes;
    const data = { query, mode, window_days: windowDays, articles: out };
    if (!out.length) return noData(data, sources.list(), { ...diagnostics, reason: "No matching articles in the window." });
    return ok(data, sources.list(), diagnostics);
  } catch (e) {
    return fromException(e);
  }
}
