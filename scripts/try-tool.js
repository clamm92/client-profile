import "../src/lib/config.js";

const [tool, ...args] = process.argv.slice(2);
const mod = await import(`../src/tools/${tool}.js`);
const input = {};
for (const a of args) {
  const i = a.indexOf("=");
  const k = a.slice(0, i);
  let v = a.slice(i + 1);
  if (/^-?\d+$/.test(v) && k !== "cik") v = Number(v);
  input[k] = v;
}
const r = await mod.handler(input);
const max = Number(process.env.MAXLEN || 3500);
const s = JSON.stringify(r, null, 1);
console.log(s.length > max ? s.slice(0, max) + `\n... [${s.length} chars total]` : s);
