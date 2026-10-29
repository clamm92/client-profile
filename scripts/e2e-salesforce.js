// End-to-end over real MCP stdio for Salesforce, Inc.
//   node scripts/e2e-salesforce.js                      -> research pass, writes .tmp/e2e-research.json
//   node scripts/e2e-salesforce.js .tmp/profile.json    -> same research calls (24h cache) in ONE session, then export_pdf
// Research and export share one server session because export_pdf only accepts citation URLs that
// tools returned in that session.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = process.argv[2];
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")], cwd: root, stderr: "pipe" });
let stderrText = "";
transport.stderr?.on("data", (d) => (stderrText += d));
const client = new Client({ name: "e2e", version: "0.1.0" });
await client.connect(transport);

const call = async (name, args) => {
  // GDELT calls can wait on the rate-limit gate and retries, so allow longer than the SDK's 60 s default.
  const r = await client.callTool({ name, arguments: args }, { timeout: 240000 });
  return JSON.parse(r.content[0].text);
};
const log = (...a) => console.error(...a);

const research = {};
const resolved = await call("resolve_entity", { name: "Salesforce, Inc." });
research.resolve_entity = resolved;
log("resolve_entity:", resolved.status, resolved.data.resolution, resolved.data.match?.legal_name, resolved.data.match?.cik);
const cik = resolved.data.match?.cik;
if (resolved.data.resolution !== "unique" || !cik) throw new Error("Salesforce did not resolve uniquely");

research.get_profile = await call("get_profile", { cik });
research.get_financials = await call("get_financials", { cik });
research.get_8k_events = await call("get_8k_events", { cik, days: 365 });
log("get_profile/get_financials/get_8k_events:", research.get_profile.status, research.get_financials.status, research.get_8k_events.status);

research.fetch_leadership = await call("fetch_page", { url: "https://www.salesforce.com/company/leadership/", max_chars: 4000 });
research.filing_competition = await call("get_filing_sections", { cik, section: "competition", max_chars: 3500 });
research.filing_business = await call("get_filing_sections", { cik, section: "business", max_chars: 5000 });
research.filing_exec_officers = await call("get_filing_sections", { cik, section: "executive_officers", max_chars: 500 });
research.feedback = await call("feedback", { action: "read" });

// Read the primary document of the most recent leadership-category 8-K(s) so details are supported.
const lead = (research.get_8k_events.data.filings || []).filter((f) => f.categories.includes("leadership/governance")).slice(0, 3);
research.leadership_8ks = [];
for (const f of lead) research.leadership_8ks.push({ filing_date: f.filing_date, items: f.items, page: await call("fetch_page", { url: f.filing_url, max_chars: 3500 }) });

const other = (research.get_8k_events.data.filings || []).filter((f) => !f.categories.length).slice(0, 2);
research.other_8ks = [];
for (const f of other) research.other_8ks.push({ filing_date: f.filing_date, items: f.items, page: await call("fetch_page", { url: f.filing_url, max_chars: 2500 }) });

// News (GDELT is rate-limited; results are cached for 24 h so repeated runs are cheap). Failures are recorded, not hidden.
research.news = {};
for (const mode of ["partners", "relationships", "recent_90d"]) {
  research.news[mode] = await call("search_news", { query: "Salesforce", mode, max_results: 10 });
  log(`search_news ${mode}:`, research.news[mode].status, research.news[mode].diagnostics?.code || "");
}
// Optional: article pages to read, chosen after reviewing the news results (.tmp/extra-urls.json = ["https://..."]).
research.extra_pages = [];
try {
  const extra = JSON.parse(await fs.readFile(path.join(root, ".tmp", "extra-urls.json"), "utf8"));
  for (const url of extra) research.extra_pages.push({ url, page: await call("fetch_page", { url, max_chars: 3500 }) });
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
await fs.writeFile(path.join(root, ".tmp", "e2e-research.json"), JSON.stringify(research, null, 1));
log("research written to .tmp/e2e-research.json");

let exitCode = 0;
if (profilePath) {
  const input = JSON.parse(await fs.readFile(path.resolve(root, profilePath), "utf8"));
  const exp = await call("export_pdf", input);
  console.log(JSON.stringify(exp, null, 1));
  if (exp.status !== "ok") exitCode = 1;
}
const nonProtocol = stderrText.split("\n").filter(Boolean).length;
log(`server stderr log lines: ${nonProtocol}`);
await client.close();
process.exit(exitCode);
