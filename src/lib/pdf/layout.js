import { segment, widthOf } from "./fonts.js";

/** Typography and page geometry. Body text is never set below MIN_BODY_PT. */
export const MIN_BODY_PT = 10;
export const PAGE = { width: 612, height: 792, left: 42, right: 42, top: 38, bottom: 36 };
export const CONTENT_WIDTH = PAGE.width - PAGE.left - PAGE.right;
export const AVAILABLE_HEIGHT = PAGE.height - PAGE.top - PAGE.bottom;

export const STYLE = {
  title: { size: 20, lineH: 25 },
  intro: { size: 10.5, lineH: 14.5 },
  body: { size: MIN_BODY_PT, lineH: 13.5 },
  heading: { size: 11.5, lineH: 15 },
};

export const COLORS = {
  text: "#1f2328",
  muted: "#57606a",
  accent: "#3b82d4",
  link: "#0b5cad",
  rule: "#d0d7de",
  headBg: "#f3f5f8",
};

const PAD_X = 5;
const PAD_Y = 3;

/** Turn runs [{text,bold,link,color,nobreak}] into measured atoms (unbreakable words). */
function toAtoms(runs, size, unsupported) {
  const atoms = [];
  let cur = null;
  let pendingSpace = false;
  const flush = () => {
    if (cur) {
      atoms.push(cur);
      cur = null;
    }
  };
  const addText = (text, run) => {
    const seg = segment(text, Boolean(run.bold));
    seg.unsupported.forEach((c) => unsupported.add(c));
    if (!cur) {
      cur = { pieces: [], width: 0, spaceBefore: pendingSpace };
      pendingSpace = false;
    }
    for (const p of seg.pieces) {
      const w = widthOf(p.font, p.str, size);
      cur.pieces.push({ ...p, w, link: run.link, color: run.color });
      cur.width += w;
    }
  };
  for (const run of runs) {
    if (!run.text) continue;
    if (run.nobreak) {
      if (/^\s/.test(run.text)) {
        flush();
        pendingSpace = true;
      }
      addText(run.text.trim(), run);
      if (/\s$/.test(run.text)) {
        flush();
        pendingSpace = true;
      }
      continue;
    }
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        flush();
        pendingSpace = true;
      } else addText(part, run);
    }
  }
  flush();
  return atoms;
}

/** Break an atom wider than the line into chunks so very long names wrap safely. */
function splitWide(atom, maxW, size) {
  if (atom.width <= maxW) return [atom];
  const out = [];
  let cur = { pieces: [], width: 0, spaceBefore: atom.spaceBefore };
  const push = (p, str, w) => {
    cur.pieces.push({ ...p, str, w });
    cur.width += w;
  };
  for (const p of atom.pieces) {
    let buf = "";
    let bw = 0;
    for (const ch of p.str) {
      const cw = widthOf(p.font, ch, size);
      if (cur.width + bw + cw > maxW && (buf || cur.pieces.length)) {
        if (buf) push(p, buf, bw);
        out.push(cur);
        cur = { pieces: [], width: 0, spaceBefore: false };
        buf = "";
        bw = 0;
      }
      buf += ch;
      bw += cw;
    }
    if (buf) push(p, buf, bw);
  }
  if (cur.pieces.length) out.push(cur);
  return out;
}

/**
 * Lay out runs inside a width. Returns drawing ops positioned at (x, y), the line count, the
 * height, the widest line and the widest single unbreakable word (used for table column sizing).
 */
export function layoutRuns(runs, { x = 0, y = 0, width, size, lineH, color = COLORS.text, unsupported = new Set() }) {
  const raw = toAtoms(runs, size, unsupported);
  const atoms = raw.flatMap((a) => splitWide(a, width, size));
  const spaceW = widthOf("noto-latin-r", " ", size);
  const lines = [];
  let line = [];
  let lineW = 0;
  let maxAtom = 0;
  for (const a of atoms) {
    maxAtom = Math.max(maxAtom, a.width);
    const gap = line.length && a.spaceBefore ? spaceW : 0;
    if (line.length && lineW + gap + a.width > width + 0.01) {
      lines.push({ atoms: line, width: lineW });
      line = [];
      lineW = 0;
    }
    const g = line.length && a.spaceBefore ? spaceW : 0;
    line.push({ atom: a, gap: g });
    lineW += g + a.width;
  }
  if (line.length) lines.push({ atoms: line, width: lineW });
  const ops = [];
  let maxLineWidth = 0;
  lines.forEach((ln, i) => {
    maxLineWidth = Math.max(maxLineWidth, ln.width);
    let cx = x;
    const top = y + i * lineH + (lineH - size * 1.25) / 2;
    for (const { atom, gap } of ln.atoms) {
      cx += gap;
      for (const p of atom.pieces) {
        ops.push({ t: "text", x: cx, y: top, font: p.font, size, color: p.link ? COLORS.link : p.color || color, str: p.str, w: p.w, link: p.link });
        cx += p.w;
      }
    }
  });
  return { ops, lineCount: lines.length, height: lines.length * lineH, maxLineWidth, maxAtom };
}

