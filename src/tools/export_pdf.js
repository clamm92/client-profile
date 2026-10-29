import path from "node:path";
import { z } from "zod/v4";
import { exportInputSchema, validateContent } from "../lib/pdf/validate.js";
import { buildLayout, MIN_BODY_PT } from "../lib/pdf/layout.js";
import { renderPdf, safeSlug, writeAtomic } from "../lib/pdf/render.js";
import { PROFILES_DIR, ROOT } from "../lib/config.js";
import { isKnownUrl } from "../lib/known-urls.js";
import { fromException } from "../lib/envelope.js";
import { FONT_LICENSE } from "../lib/pdf/fonts.js";

export const definition = {
  name: "export_pdf",
  description: [
    "WHAT: Renders a one-page client profile PDF locally (no network). Runs a measurement pass first; if the content does not fit on ONE page at body text of at least 10 pt, nothing is written and layout diagnostics are returned. Output: profiles/<safe-client-name>-profile-<YYYY-MM-DD>.pdf (the date appears only in the filename, never on the page). Same-day files are replaced atomically.",
    "WHEN TO USE: Once, after synthesis, with already-written final content. On fits:false, genuinely reduce content (drop lowest-value findings, redundant rows, secondary leaders, or shorten wording) and retry; at most three attempts. Never shrink text to force a fit. Content is never truncated or altered by this tool.",
    "PARAMETERS: client_name (string); introduction {text (one or two sentences, max ~60 words), links?[{label,url}]}; sections [{id, heading, kv?[{key,value,links?}], items?[{text,links?}] (each bullet <=120 visible characters including citation labels), table?{columns[], rows[{cells[], links?}]}}]. Links must use short labels (<=24 chars) and URLs that other tools returned in this session. No confidence, tag, disclaimer, date or missing-data fields; unsupported fields are rejected.",
    "RETURNS: {status, data:{fits, pages, output_path?, layout_issues?[{section_id?, issue, measured_value?, allowed_value?, detail?}]}, sources:[]}. status 'ok' only when fits is true and the file was written; otherwise status 'error' with fits:false and no output_path. Network: none.",
  ].join("\n"),
  inputSchema: exportInputSchema,
};

const fail = (data, code, reason) => ({ status: "error", data: { fits: false, pages: data.pages ?? 0, layout_issues: data.layout_issues }, sources: [], diagnostics: { code, reason } });

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function exportProfile(rawInput, { outDir = PROFILES_DIR, knownUrl = isKnownUrl, date = today() } = {}) {
  const parsed = exportInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const layout_issues = parsed.error.issues.slice(0, 20).map((i) => ({
      section_id: i.path[0] === "sections" && typeof i.path[1] === "number" ? (rawInput?.sections?.[i.path[1]]?.id ?? `sections[${i.path[1]}]`) : String(i.path[0] ?? "input"),
      issue: i.code === "unrecognized_keys" ? "unsupported_field" : "invalid_input",
      detail: `${i.path.join(".") || "input"}: ${i.code === "unrecognized_keys" ? `unsupported field(s) ${i.keys?.join(", ")}` : i.message}`,
    }));
    return fail({ layout_issues }, "invalid_input", "The input does not match the presentation schema. Nothing was written.");
  }
  const input = parsed.data;
  const contentIssues = validateContent(input, { isKnownUrl: knownUrl });
  if (contentIssues.length) return fail({ layout_issues: contentIssues }, "content_rejected", "The content breaks presentation rules. Nothing was written; revise the flagged content.");

  const layout = buildLayout(input);
  if (layout.unsupported.length) {
    const layout_issues = [{ issue: "unsupported_characters", detail: `The embedded fonts have no glyph for: ${layout.unsupported.join(" ")}. Nothing was written so names are not corrupted.` }];
    return fail({ pages: layout.pages, layout_issues }, "unsupported_characters", "Some characters cannot be rendered faithfully.");
  }
  const layout_issues = [...layout.issues];
  if (!layout.fits) {
    layout_issues.unshift({ issue: "page_overflow", measured_value: Math.round(layout.contentBottom), allowed_value: Math.round(layout.limit), detail: `Content is ${Math.ceil(layout.overflow)} pt too tall for one page at ${MIN_BODY_PT} pt body text. Remove or shorten content; sections by height: ${layout.sectionHeights.map((s) => `${s.section_id}=${Math.round(s.height)}pt`).join(", ")}.` });
  }
  if (layout_issues.length) {
    return fail({ pages: layout.pages, layout_issues }, layout.fits ? "layout_rejected" : "overflow", layout.fits ? "The layout breaks presentation limits. Nothing was written." : "The content would not fit on one page. Nothing was written; no previous file was returned as the result.");
  }

  const buf = await renderPdf(layout.ops, { title: input.client_name });
  const filename = `${safeSlug(input.client_name)}-profile-${date}.pdf`;
  let written;
  try {
    written = await writeAtomic(outDir, filename, buf);
  } catch (e) {
    return fail({ pages: 1, layout_issues: [{ issue: "write_refused", detail: e.message }] }, "write_refused", "The PDF could not be written safely. Nothing was reported as exported.");
  }
  return { status: "ok", data: { fits: true, pages: 1, output_path: path.relative(ROOT, written).startsWith("..") ? written : path.relative(ROOT, written), font: FONT_LICENSE, body_font_pt: MIN_BODY_PT }, sources: [] };
}

export async function handler(input) {
  try {
    return await exportProfile(input);
  } catch (e) {
    return fromException(e);
  }
}
