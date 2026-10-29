import { z } from "zod/v4";
import { Sources, ok, noData, fromException, clean } from "../lib/envelope.js";
import { secJson, getSubmissions, recentFilings, filingDocUrl, filingIndexUrl, validateCik, stripCik } from "../lib/sec.js";

const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "SalesRevenueServicesNet",
];
const NET_INCOME_TAGS = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"];
const CASH_TAGS = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"];
const DEBT_TOTAL_TAGS = ["DebtLongtermAndShorttermCombinedAmount", "LongTermDebt"];
const DEBT_NONCURRENT = ["LongTermDebtNoncurrent"];
const DEBT_CURRENT = ["LongTermDebtCurrent", "DebtCurrent"];

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "20-F", "20-F/A", "40-F", "40-F/A"]);
const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MON[m - 1]} ${d}, ${y}`;
};

export function formatMoney(value, unit = "USD") {
  const sym = unit === "USD" ? "$" : "";
  const suffix = unit === "USD" ? "" : ` ${unit}`;
  const abs = Math.abs(value);
  let body;
  if (abs >= 1e9) body = `${(abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2).replace(/\.?0+$/, "")}B`;
  else if (abs >= 1e6) body = `${abs >= 1e8 ? Math.round(abs / 1e6) : (abs / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  else if (abs >= 1e3) body = `${Math.round(abs / 1e3)}K`;
  else body = String(Math.round(abs));
  return `${value < 0 ? "-" : ""}${sym}${body}${suffix}`;
}

export function formatPct(ratio) {
  const p = ratio * 100;
  return `${p >= 0 ? "+" : "-"}${Math.abs(p).toFixed(1)}%`;
}

/** Annual duration facts (about one fiscal year, covering 52/53-week years). Deduplicated per period, newest filing wins. */
export function annualDurationFacts(entries) {
  const byPeriod = new Map();
  for (const f of entries || []) {
    if (!ANNUAL_FORMS.has(f.form) || !f.start || !f.end) continue;
    const len = days(f.start, f.end);
    if (len < 350 || len > 380) continue;
    const k = `${f.start}|${f.end}`;
    const cur = byPeriod.get(k);
    if (!cur || (f.filed || "") > (cur.filed || "")) byPeriod.set(k, f);
  }
  return [...byPeriod.values()].sort((a, b) => b.end.localeCompare(a.end));
}

export function instantFacts(entries, end) {
  const hits = (entries || []).filter((f) => ANNUAL_FORMS.has(f.form) && !f.start && f.end === end);
  return hits.sort((a, b) => (b.filed || "").localeCompare(a.filed || ""))[0] || null;
}

function pickUnit(tagObj) {
  const units = tagObj?.units || {};
  if (units.USD) return ["USD", units.USD];
  const k = Object.keys(units).find((u) => /^[A-Z]{3}$/.test(u));
  return k ? [k, units[k]] : [null, []];
}

/** Choose the revenue tag with the most recent annual period; ties broken by tag priority. */
export function pickAnnualSeries(gaap, tags) {
  let best = null;
  tags.forEach((tag, priority) => {
    const [unit, entries] = pickUnit(gaap[tag]);
    const facts = annualDurationFacts(entries);
    if (!facts.length) return;
    const cand = { tag, unit, facts, priority };
    if (!best || cand.facts[0].end > best.facts[0].end) best = cand;
  });
  return best;
}

function priorComparable(facts, latest) {
  // same-length annual period ending about one year earlier (±20 days)
  return (
    facts.find((f) => {
      const gap = days(f.end, latest.end);
      return gap >= 345 && gap <= 385 && f.end < latest.end;
    }) || null
  );
}

export function computeDebt(gaap, end) {
  const total = [];
  for (const tag of DEBT_TOTAL_TAGS) {
    const [unit, entries] = pickUnit(gaap[tag]);
    const f = instantFacts(entries, end);
    if (f) return { kind: "total", tags: [tag], unit, value: f.val, facts: [f] };
    total.push(tag);
  }
  for (const nc of DEBT_NONCURRENT) {
    const [u1, e1] = pickUnit(gaap[nc]);
    const f1 = instantFacts(e1, end);
    if (!f1) continue;
    for (const cur of DEBT_CURRENT) {
      const [u2, e2] = pickUnit(gaap[cur]);
      const f2 = instantFacts(e2, end);
      if (f2 && u1 === u2) {
        return { kind: "components", tags: [nc, cur], unit: u1, value: f1.val + f2.val, facts: [f1, f2] };
      }
    }
    return { kind: "incomplete", tags: [nc], reason: `Only the noncurrent portion (${nc}) was reported; the current portion is missing, so total debt was not computed.` };
  }
  return null;
}

export const definition = {
  name: "get_financials",
  description: [
    "WHAT: Returns annual financial metrics from SEC XBRL company facts: latest and prior fiscal-year revenue, revenue year-over-year change, net income, cash, and total debt (only when a reported total or a complete, non-overlapping pair of components exists). Periods are matched by dates, not the SEC 'fy' field.",
    "WHEN TO USE: After resolve_entity for a SEC-listed US-GAAP filer when a financial snapshot is wanted. Typically show only three to five metrics. Not for non-SEC entities.",
    "PARAMETERS: cik (string, SEC CIK from resolve_entity).",
    "RETURNS: {status, data:{currency, period_end, period_label, metrics:{revenue?, revenue_prior?, net_income?, cash?, total_debt?} each with {value, unit, start?, end, period_label, tags[], source_id, display, yoy?}, display_rows:[{metric, value, period, change?, source_id}]}, sources[], diagnostics?:{omitted_fields[], notes[]}}. Unavailable metrics are omitted from data and display_rows; reasons are in diagnostics only. Network: contacts sec.gov.",
  ].join("\n"),
  inputSchema: z.object({ cik: z.string().min(1).max(10).describe("SEC Central Index Key") }),
};

export async function handler({ cik }) {
  try {
    const padded = validateCik(cik);
    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
    const r = await secJson(factsUrl);
    if (r.status === 404) {
      return noData({}, [], { code: "no_xbrl_facts", reason: "SEC has no XBRL company facts for this CIK (for example a non-filer or a foreign issuer without XBRL)." });
    }
    const gaap = r.json.facts?.["us-gaap"];
    if (!gaap) {
      return noData({}, [], { code: "no_us_gaap_facts", reason: "No US-GAAP XBRL facts were found. IFRS filers are not supported by this tool." });
    }
    const sources = new Sources();
    const notes = [];
    const omitted = [];

    const rev = pickAnnualSeries(gaap, REVENUE_TAGS);
    const ni = pickAnnualSeries(gaap, NET_INCOME_TAGS);
    const anchor = rev?.facts[0] || ni?.facts[0];
    if (!anchor) {
      return noData({}, [], { code: "no_annual_metrics", reason: "No annual revenue or net income facts were found in XBRL data." });
    }

    // Link each metric to the human-readable filing document when we can identify it.
    const sub = await getSubmissions(padded).catch(() => null);
    const filings = sub ? recentFilings(sub.json) : [];
    const srcFor = (fact, label) => {
      const acc = fact.accn;
      const filing = filings.find((f) => f.accession === acc);
      const url = filing?.primaryDocument ? filingDocUrl(padded, filing) : `https://www.sec.gov/Archives/edgar/data/${stripCik(padded)}/${String(acc).replace(/-/g, "")}/`;
      return sources.add({
        url,
        title: `${r.json.entityName} ${fact.form || "annual report"} for period ending ${fact.end}`,
        publisher: "U.S. Securities and Exchange Commission",
        published_at: filing?.filingDate || fact.filed,
        retrieved_at: r.retrieved_at,
      });
    };

    const metrics = {};
    const rows = [];
    const periodLabel = `FY ended ${fmtDate(anchor.end)}`;

    const durationMetric = (series, name, fact) => ({
      value: fact.val,
      unit: series.unit,
      start: fact.start,
      end: fact.end,
      period_label: `FY ended ${fmtDate(fact.end)}`,
      tags: [series.tag],
      xbrl_filed: fact.filed,
      source_id: srcFor(fact),
      display: formatMoney(fact.val, series.unit),
    });

    if (rev) {
      const latest = rev.facts[0];
      const prior = priorComparable(rev.facts, latest);
      const m = durationMetric(rev, "revenue", latest);
      if (prior) {
        metrics.revenue_prior = durationMetric(rev, "revenue_prior", prior);
        if (prior.val > 0 && latest.val >= 0) m.yoy = { ratio: (latest.val - prior.val) / prior.val, display: formatPct((latest.val - prior.val) / prior.val), prior_period_end: prior.end };
        else notes.push("Revenue year-over-year change was not computed because the prior-period value is not positive.");
      } else {
        notes.push("No comparable prior-year revenue period was found, so no year-over-year change is provided.");
      }
      metrics.revenue = m;
      rows.push(clean({ metric: "Revenue", value: m.display, period: m.period_label, change: m.yoy?.display, source_id: m.source_id }));
    } else omitted.push("revenue");

    if (ni) {
      const latest = ni.facts.find((f) => f.end === anchor.end && f.start === (rev?.facts[0]?.start ?? f.start));
      if (latest) {
        const prior = priorComparable(ni.facts, latest);
        const m = durationMetric(ni, "net_income", latest);
        if (prior && prior.val > 0 && latest.val > 0) {
          const ratio = (latest.val - prior.val) / prior.val;
          m.yoy = { ratio, display: formatPct(ratio), prior_period_end: prior.end };
        } else if (prior) {
          notes.push("Net income change was not computed because it is only meaningful when both periods are positive.");
        }
        metrics.net_income = m;
        rows.push(clean({ metric: "Net income", value: m.display, period: m.period_label, change: m.yoy?.display, source_id: m.source_id }));
      } else {
        omitted.push("net_income");
        notes.push("Net income for the same period as revenue was not found.");
      }
    } else omitted.push("net_income");

    const cashSeries = CASH_TAGS.map((tag) => ({ tag, ...(() => { const [unit, e] = pickUnit(gaap[tag]); return { unit, fact: instantFacts(e, anchor.end) }; })() })).find((c) => c.fact);
    if (cashSeries) {
      const f = cashSeries.fact;
      metrics.cash = {
        value: f.val,
        unit: cashSeries.unit,
        end: f.end,
        period_label: `As of ${fmtDate(f.end)}`,
        tags: [cashSeries.tag],
        source_id: srcFor(f),
        display: formatMoney(f.val, cashSeries.unit),
      };
      if (cashSeries.tag !== CASH_TAGS[0]) notes.push("Cash includes restricted cash (cash-equivalents tag was not reported).");
      rows.push({ metric: "Cash", value: metrics.cash.display, period: metrics.cash.period_label, source_id: metrics.cash.source_id });
    } else omitted.push("cash");

    const debt = computeDebt(gaap, anchor.end);
    if (debt && debt.kind !== "incomplete") {
      metrics.total_debt = {
        value: debt.value,
        unit: debt.unit,
        end: anchor.end,
        period_label: `As of ${fmtDate(anchor.end)}`,
        tags: debt.tags,
        basis: debt.kind === "total" ? "reported total" : "sum of noncurrent and current components",
        source_id: srcFor(debt.facts[0]),
        display: formatMoney(debt.value, debt.unit),
      };
      rows.push({ metric: "Total debt", value: metrics.total_debt.display, period: metrics.total_debt.period_label, source_id: metrics.total_debt.source_id });
    } else {
      omitted.push("total_debt");
      if (debt?.reason) notes.push(debt.reason);
    }

    const currency = rev?.unit || ni?.unit || "USD";
    return ok(
      { currency, period_end: anchor.end, period_label: periodLabel, metrics, display_rows: rows },
      sources.list(),
      omitted.length || notes.length ? clean({ omitted_fields: omitted.length ? omitted : undefined, notes: notes.length ? notes : undefined }) : undefined
    );
  } catch (e) {
    return fromException(e);
  }
}
