import "../src/lib/config.js";
import * as t from "../src/tools/resolve_entity.js";

const names = process.argv.slice(2);
for (const n of names) {
  const r = await t.handler({ name: n });
  const d = r.data;
  console.log(
    n,
    "=>",
    r.status,
    d.resolution,
    d.match ? `${d.match.legal_name} ${d.match.tickers} ${d.match.cik} annual=${d.annual_filing_available}` : "",
    (d.alternatives || []).slice(0, 4).map((a) => `${a.legal_name}(${a.cik})`),
    r.diagnostics ? `diag=${r.diagnostics.code || ""}` : ""
  );
}
