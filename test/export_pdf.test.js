import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportProfile } from "../src/tools/export_pdf.js";
import { safeSlug } from "../src/lib/pdf/render.js";
import { registerKnownUrl, isKnownUrl, clearKnownUrls } from "../src/lib/known-urls.js";
import { getDocumentProxy, extractText } from "unpdf";

const URL1 = "https://www.sec.gov/Archives/edgar/data/1/0001/example.htm";
const yes = () => true;
const link = (label = "10-K", url = URL1) => ({ label, url });
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "prepbob-"));

const base = (over = {}) => ({
  client_name: "Example Corp",
  introduction: { text: "Example Corp makes widgets for industrial customers worldwide.", links: [link()] },
  sections: [
    { id: "glance", heading: "Company at a glance", kv: [{ key: "Industry", value: "Industrial machinery" }] },
    { id: "fin", heading: "Financial snapshot", table: { columns: ["Metric", "Latest period"], rows: [{ cells: ["Revenue", "$1.2B (+4.0% YoY)"], links: [link()] }] } },
    { id: "strategy", heading: "Strategy", items: [{ text: "Expanding its service business.", links: [link()] }] },
  ],
  ...over,
});

async function run(input, opts = {}) {
  const outDir = opts.outDir || (await tmp());
  const r = await exportProfile(input, { outDir, knownUrl: yes, date: "2026-01-02", ...opts });
  return { r, outDir };
}
const issues = (r) => r.data.layout_issues?.map((i) => i.issue) ?? [];

async function pdfInfo(file) {
  const buf = await fs.readFile(file);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const text = (await extractText(pdf, { mergePages: true })).text;
  const urls = [];
  for (let i = 1; i <= pdf.numPages; i++) for (const a of await (await pdf.getPage(i)).getAnnotations()) if (a.url) urls.push(a.url);
  return { pages: pdf.numPages, text: Array.isArray(text) ? text.join("\n") : text, urls };
}

test("exports exactly one page with clickable source links and no raw URLs", async () => {
  const { r, outDir } = await run(base());
  assert.equal(r.status, "ok");
  assert.equal(r.data.fits, true);
  assert.equal(r.data.pages, 1);
  const info = await pdfInfo(path.join(outDir, path.basename(r.data.output_path)));
  assert.equal(info.pages, 1);
  assert.ok(info.urls.includes(URL1), "link annotation present");
  assert.ok(info.text.includes("10-K"));
  assert.ok(!/https?:\/\//.test(info.text), "no raw URL printed");
});

test("rejects overflow, writes nothing, and never reports stale output", async () => {
  const outDir = await tmp();
  const first = await run(base(), { outDir });
  assert.equal(first.r.status, "ok");
  const before = await fs.readdir(outDir);
  const long = base({
    sections: Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      heading: `Section ${i}`,
      table: { columns: ["A", "B"], rows: Array.from({ length: 8 }, (_, j) => ({ cells: [`Row ${j}`, "Some reasonably long descriptive cell text that takes space"] })) },
    })),
  });
  const { r } = await run(long, { outDir });
  assert.equal(r.status, "error");
  assert.equal(r.data.fits, false);
  assert.equal(r.data.output_path, undefined, "no stale path returned");
  assert.ok(issues(r).includes("page_overflow"));
  assert.deepEqual(await fs.readdir(outDir), before, "directory unchanged");
});

test("enforces 120-character bullet limit including citation labels", async () => {
  const text = "x".repeat(116);
  const { r } = await run(base({ sections: [{ id: "a", heading: "A", items: [{ text, links: [link("10-K")] }] }] }));
  assert.equal(r.status, "error");
  assert.ok(issues(r).includes("bullet_too_long"));
  const ok = await run(base({ sections: [{ id: "a", heading: "A", items: [{ text: "y".repeat(110), links: [link("10-K")] }] }] }));
  assert.equal(ok.r.status, "ok");
});

