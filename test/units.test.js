import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, isPublicIp } from "../src/lib/http.js";
import { parseRobots, robotsAllows } from "../src/lib/robots.js";
import { escapeCell, parseRow } from "../src/tools/feedback.js";
import { matchEntities, groupByCik } from "../src/tools/resolve_entity.js";
import { annualDurationFacts, computeDebt, formatMoney, formatPct } from "../src/tools/get_financials.js";
import { parseItems, ITEM_CATEGORIES } from "../src/tools/get_8k_events.js";
import { extractSection } from "../src/lib/filing.js";
import { extractEmployees } from "../src/tools/get_profile.js";
import { classifySource, parseSeenDate } from "../src/tools/search_news.js";

test("SSRF guard blocks private, reserved, metadata and unsafe URLs", () => {
  for (const u of [
    "http://localhost/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    "http://metadata.google.internal/", "http://foo.internal/", "http://x.localhost/", "file:///etc/passwd", "ftp://example.com/",
    "http://user:pw@example.com/", "https://example.com:8443/", "http://0.0.0.0/", "http://100.64.0.1/",
  ]) assert.throws(() => assertSafeUrl(u), undefined, u);
  assert.doesNotThrow(() => assertSafeUrl("https://www.sec.gov/"));
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  assert.equal(isPublicIp("fd00::1"), false);
});

test("robots.txt parsing: longest match, allow wins ties, wildcard and $", () => {
  const g = parseRobots("User-agent: *\nDisallow: /\nAllow: /$\nAllow: /public/\nDisallow: /public/secret$\n");
  assert.equal(robotsAllows(g, "/"), true);
  assert.equal(robotsAllows(g, "/rss/search?q=x"), false);
  assert.equal(robotsAllows(g, "/public/a"), true);
  assert.equal(robotsAllows(g, "/public/secret"), false);
  const bot = parseRobots("User-agent: PrepBobClientProfile\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
  assert.equal(robotsAllows(bot, "/x"), false);
  assert.equal(robotsAllows([], "/x"), true);
});

test("feedback escaping neutralises Markdown delimiters and newlines", () => {
  const e = escapeCell("a | b\n| c *d* [l](u) `x` <b>");
  assert.ok(!/\n/.test(e));
  assert.ok(!/(^|[^\\])\|/.test(e));
  assert.deepEqual(parseRow("2026-01-01 | leadership | skip | a \\| b"), ["2026-01-01", "leadership", "skip", "a | b"]);
});

test("entity matching never silently picks among several issuers", () => {
  const ents = groupByCik([
    { cik_str: 1, ticker: "MCY", title: "MERCURY GENERAL CORP" },
    { cik_str: 2, ticker: "MRCY", title: "MERCURY SYSTEMS INC" },
    { cik_str: 3, ticker: "CRM", title: "Salesforce, Inc." },
  ]);
  const m = matchEntities("Mercury", ents);
  assert.equal(m.length, 2);
  assert.ok(m.every((x) => x.score < 95));
  assert.equal(matchEntities("Salesforce", ents)[0].score, 95);
  assert.equal(matchEntities("CRM", ents)[0].match_basis, "ticker_exact");
  assert.equal(matchEntities("Nonexistent Widgets", ents).length, 0);
});

test("financial period matching uses dates, not fy; debt never sums overlapping or missing parts", () => {
  const facts = annualDurationFacts([
    { form: "10-K", start: "2024-02-01", end: "2025-01-31", val: 1, filed: "2025-03-01", fy: 2024 },
    { form: "10-K", start: "2025-02-01", end: "2026-01-31", val: 2, filed: "2026-03-01", fy: 2024 },
    { form: "10-K", start: "2025-11-01", end: "2026-01-31", val: 9, filed: "2026-03-01", fy: 2025 },
    { form: "10-Q", start: "2025-02-01", end: "2026-01-31", val: 7, filed: "2026-03-01" },
  ]);
  assert.deepEqual(facts.map((f) => f.val), [2, 1]);
  const inst = (v) => ({ units: { USD: [{ form: "10-K", end: "2026-01-31", val: v, filed: "2026-03-01" }] } });
  assert.equal(computeDebt({ LongTermDebt: inst(10) }, "2026-01-31").value, 10);
  assert.equal(computeDebt({ LongTermDebtNoncurrent: inst(8), LongTermDebtCurrent: inst(2) }, "2026-01-31").value, 10);
  assert.equal(computeDebt({ LongTermDebtNoncurrent: inst(8) }, "2026-01-31").kind, "incomplete");
  assert.equal(computeDebt({}, "2026-01-31"), null);
  assert.equal(formatMoney(41525000000), "$41.5B");
  assert.equal(formatPct(0.0958), "+9.6%");
});

test("8-K item codes map to neutral categories only for recognised items", () => {
  assert.deepEqual(parseItems("5.02,9.01"), ["5.02", "9.01"]);
  assert.equal(ITEM_CATEGORIES["5.02"], "leadership/governance");
  assert.equal(ITEM_CATEGORIES["9.01"], undefined);
  for (const k of ["4.01", "4.02", "2.05", "1.05"]) assert.ok(ITEM_CATEGORIES[k]);
});

test("filing extraction rejects table-of-contents matches", () => {
  const toc = "Table of Contents\nItem 1. Business\n3\nItem 1A. Risk Factors\n9\nItem 2. Properties\n20\n";
  const body = "ITEM 1. BUSINESS\n" + "We make useful things for customers. ".repeat(80) + "\nITEM 1A. RISK FACTORS\n" + "Risk text. ".repeat(200) + "\nITEM 2. PROPERTIES\nWe lease offices in several cities and own a data center in a leased building as described here for investors.\nITEM 3. LEGAL PROCEEDINGS\n";
  const biz = extractSection(toc + body, "business");
  assert.ok(biz && biz.text.length > 1500 && biz.text.startsWith("ITEM 1. BUSINESS"));
  assert.equal(extractSection(toc, "business"), null);
  assert.equal(extractSection("no sections here", "executive_officers"), null);
});

test("news helpers: dates parsed from GDELT format; source types are hints only", () => {
  assert.equal(parseSeenDate("20261026T050000Z"), "2026-10-26T05:00:00Z");
  assert.equal(parseSeenDate("bad"), null);
  assert.equal(classifySource("www.prnewswire.com", "Salesforce"), "press_release_wire");
  assert.equal(classifySource("salesforce.com", "Salesforce, Inc."), "company_announcement");
  assert.equal(classifySource("randomblog.net", "Salesforce"), "unknown");
});

test("employee counts are extracted from common filing phrasings only", () => {
  assert.equal(extractEmployees("As of December 31, 2025, we had approximately 103,000 full-time employee equivalents.").count, 103000);
  assert.equal(extractEmployees("the Company had approximately 166,000 full-time equivalent employees.").count, 166000);
  assert.equal(extractEmployees("we had approximately 83,334 employees as of January 31, 2026").as_of, "January 31, 2026");
  assert.equal(extractEmployees("We value our employees and had many ideas."), null);
});
