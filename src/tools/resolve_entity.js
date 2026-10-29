import { z } from "zod/v4";
import { Sources, ok, noData, error } from "../lib/envelope.js";
import { secJson, getSubmissions, latestAnnualFiling } from "../lib/sec.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

const SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "llc", "lp",
  "holdings", "holding", "group", "the", "and", "de", "sa", "nv", "ag", "adr", "ads", "class", "new",
]);

export function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function coreName(s) {
  return normalizeName(s)
    .split(" ")
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ");
}

/** Group ticker rows by CIK. */
export function groupByCik(rows) {
  const map = new Map();
  for (const r of rows) {
    const cik = String(r.cik_str).padStart(10, "0");
    const e = map.get(cik) || { cik, legal_name: r.title, tickers: [] };
    if (!e.tickers.includes(r.ticker)) e.tickers.push(r.ticker);
    map.set(cik, e);
  }
  return [...map.values()];
}

export function matchEntities(query, entities) {
  const q = coreName(query);
  const qFull = normalizeName(query);
  const qRaw = String(query).trim();
  const qTicker = qRaw.toUpperCase();
  const looksLikeTicker = /^[A-Za-z.\-]{1,6}$/.test(qRaw);
  const scored = [];
  for (const e of entities) {
    const core = coreName(e.legal_name);
    let score = 0;
    let basis = null;
    if (looksLikeTicker && e.tickers.some((t) => t === qTicker)) {
      score = 100;
      basis = "ticker_exact";
    }
    if (q && (core === q || normalizeName(e.legal_name) === qFull)) {
      if (score < 95) {
        score = 95;
        basis = "name_exact";
      }
    } else if (q && core.startsWith(q + " ")) {
      if (score < 70) {
        score = 70;
        basis = "name_prefix";
      }
    } else if (q && ` ${core} `.includes(` ${q} `)) {
      if (score < 50) {
        score = 50;
        basis = "name_contains";
      }
    }
    if (score) scored.push({ ...e, score, match_basis: basis });
  }
  return scored.sort((a, b) => b.score - a.score || a.legal_name.localeCompare(b.legal_name));
}

export const definition = {
  name: "resolve_entity",
  description: [
    "WHAT: Resolves an organization name or ticker to an SEC-listed issuer (legal name, ticker, CIK) using SEC company ticker data. Never silently chooses between plausible matches.",
    "WHEN TO USE: First call for any company. Use before get_profile, get_financials, get_8k_events, or get_filing_sections. Absence from SEC data does not mean an entity is private or non-public; it only means it is not an SEC ticker-listed issuer.",
    "PARAMETERS: name (string) - company name or ticker, e.g. 'Salesforce, Inc.' or 'CRM'.",
    "RETURNS: {status, data:{query, resolution: 'unique'|'ambiguous'|'not_found_in_SEC', match?, alternatives[], sec_listed, annual_filing_available?}, sources[], diagnostics?}. When resolution is 'ambiguous', ask the user to choose; do not pick for them. Network: contacts sec.gov.",
  ].join("\n"),
  inputSchema: z.object({
    name: z.string().min(1).max(200).describe("Company name or ticker to resolve"),
  }),
};

export async function handler({ name }) {
  const sources = new Sources();
  let t;
  try {
    t = await secJson(TICKERS_URL);
  } catch (e) {
    return error(e.code || "sec_unreachable", `Could not retrieve SEC company ticker data: ${e.message}`);
  }
  const srcId = sources.add({
    url: TICKERS_URL,
    title: "SEC company tickers",
    publisher: "U.S. Securities and Exchange Commission",
    retrieved_at: t.retrieved_at,
  });
  const entities = groupByCik(Object.values(t.json));
  const matches = matchEntities(name, entities);

  if (matches.length === 0) {
    return noData(
      { query: name, resolution: "not_found_in_SEC", sec_listed: false, alternatives: [] },
      sources.list(),
      {
        code: "not_found_in_SEC",
        reason:
          "No SEC ticker-listed issuer matched this name. This does not show the organization is private or non-public; it may be a subsidiary, a foreign issuer without a US listing, a government body, or a different legal name.",
      }
    );
  }

  const top = matches[0];
  const second = matches[1];
  const clearWinner = top.score >= 95 && (!second || second.score < 95);
  const toOut = (m) => ({
    legal_name: m.legal_name,
    tickers: m.tickers,
    cik: m.cik,
    sec_listed: true,
    match_basis: m.match_basis,
    source_id: srcId,
  });

  if (!clearWinner) {
    return ok(
      {
        query: name,
        resolution: "ambiguous",
        sec_listed: true,
        alternatives: matches.slice(0, 8).map(toOut),
      },
      sources.list(),
      {
        reason:
          matches.length > 1
            ? "More than one plausible SEC issuer matches. Ask the user which entity they mean before continuing."
            : "Only a partial name match was found. Confirm with the user that this is the intended entity before continuing.",
      }
    );
  }

  const data = { query: name, resolution: "unique", sec_listed: true, match: toOut(top), alternatives: [] };
  const diagnostics = {};
  try {
    const sub = await getSubmissions(top.cik);
    if (sub) {
      const subSrc = sources.add({
        url: sub.url,
        title: `SEC submissions for ${top.legal_name}`,
        publisher: "U.S. Securities and Exchange Commission",
        retrieved_at: sub.retrieved_at,
      });
      const annual = latestAnnualFiling(sub);
      data.annual_filing_available = Boolean(annual);
      data.match.source_id_submissions = subSrc;
      if (!annual) {
        diagnostics.code = "no_annual_filing";
        diagnostics.reason = "The resolved CIK has no usable annual filing (10-K/20-F/40-F) in its recent filing list.";
        const first = coreName(top.legal_name).split(" ")[0];
        const related = entities
          .filter((e) => e.cik !== top.cik && first && coreName(e.legal_name).split(" ")[0] === first)
          .slice(0, 5)
          .map(toOut);
        if (related.length) {
          data.alternatives = related;
          diagnostics.reason +=
            " Possible related SEC entities found by name similarity are listed in alternatives; they are unverified.";
        }
      }
    }
  } catch (e) {
    diagnostics.partial = true;
    diagnostics.reason = `Could not verify annual filing availability: ${e.message}`;
  }
  return ok(data, sources.list(), Object.keys(diagnostics).length ? diagnostics : undefined);
}
