import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { allFontRegistrations } from "./fonts.js";
import { PAGE } from "./layout.js";

/** Render pre-measured drawing ops to a PDF buffer. Always exactly one page. */
export function renderPdf(ops, { title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margin: 0,
      autoFirstPage: true,
      compress: true,
      info: { Title: title, Producer: "Prep Bob" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      for (const f of allFontRegistrations()) doc.registerFont(f.name, f.file);
      for (const op of ops) {
        if (op.t === "rect") {
          doc.save().rect(op.x, op.y, op.w, op.h).fill(op.fill).restore();
        } else if (op.t === "line") {
          doc.save().moveTo(op.x1, op.y1).lineTo(op.x2, op.y2).lineWidth(op.width).strokeColor(op.color).stroke().restore();
        } else if (op.t === "text") {
          doc.font(op.font).fontSize(op.size).fillColor(op.color);
          // lineBreak:false guarantees PDFKit never adds a page or re-wraps measured text.
          doc.text(op.str, op.x, op.y, { lineBreak: false, link: op.link, underline: Boolean(op.link), width: op.w + 2 });
        }
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Windows-reserved names and unsafe characters are removed; the result is a plain ASCII slug. */
export function safeSlug(name) {
  const slug = String(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const base = slug || "client";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(base) ? `${base}-co` : base;
}

/** Write atomically: temp file in the same directory, then rename. Verifies containment. */
export async function writeAtomic(dir, filename, buffer) {
  await fs.mkdir(dir, { recursive: true });
  const dirReal = await fs.realpath(dir);
  const target = path.join(dirReal, filename);
  if (path.dirname(target) !== dirReal || path.basename(target) !== filename) throw new Error("Output path escapes the profiles directory.");
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) throw new Error("Refusing to overwrite a symbolic link.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = path.join(dirReal, `.${filename}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, buffer, { flag: "wx", mode: 0o644 });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return target;
}