test("rejects missing values, placeholders and empty sections", async () => {
  for (const bad of ["", "—", "N/A", "null", "undefined", "not available", "No data", "none found", "not verified"]) {
    const { r } = await run(base({ sections: [{ id: "a", heading: "A", kv: [{ key: "Industry", value: bad || " " }] }] }));
    assert.equal(r.status, "error", `should reject "${bad}"`);
  }
  const empty = await run(base({ sections: [{ id: "a", heading: "A" }] }));
  assert.ok(issues(empty.r).includes("empty_section"));
  const emptyTable = await run(base({ sections: [{ id: "a", heading: "A", table: { columns: ["x", "y"], rows: [] } }] }));
  assert.equal(emptyTable.r.status, "error");
});

test("rejects category tags, confidence, dates, disclaimers, source/risk sections", async () => {
  const bads = [
    "[FACT] Revenue grew",
    "[INFERRED] likely",
    "[STATED] ok",
    "[USER] told us",
    "[ASSUMPTION] maybe",
    "High confidence in this claim",
    "Executive briefing for the team",
    "AI-generated summary",
    "Based on publicly available information only",
    "Prepared on 2026-01-02",
    "Visit https://example.com for more",
    "See www.example.com",
    "Retrieval failed for this section",
  ];
  for (const text of bads) {
    const { r } = await run(base({ sections: [{ id: "a", heading: "A", items: [{ text }] }] }));
    assert.equal(r.status, "error", `should reject: ${text}`);
  }
  for (const heading of ["Sources and confidence", "Risks and conversation starters", "Sources", "Red flags"]) {
    const { r } = await run(base({ sections: [{ id: "a", heading, items: [{ text: "Something specific happened." }] }] }));
    assert.equal(r.status, "error", `should reject heading: ${heading}`);
  }
});

test("rejects unsupported presentation fields", async () => {
  for (const extra of [{ confidence: "high" }, { tag: "FACT" }, { disclaimer: "x" }, { missing: ["a"] }, { prepared_on: "2026-01-01" }]) {
    const { r } = await run({ ...base(), ...extra });
    assert.equal(r.status, "error");
    assert.ok(issues(r).includes("unsupported_field"), JSON.stringify(extra));
  }
  const nested = base();
  nested.sections[0].confidence = "high";
  assert.equal((await run(nested)).r.status, "error");
});

test("introduction must be one or two concise sentences", async () => {
  const long = "word ".repeat(70).trim() + ".";
  assert.ok(issues((await run(base({ introduction: { text: long } }))).r).includes("introduction_too_long"));
  const three = "One thing. Two things. Three things.";
  assert.ok(issues((await run(base({ introduction: { text: three } }))).r).includes("introduction_too_long"));
});

test("only URLs returned by tools may be cited", async () => {
  clearKnownUrls();
  const outDir = await tmp();
  const blocked = await exportProfile(base(), { outDir, date: "2026-01-02" });
  assert.equal(blocked.status, "error");
  assert.ok(issues(blocked).includes("uncited_url"));
  registerKnownUrl(URL1);
  assert.ok(isKnownUrl(URL1 + "/"), "trailing slash tolerated");
  const allowed = await exportProfile(base(), { outDir, date: "2026-01-02" });
  assert.equal(allowed.status, "ok");
  clearKnownUrls();
});

test("long company names wrap and unicode names render", async () => {
  const longName = "The International Association of Extremely Long Named Industrial and Commercial Manufacturing Holdings Corporation of North America";
  const { r, outDir } = await run(base({ client_name: longName }));
  assert.equal(r.status, "ok");
  assert.equal((await pdfInfo(path.join(outDir, path.basename(r.data.output_path)))).pages, 1);
  const unbroken = await run(base({ client_name: "A".repeat(150) }));
  assert.equal(unbroken.r.status, "ok");
  for (const name of ["Nestlé S.A.", "Société Générale", "Łódź Industries Sp. z o.o.", "Ελληνική Εταιρεία", "Российские Технологии", "Công ty Việt Nam"]) {
    const u = await run(base({ client_name: name }));
    assert.equal(u.r.status, "ok", name);
    const info = await pdfInfo(path.join(u.outDir, path.basename(u.r.data.output_path)));
    assert.ok(info.text.replace(/\s+/g, " ").includes(name.replace(/\s+/g, " ")), `text round-trips for ${name}`);
  }
});

