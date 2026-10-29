import path from "node:path";
import * as fontkit from "fontkit";
import { ROOT } from "../config.js";

/**
 * Embedded fonts: Noto Sans (SIL Open Font License 1.1), via @fontsource/noto-sans.
 * The package ships one file per script subset, so each character is routed to the first
 * subset that has a glyph for it. Characters with no glyph in any subset (for example CJK or
 * emoji) are reported as unsupported instead of being silently replaced.
 */
export const FONT_LICENSE = "SIL Open Font License 1.1 (Noto Sans)";
const SUBSETS = ["latin", "latin-ext", "vietnamese", "greek", "cyrillic"];
const FILE_DIR = path.join(ROOT, "node_modules", "@fontsource", "noto-sans", "files");

const cache = new Map();

export function fontFile(subset, bold) {
  return path.join(FILE_DIR, `noto-sans-${subset}-${bold ? 700 : 400}-normal.woff`);
}

export function fontName(subset, bold) {
  return `noto-${subset}-${bold ? "b" : "r"}`;
}

function load(subset, bold) {
  const key = fontName(subset, bold);
  if (!cache.has(key)) cache.set(key, fontkit.openSync(fontFile(subset, bold)));
  return cache.get(key);
}

export function allFontRegistrations() {
  const out = [];
  for (const s of SUBSETS) for (const b of [false, true]) out.push({ name: fontName(s, b), file: fontFile(s, b) });
  return out;
}

/**
 * Split a string into pieces, each assigned to one font.
 * Returns {pieces, unsupported:Set<string>}. An unsupported character is measured and drawn as
 * "?" only so layout can finish; export_pdf refuses to write the PDF when any are present.
 */
export function segment(str, bold) {
  const pieces = [];
  const unsupported = new Set();
  let cur = null;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    let chosen = null;
    for (const s of SUBSETS) {
      if (load(s, bold).hasGlyphForCodePoint(cp)) {
        chosen = fontName(s, bold);
        break;
      }
    }
    let text = ch;
    if (!chosen) {
      unsupported.add(ch);
      chosen = fontName("latin", bold);
      text = "?";
    }
    if (cur && cur.font === chosen) cur.str += text;
    else {
      cur = { font: chosen, str: text };
      pieces.push(cur);
    }
  }
  return { pieces, unsupported };
}

const fontByName = new Map();
function byName(name) {
  if (!fontByName.has(name)) {
    const m = /^noto-(.+)-(r|b)$/.exec(name);
    fontByName.set(name, load(m[1], m[2] === "b"));
  }
  return fontByName.get(name);
}

export function widthOf(fontNameStr, str, size) {
  if (!str) return 0;
  const f = byName(fontNameStr);
  return (f.layout(str).advanceWidth * size) / f.unitsPerEm;
}
