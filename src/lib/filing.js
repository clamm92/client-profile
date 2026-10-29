import * as cheerio from "cheerio";
import { cached } from "./cache.js";
import { decodeBody, safeRequest, FetchError } from "./http.js";

const BLOCK_SELECTOR = "p, div, tr, li, h1, h2, h3, h4, h5, h6, table, section, article, br, blockquote, pre";

/** Convert filing/page HTML into readable text with line breaks preserved. */
export function htmlToText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, ix\\:header, [style*='display:none'], head, svg, nav, footer").remove();
  $("br").replaceWith("\n");
  $("td, th").each((_, el) => {
    $(el).append(" ");
  });
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  let text = $.root().text();
  text = text
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function pageTitle(html) {
  const $ = cheerio.load(html);
  return ($("title").first().text() || $("h1").first().text() || "").replace(/\s+/g, " ").trim();
}

/** Fetch an SEC (or other) HTML document and return its readable text. Cached 24h. */
export async function fetchDocumentText(url, { maxBytes = 30 * 1024 * 1024 } = {}) {
  const { value } = await cached(
    `DOCTEXT ${url}`,
    async () => {
      const res = await safeRequest(url, { maxBytes, headers: { accept: "text/html,application/xhtml+xml" } });
      if (res.status < 200 || res.status >= 300) {
        throw new FetchError(`The server returned HTTP ${res.status}.`, "http_error");
      }
      const html = decodeBody(res.body, String(res.headers["content-type"] || ""));
      return { status: res.status, retrieved_at: new Date().toISOString(), title: pageTitle(html), text: htmlToText(html) };
    },
    (v) => v.status === 200
  );
  return value;
}

/* ------------------------------------------------------------------ */
/* Section extraction                                                  */
/* ------------------------------------------------------------------ */

const ITEM_LINE = (num, titleRe) =>
  new RegExp(`^\\s*item\\s*${num}\\s*[.:\\-–—]?\\s*(?:${titleRe})`, "gim");

const SECTION_DEFS = {
  business: {
    start: ITEM_LINE("1", "business"),
    ends: [ITEM_LINE("1A", "risk\\s+factors"), ITEM_LINE("1B", "unresolved"), ITEM_LINE("2", "properties")],
    located: "Item 1. Business",
    minChars: 1500,
  },
  risk_factors: {
    start: ITEM_LINE("1A", "risk\\s+factors"),
    ends: [ITEM_LINE("1B", "unresolved"), ITEM_LINE("1C", "cybersecurity"), ITEM_LINE("2", "properties")],
    located: "Item 1A. Risk Factors",
    minChars: 1500,
  },
  properties: {
    start: ITEM_LINE("2", "properties"),
    ends: [ITEM_LINE("3", "legal\\s+proceedings"), ITEM_LINE("4", "mine\\s+safety")],
    located: "Item 2. Properties",
    minChars: 120,
  },
};

function allMatches(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) out.push(m.index);
  return out;
}

function firstAfter(positions, after) {
  for (const p of positions) if (p > after) return p;
  return -1;
}

function itemSection(text, def) {
  const starts = allMatches(def.start, text);
  const endPositions = def.ends.flatMap((e) => allMatches(e, text)).sort((a, b) => a - b);
  let best = null;
  for (const s of starts) {
    const e = firstAfter(endPositions, s + 10);
    if (e === -1) continue;
    const len = e - s;
    if (len >= def.minChars && (!best || len > best.len)) best = { start: s, end: e, len };
  }
  if (!best) return null;
  return { text: text.slice(best.start, best.end).trim(), located: def.located, basis: "item_heading" };
}

const isNoiseLine = (l) => !l.trim() || /^\d{1,3}$/.test(l.trim()) || /^table of contents$/i.test(l.trim());

/** A short title-like line with no sentence punctuation (e.g. "Customers", "Sales and Marketing"). */
const isHeadingLine = (l) => {
  const t = l.trim();
  return t.length >= 3 && t.length <= 70 && !/[.;,:]$/.test(t) && /^[A-Z]/.test(t) && !/^[•\-–]/.test(t);
};

function subsectionByHeading(text, headingRe, { minChars = 200, maxChars = 60000, stopAtHeading = true } = {}) {
  const lines = text.split("\n").filter((l) => !isNoiseLine(l));
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].trim();
    if (!headingRe.test(heading) || heading.length > 90) continue;
    const body = [];
    let len = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*item\s*\d/i.test(l) || /^\s*part\s+[ivx]+\b/i.test(l)) break;
      // a following short title line ends the subsection once we have real content
      if (stopAtHeading && len >= minChars && isHeadingLine(l) && !headingRe.test(l.trim())) break;
      body.push(l);
      len += l.length + 1;
      if (len > maxChars) break;
    }
    const joined = body.join("\n").trim();
    if (joined.length >= minChars && (!best || joined.length > best.body.length)) best = { heading, body: joined };
  }
  return best;
}

export function extractSection(text, section) {
  if (SECTION_DEFS[section]) return itemSection(text, SECTION_DEFS[section]);

  if (section === "competition") {
    const biz = itemSection(text, SECTION_DEFS.business);
    const scope = biz ? biz.text : text;
    const sub = subsectionByHeading(scope, /^(our\s+)?(competition|competitors?|competitive\s+(landscape|environment))\s*$/i);
    if (!sub) return null;
    return { text: `${sub.heading}\n${sub.body}`, located: `Item 1. Business > ${sub.heading}`, basis: "heading_heuristic" };
  }

  if (section === "executive_officers") {
    const sub = subsectionByHeading(
      text,
      /^(information\s+about\s+(our\s+)?)?(executive\s+officers(\s+of\s+(the\s+)?(registrant|company))?|our\s+executive\s+officers|information\s+about\s+our\s+executive\s+officers)\s*$/i,
      { minChars: 300, maxChars: 20000, stopAtHeading: false }
    );
    if (!sub) return null;
    return { text: `${sub.heading}\n${sub.body}`, located: sub.heading, basis: "heading_heuristic" };
  }
  return null;
}