test("characters with no glyph are reported, not silently corrupted", async () => {
  const { r, outDir } = await run(base({ client_name: "東京 Holdings" }));
  assert.equal(r.status, "error");
  assert.ok(issues(r).includes("unsupported_characters"));
  assert.deepEqual(await fs.readdir(outDir), []);
});

test("safe filenames and output containment", async () => {
  assert.equal(safeSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(safeSlug("A/B\\C:D*E?"), "a-b-c-d-e");
  assert.equal(safeSlug("   "), "client");
  assert.equal(safeSlug("CON"), "con-co");
  assert.equal(safeSlug("Nestlé & Co."), "nestle-and-co");
  const outDir = await tmp();
  const { r } = await run(base({ client_name: "../../escape" }), { outDir });
  assert.equal(r.status, "ok");
  const files = await fs.readdir(outDir);
  assert.deepEqual(files, ["escape-profile-2026-01-02.pdf"]);
});

test("same-day export overwrites atomically and leaves no temp files", async () => {
  const outDir = await tmp();
  await run(base(), { outDir });
  const second = await run(base({ introduction: { text: "Example Corp builds widgets.", links: [link()] } }), { outDir });
  assert.equal(second.r.status, "ok");
  const files = await fs.readdir(outDir);
  assert.equal(files.length, 1);
  assert.ok(!files.some((f) => f.endsWith(".tmp")));
});

test("refuses to write through a symlink", async () => {
  const outDir = await tmp();
  const victim = path.join(await tmp(), "victim.txt");
  await fs.writeFile(victim, "keep");
  await fs.symlink(victim, path.join(outDir, "example-corp-profile-2026-01-02.pdf"));
  const { r } = await run(base(), { outDir });
  assert.equal(r.status, "error");
  assert.equal(await fs.readFile(victim, "utf8"), "keep");
});

test("visible page text has no date, banner or disclaimer", async () => {
  const { r, outDir } = await run(base());
  const info = await pdfInfo(path.join(outDir, path.basename(r.data.output_path)));
  assert.ok(!/20\d\d-\d\d-\d\d/.test(info.text));
  assert.ok(!/client profile|executive briefing|disclaimer|generated|confidence/i.test(info.text));
});

test("input size limits are validated", async () => {
  const { r } = await run(base({ client_name: "x".repeat(500) }));
  assert.equal(r.status, "error");
  const many = await run(base({ sections: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, heading: "H", items: [{ text: "ok" }] })) }));
  assert.equal(many.r.status, "error");
});

test("accepts sector, industry context and a Role-based partners table with row links; rejects confidence columns and ratings", async () => {
  const URL2 = "https://www.crn.com/news/example";
  const rel = (columns, cells) => ({
    id: "relationships",
    heading: "Partners, competitors, and IBM",
    table: { columns, rows: [{ cells, links: [link("CRN", URL2)] }] },
  });
  const good = base({
    sections: [
      { id: "glance", heading: "Company at a glance", kv: [{ key: "Sector", value: "Private sector" }, { key: "Industry", value: "Prepackaged software" }] },
      { id: "industry", heading: "Industry context", items: [{ text: "Competition spans packaged software vendors and AI-native startups.", links: [link()] }] },
      rel(["Organization", "Role", "Publicly reported relationship"], ["IBM Consulting", "Partner", "Named a 2027 Partner of the Year, reported 2026-09-28"]),
    ],
  });
  const { r, outDir } = await run(good);
  assert.equal(r.status, "ok", JSON.stringify(r.data.layout_issues));
  const info = await pdfInfo(path.join(outDir, path.basename(r.data.output_path)));
  assert.equal(info.pages, 1);
  assert.ok(info.text.includes("Private sector"));
  assert.ok(info.urls.includes(URL2), "row link in the relationships table is clickable");

  const bad = await run(base({ sections: [rel(["Organization", "Role", "Confidence"], ["IBM Consulting", "Partner", "medium"])] }));
  assert.equal(bad.r.status, "error");
  assert.ok(issues(bad.r).includes("disallowed_visible_content"));
  const rating = await run(base({ sections: [rel(["Organization", "Role", "Relationship"], ["IBM Consulting", "Partner", "low"])] }));
  assert.equal(rating.r.status, "error");
  assert.ok(issues(rating.r).includes("disallowed_visible_content"));
});