const linkRuns = (links = []) => links.map((l) => ({ text: ` ${l.label}`, link: l.url, nobreak: true }));

function shift(ops, dy) {
  for (const o of ops) {
    if (o.t === "line") {
      o.y1 += dy;
      o.y2 += dy;
    } else o.y += dy;
  }
  return ops;
}

function layoutTable(table, x, y, width, ctx) {
  const n = table.columns.length;
  const cellRuns = (ri, ci) => {
    const row = table.rows[ri];
    const runs = [{ text: row.cells[ci] }];
    if (ci === n - 1) runs.push(...linkRuns(row.links));
    return runs;
  };
  const measure = (runs, bold) => layoutRuns(runs.map((r) => ({ ...r, bold })), { width: 1e6, ...STYLE.body, unsupported: ctx.unsupported });
  const minW = new Array(n).fill(0);
  const natW = new Array(n).fill(0);
  table.columns.forEach((c, ci) => {
    const m = measure([{ text: c }], true);
    minW[ci] = Math.max(minW[ci], m.maxAtom);
    natW[ci] = Math.max(natW[ci], m.maxLineWidth);
  });
  table.rows.forEach((_, ri) => {
    for (let ci = 0; ci < n; ci++) {
      const m = measure(cellRuns(ri, ci), false);
      minW[ci] = Math.max(minW[ci], m.maxAtom);
      natW[ci] = Math.max(natW[ci], m.maxLineWidth);
    }
  });
  const inner = width - n * 2 * PAD_X;
  const issues = [];
  let colW;
  const sumNat = natW.reduce((a, b) => a + b, 0);
  const sumMin = minW.reduce((a, b) => a + b, 0);
  if (sumNat <= inner) {
    colW = natW.map((w) => w + ((inner - sumNat) * w) / (sumNat || 1));
  } else if (sumMin <= inner) {
    const spare = inner - sumMin;
    const want = natW.map((w, i) => w - minW[i]);
    const sumWant = want.reduce((a, b) => a + b, 0) || 1;
    colW = minW.map((w, i) => w + (spare * want[i]) / sumWant);
  } else {
    issues.push({ issue: "table_too_wide", measured_value: Math.ceil(sumMin + n * 2 * PAD_X), allowed_value: Math.floor(width), detail: "Shorten the longest unbroken cell text or use fewer columns." });
    colW = minW.map((w) => (w * inner) / sumMin);
  }
  const ops = [];
  let cy = y;
  const colX = [];
  let cx = x;
  colW.forEach((w) => {
    colX.push(cx);
    cx += w + 2 * PAD_X;
  });
  const drawRow = (cells, bold, bg, rowIdx) => {
    const laid = cells.map((runs, ci) =>
      layoutRuns(runs.map((r) => ({ ...r, bold })), { x: colX[ci] + PAD_X, y: cy + PAD_Y, width: colW[ci], ...STYLE.body, color: bold ? COLORS.muted : COLORS.text, unsupported: ctx.unsupported })
    );
    const h = Math.max(...laid.map((l) => l.height)) + 2 * PAD_Y;
    if (bg) ops.push({ t: "rect", x, y: cy, w: width, h, fill: bg });
    laid.forEach((l, ci) => {
      ops.push(...l.ops);
      if (!bold && l.lineCount > 4) issues.push({ issue: "table_cell_too_long", measured_value: l.lineCount, allowed_value: 4, detail: `Row ${rowIdx + 1}, column "${table.columns[ci]}" wraps to ${l.lineCount} lines.` });
    });
    cy += h;
    ops.push({ t: "line", x1: x, y1: cy, x2: x + width, y2: cy, color: COLORS.rule, width: 0.5 });
  };
  drawRow(table.columns.map((c) => [{ text: c }]), true, COLORS.headBg, -1);
  table.rows.forEach((_, ri) => drawRow(table.columns.map((__, ci) => cellRuns(ri, ci)), false, null, ri));
  return { ops, height: cy - y, issues };
}

