// Renders a PDF to a PNG inside the workspace using macOS Quick Look (no extra dependencies).
// If Quick Look is unavailable, reports that visual inspection is blocked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/lib/config.js";

const pdf = process.argv[2];
if (!pdf) {
  console.error("usage: npm run preview -- profiles/<file>.pdf");
  process.exit(2);
}
const out = path.join(ROOT, "preview");
fs.mkdirSync(out, { recursive: true });
try {
  execFileSync("qlmanage", ["-t", "-s", "1400", "-o", out, path.resolve(ROOT, pdf)], { stdio: "ignore" });
  const png = path.join(out, path.basename(pdf) + ".png");
  if (!fs.existsSync(png)) throw new Error("no output");
  console.error(`Preview written: ${path.relative(ROOT, png)}`);
  console.log(path.relative(ROOT, png));
} catch {
  console.error("Visual inspection BLOCKED: macOS Quick Look (qlmanage) is not available here. Open the PDF manually.");
  process.exit(3);
}
