// Runs the smoke matrix against real public services and writes test-companies.md.
// Labels: PASS, PARTIAL, FAIL, PASS (correct no-data), BLOCKED (network), NOT PERFORMED.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../src/lib/config.js";
import * as resolve from "../src/tools/resolve_entity.js";
import * as profile from "../src/tools/get_profile.js";
import * as fin from "../src/tools/get_financials.js";
import * as ev from "../src/tools/get_8k_events.js";
import * as sections from "../src/tools/get_filing_sections.js";
import * as news from "../src/tools/search_news.js";
import * as page from "../src/tools/fetch_page.js";
import * as local from "../src/tools/read_local_docs.js";
import * as feedback from "../src/tools/feedback.js";

const CASES = [
  { name: "Salesforce, Inc.", kind: "public (software)", expect: "unique" },
  { name: "Apple Inc.", kind: "public (consumer hardware)", expect: "unique" },
  { name: "Johnson & Johnson", kind: "public (healthcare)", expect: "unique" },
  { name: "Delta Air Lines", kind: "public (airline)", expect: "unique" },
  { name: "JPMorgan Chase", kind: "public (bank)", expect: "unique" },
  { name: "Mercury", kind: "materially ambiguous name", expect: "ambiguous" },
  { name: "Cargill", kind: "private company", expect: "not_found_in_SEC" },
  { name: "Los Angeles Unified School District", kind: "government entity (school district)", expect: "not_found_in_SEC" },
];

const short = (s, n = 90) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const blockedCodes = new Set(["rate_limited", "network_error", "timeout", "sec_unreachable", "news_unavailable"]);
const isBlocked = (r) => r.status === "error" && blockedCodes.has(r.diagnostics?.code);

function grade(r, { requires = [], noDataOk = false, partialIf } = {}) {
  if (isBlocked(r)) return ["BLOCKED (network)", short(r.diagnostics?.reason)];
  if (r.status === "error") return ["FAIL", `${r.diagnostics?.code}: ${short(r.diagnostics?.reason)}`];
  if (r.status === "no_data") return noDataOk ? ["PASS (correct no-data)", short(r.diagnostics?.reason ?? r.diagnostics?.code)] : ["FAIL", `unexpected no_data: ${short(r.diagnostics?.reason)}`];
  const missing = requires.filter((k) => !k(r));
  if (missing.length || partialIf?.(r)) return ["PARTIAL", short(partialIf?.(r) || "required fields missing")];
  return ["PASS", ""];
}

const rows = [];
const add = (entity, tool, [label, note], sample) => {
  rows.push({ entity, tool, label, note, sample });
  console.error(`${label.padEnd(24)} ${tool.padEnd(22)} ${entity}`);
};
const np = (entity, tool, why) => add(entity, tool, ["NOT PERFORMED", why], "");

