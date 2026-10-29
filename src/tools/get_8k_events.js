import { z } from "zod/v4";
import { Sources, ok, noData, fromException } from "../lib/envelope.js";
import { getSubmissions, recentFilings, filingDocUrl, filingIndexUrl, validateCik } from "../lib/sec.js";

export const ITEM_CATEGORIES = {
  "5.02": "leadership/governance",
  "4.01": "auditor change",
  "4.02": "non-reliance on previously issued financial statements",
  "2.05": "exit or disposal activities",
  "1.05": "material cybersecurity incident",
};

export function parseItems(itemsStr) {
  return String(itemsStr || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+\.\d{2}$/.test(s));
}

export const definition = {
  name: "get_8k_events",
  description: [
    "WHAT: Lists recent 8-K filings for an SEC filer with filing date, item codes, filing URL, and a neutral category for recognized item codes (5.02 leadership/governance, 4.01 auditor change, 4.02 non-reliance on financial statements, 2.05 exit/disposal activities, 1.05 material cybersecurity incident).",
    "WHEN TO USE: To find candidate material developments. An item code only identifies a candidate: a 5.02 filing is not automatically a problem, and no event details are invented from a code. Read the primary filing document with fetch_page before describing any event in a profile.",
    "PARAMETERS: cik (string, SEC CIK); days (integer, default 180, 1-1095) - look-back window by filing date.",
    "RETURNS: {status, data:{window_days, since, filings:[{filing_date, report_date?, items[], categories[], filing_url, filing_index_url, source_id}], recognized_count, other_count}, sources[], diagnostics?}. Recognized-category filings are listed first. Network: contacts sec.gov.",
  ].join("\n"),
  inputSchema: z.object({
    cik: z.string().min(1).max(10).describe("SEC Central Index Key"),
    days: z.number().int().min(1).max(1095).default(180).optional(),
  }),
};

export async function handler({ cik, days = 180 }) {
  try {
    const padded = validateCik(cik);
    const sub = await getSubmissions(padded);
    if (!sub) return noData({}, [], { code: "cik_not_found", reason: "SEC has no submissions for this CIK." });
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const all = recentFilings(sub.json).filter((f) => f.form === "8-K" || f.form === "8-K/A");
    const inWindow = all.filter((f) => f.filingDate >= since);
    const sources = new Sources();
    const filings = inWindow.map((f) => {
      const items = parseItems(f.items);
      const categories = [...new Set(items.filter((i) => ITEM_CATEGORIES[i]).map((i) => ITEM_CATEGORIES[i]))];
      const url = f.primaryDocument ? filingDocUrl(padded, f) : filingIndexUrl(padded, f);
      const source_id = sources.add({
        url,
        title: `${sub.json.name} ${f.form} filed ${f.filingDate}`,
        publisher: "U.S. Securities and Exchange Commission",
        published_at: f.filingDate,
        retrieved_at: sub.retrieved_at,
      });
      return {
        form: f.form,
        filing_date: f.filingDate,
        report_date: f.reportDate || undefined,
        items,
        categories,
        filing_url: url,
        filing_index_url: filingIndexUrl(padded, f),
        source_id,
      };
    });
    filings.sort((a, b) => (b.categories.length > 0) - (a.categories.length > 0) || b.filing_date.localeCompare(a.filing_date));
    const recognized = filings.filter((f) => f.categories.length).length;
    const data = { window_days: days, since, filings: filings.slice(0, 40), recognized_count: recognized, other_count: filings.length - recognized };
    const diagnostics = {};
    if (filings.length > 40) {
      diagnostics.partial = true;
      diagnostics.reason = `Only the first 40 of ${filings.length} 8-K filings are returned.`;
    }
    const oldestRecent = recentFilings(sub.json).at(-1)?.filingDate;
    if (oldestRecent && oldestRecent > since) {
      diagnostics.partial = true;
      diagnostics.reason = (diagnostics.reason ? diagnostics.reason + " " : "") + "The SEC recent-filings list may not reach back the full requested window.";
    }
    if (!filings.length) return noData(data, sources.list(), { reason: "No 8-K filings in this window." });
    return ok(data, sources.list(), Object.keys(diagnostics).length ? diagnostics : undefined);
  } catch (e) {
    return fromException(e);
  }
}
