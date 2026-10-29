import fs from "node:fs/promises";
import { z } from "zod/v4";
import { ok, noData, error, fromException } from "../lib/envelope.js";
import { FEEDBACK_FILE } from "../lib/config.js";

export const FEEDBACK_SECTIONS = [
  "introduction",
  "company_at_a_glance",
  "financial_snapshot",
  "leadership",
  "strategy_and_recent_direction",
  "partners_competitors_ibm",
  "developments_affecting_ibm_relationship",
];
export const RATINGS = ["useful", "skip"];
const HEADER = "date | section | rating | note";
const MAX_NOTE = 300;

export const definition = {
  name: "feedback",
  description: [
    "WHAT: A simple file-based feedback loop (not machine learning). 'save' appends one row to feedback.md; 'read' returns per-section tallies of 'useful' and 'skip' ratings.",
    "WHEN TO USE: 'read' before choosing and sizing profile sections; 'save' after the user says which sections were useful or should be omitted. Feedback influences selection and space allocation only. It never overrides sourcing requirements, the opening company introduction, the facts-to-interpretation order, or the one-page limit. A section rated 'skip' need not appear in future profiles.",
    `PARAMETERS: action ('save'|'read'); section (required for save; one of ${FEEDBACK_SECTIONS.join(", ")}); rating (required for save; 'useful'|'skip'); note (optional, up to ${MAX_NOTE} chars).`,
    "RETURNS: save -> {status, data:{saved:{date, section, rating, note}}}. read -> {status, data:{tallies:{<section>:{useful, skip}}, total_rows, recent_notes[]}}. Network: none; reads/writes ./feedback.md.",
  ].join("\n"),
  inputSchema: z.object({
    action: z.enum(["save", "read"]),
    section: z.enum(FEEDBACK_SECTIONS).optional(),
    rating: z.enum(RATINGS).optional(),
    note: z.string().max(MAX_NOTE).optional(),
  }),
};

/** Make a value safe for a single pipe-delimited Markdown row. */
export function escapeCell(s) {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[`*_<>\[\]#]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRow(line) {
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      cur += line[i + 1];
      i++;
    } else if (line[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += line[i];
  }
  cells.push(cur.trim());
  return cells;
}

async function readRows() {
  let text = "";
  try {
    text = await fs.readFile(FEEDBACK_FILE, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== HEADER)
    .map(parseRow)
    .filter((c) => c.length >= 3 && FEEDBACK_SECTIONS.includes(c[1]) && RATINGS.includes(c[2]))
    .map(([date, section, rating, note = ""]) => ({ date, section, rating, note }));
}

export async function handler({ action, section, rating, note }) {
  try {
    if (action === "save") {
      if (!section || !rating) return error("missing_fields", "save requires both section and rating.");
      if (!FEEDBACK_SECTIONS.includes(section) || !RATINGS.includes(rating)) return error("invalid_value", "Unknown section or rating.");
      const row = { date: new Date().toISOString().slice(0, 10), section, rating, note: escapeCell(note || "") };
      let exists = true;
      try {
        await fs.access(FEEDBACK_FILE);
      } catch {
        exists = false;
      }
      const line = `${row.date} | ${row.section} | ${row.rating} | ${row.note}\n`;
      await fs.appendFile(FEEDBACK_FILE, (exists ? "" : HEADER + "\n") + line, "utf8");
      return ok({ saved: row });
    }
    const rows = await readRows();
    const tallies = Object.fromEntries(FEEDBACK_SECTIONS.map((s) => [s, { useful: 0, skip: 0 }]));
    for (const r of rows) tallies[r.section][r.rating]++;
    const data = { tallies, total_rows: rows.length, recent_notes: rows.filter((r) => r.note).slice(-5) };
    if (!rows.length) return noData(data, [], { reason: "No feedback has been saved yet." });
    return ok(data);
  } catch (e) {
    return fromException(e);
  }
}