let newsBlocked = false;
for (const c of CASES) {
  const r = await resolve.handler({ name: c.name });
  const res = r.data?.resolution;
  const matches = res === c.expect;
  add(c.name, "resolve_entity", matches ? ["PASS", ""] : isBlocked(r) ? grade(r) : ["FAIL", `expected ${c.expect}, got ${res}`], res === "unique" ? `${r.data.match.legal_name} / ${r.data.match.tickers.slice(0, 2)} / CIK ${r.data.match.cik}` : res === "ambiguous" ? r.data.alternatives.slice(0, 3).map((a) => a.legal_name).join("; ") : "no SEC match");
  const cik = res === "unique" ? r.data.match.cik : null;
  if (!cik) {
    for (const t of ["get_profile", "get_financials", "get_8k_events", "get_filing_sections", "fetch_page"]) np(c.name, t, res === "ambiguous" ? "user must choose an entity first (by design)" : "not an SEC ticker-listed issuer");
  } else {
    const p = await profile.handler({ cik });
    add(c.name, "get_profile", grade(p, { requires: [(x) => x.data.description, (x) => x.data.headquarters] , partialIf: (x) => (!x.data.employees ? "employee count not extracted" : null) }), p.data?.description ? short(p.data.description.text, 110) : "");
    const f = await fin.handler({ cik });
    add(c.name, "get_financials", grade(f, { requires: [(x) => x.data.metrics?.revenue], partialIf: (x) => (x.diagnostics?.omitted_fields?.length ? `omitted: ${x.diagnostics.omitted_fields.join(",")}` : null) }), (f.data?.display_rows || []).map((x) => `${x.metric} ${x.value}${x.change ? " " + x.change : ""}`).join(" | "));
    const e = await ev.handler({ cik, days: 180 });
    add(c.name, "get_8k_events", grade(e, { noDataOk: true }), e.data?.filings ? `${e.data.filings.length} filings, ${e.data.recognized_count} with recognised items` : "");
    const b = await sections.handler({ cik, section: "business", max_chars: 1500 });
    add(c.name, "get_filing_sections", grade(b, { requires: [(x) => x.data.text?.length > 500] }), b.data?.located_section ? `${b.data.located_section}, ${b.data.total_chars} chars` : "");
    const eo = await sections.handler({ cik, section: "executive_officers", max_chars: 800 });
    add(c.name, "get_filing_sections (executive_officers)", grade(eo, { noDataOk: true }), eo.status === "ok" ? `found ${eo.data.total_chars} chars` : "not in 10-K text (proxy likely)");
    const url = e.data?.filings?.[0]?.filing_url;
    if (url) {
      const pg = await page.handler({ url, max_chars: 1000 });
      add(c.name, "fetch_page", grade(pg, { requires: [(x) => x.data.text?.length > 100] }), short(pg.data?.title));
    } else np(c.name, "fetch_page", "no 8-K URL available to fetch");
  }
  if (newsBlocked) np(c.name, "search_news", "skipped after earlier rate-limit to respect GDELT");
  else {
    const n = await news.handler({ query: c.name.replace(/,.*$/, ""), mode: "recent_90d", max_results: 5 });
    const g = grade(n, { noDataOk: true });
    if (g[0].startsWith("BLOCKED")) newsBlocked = true;
    add(c.name, "search_news", g, n.data?.articles ? `${n.data.articles.length} articles` : "");
  }
}

const d = await local.handler({});
add("(demo folder)", "read_local_docs", grade(d, { requires: [(x) => x.data.documents.some((y) => y.is_fictional_demo)] }), d.data?.documents?.map((x) => x.filename).join(", "));
const t = await local.handler({ folder: "../" });
add("(traversal ../)", "read_local_docs", t.status === "error" ? ["PASS", "rejected"] : ["FAIL", "traversal accepted"], "");
const fr = await feedback.handler({ action: "read" });
add("(feedback.md)", "feedback", grade(fr, { noDataOk: true }), "read only (no rows written during smoke)");
np("(all)", "export_pdf", "covered by `npm test` and the Salesforce end-to-end run, not by this smoke matrix");

const date = new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const counts = rows.reduce((m, r) => ((m[r.label] = (m[r.label] || 0) + 1), m), {});
let md = `# Smoke test results\n\nTest date: ${date}. Generated by \`npm run smoke\` from real runs against public services; nothing here is hand-edited.\n\nLabels: **PASS**; **PARTIAL** (worked, but required fields were missing); **FAIL** (extraction or logic failure); **PASS (correct no-data)** (the tool correctly reported that nothing exists); **BLOCKED (network)** (rate limit or connectivity; not a code verdict); **NOT PERFORMED** (not run; never counted as PASS).\n\nSummary: ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("; ")}.\n\n`;
for (const c of CASES) {
  md += `## ${c.name} — ${c.kind}\n\n| Tool | Result | Notes |\n|---|---|---|\n`;
  for (const r of rows.filter((x) => x.entity === c.name)) md += `| ${r.tool} | ${r.label} | ${esc([r.sample, r.note].filter(Boolean).join(" — "))} |\n`;
  md += "\n";
}
md += `## Cross-cutting\n\n| Tool | Result | Notes |\n|---|---|---|\n`;
for (const r of rows.filter((x) => x.entity.startsWith("("))) md += `| ${r.tool} (${r.entity}) | ${r.label} | ${esc([r.sample, r.note].filter(Boolean).join(" — "))} |\n`;
await fs.writeFile(path.join(ROOT, "test-companies.md"), md);
console.error(`\nWrote test-companies.md. ${JSON.stringify(counts)}`);