function layoutKv(kv, x, y, width, ctx) {
  const keyMeasure = kv.map((e) => layoutRuns([{ text: e.key, bold: true }], { width: 1e6, ...STYLE.body, unsupported: ctx.unsupported }));
  const keyW = Math.min(150, Math.max(70, Math.max(...keyMeasure.map((m) => m.maxLineWidth)) + 10));
  const ops = [];
  const issues = [];
  let cy = y;
  kv.forEach((e) => {
    const k = layoutRuns([{ text: e.key, bold: true }], { x, y: cy, width: keyW - 8, ...STYLE.body, color: COLORS.muted, unsupported: ctx.unsupported });
    const v = layoutRuns([{ text: e.value }, ...linkRuns(e.links)], { x: x + keyW, y: cy, width: width - keyW, ...STYLE.body, unsupported: ctx.unsupported });
    if (v.lineCount > 3) issues.push({ issue: "paragraph_too_long", measured_value: v.lineCount, allowed_value: 3, detail: `Value for "${e.key}" wraps to ${v.lineCount} lines.` });
    ops.push(...k.ops, ...v.ops);
    cy += Math.max(k.height, v.height) + 2;
  });
  return { ops, height: cy - y - 2, issues };
}

function layoutItems(items, x, y, width, ctx) {
  const ops = [];
  const issues = [];
  let cy = y;
  items.forEach((it) => {
    const b = layoutRuns([{ text: "•" }], { x: x + 2, y: cy, width: 10, ...STYLE.body, color: COLORS.accent, unsupported: ctx.unsupported });
    const t = layoutRuns([{ text: it.text }, ...linkRuns(it.links)], { x: x + 14, y: cy, width: width - 14, ...STYLE.body, unsupported: ctx.unsupported });
    if (t.lineCount > 3) issues.push({ issue: "paragraph_too_long", measured_value: t.lineCount, allowed_value: 3 });
    ops.push(...b.ops, ...t.ops);
    cy += t.height + 2.5;
  });
  return { ops, height: cy - y - 2.5, issues };
}

/** Full measurement pass. No I/O. */
export function buildLayout(input) {
  const ctx = { unsupported: new Set() };
  const ops = [];
  const issues = [];
  let y = PAGE.top;
  const x = PAGE.left;
  const W = CONTENT_WIDTH;

  const title = layoutRuns([{ text: input.client_name, bold: true }], { x, y, width: W, ...STYLE.title, unsupported: ctx.unsupported });
  ops.push(...title.ops);
  y += title.height + 3;
  ops.push({ t: "line", x1: x, y1: y, x2: x + W, y2: y, color: COLORS.accent, width: 1.5 });
  y += 8;

  const intro = layoutRuns([{ text: input.introduction.text }, ...linkRuns(input.introduction.links)], { x, y, width: W, ...STYLE.intro, unsupported: ctx.unsupported });
  if (intro.lineCount > 3) issues.push({ issue: "paragraph_too_long", section_id: "introduction", measured_value: intro.lineCount, allowed_value: 3 });
  ops.push(...intro.ops);
  y += intro.height + 4;

  const sectionHeights = [];
  for (const s of input.sections) {
    const start = y + 9;
    let cy = start;
    const head = layoutRuns([{ text: s.heading, bold: true, color: COLORS.text }], { x, y: cy, width: W, ...STYLE.heading, unsupported: ctx.unsupported });
    ops.push(...head.ops);
    cy += head.height + 1;
    ops.push({ t: "line", x1: x, y1: cy, x2: x + W, y2: cy, color: COLORS.rule, width: 0.75 });
    cy += 5;
    const blocks = [];
    if (s.kv?.length) blocks.push(layoutKv(s.kv, x, 0, W, ctx));
    if (s.table) blocks.push(layoutTable(s.table, x, 0, W, ctx));
    if (s.items?.length) blocks.push(layoutItems(s.items, x, 0, W, ctx));
    blocks.forEach((b, i) => {
      ops.push(...shift(b.ops, cy));
      b.issues.forEach((is) => issues.push({ section_id: s.id, ...is }));
      cy += b.height + (i < blocks.length - 1 ? 5 : 0);
    });
    sectionHeights.push({ section_id: s.id, height: Math.round((cy - start) * 10) / 10 });
    y = cy;
  }

  const limit = PAGE.height - PAGE.bottom;
  const fits = y <= limit + 0.01;
  const pages = Math.max(1, Math.ceil((y - PAGE.top) / AVAILABLE_HEIGHT));
  return { ops, issues, fits, pages, contentBottom: y, limit, overflow: Math.max(0, y - limit), sectionHeights, unsupported: [...ctx.unsupported] };
}
