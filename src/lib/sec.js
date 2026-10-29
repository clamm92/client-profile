import { cached } from "./cache.js";
import { decodeBody, safeRequest, FetchError } from "./http.js";

export const padCik = (cik) => String(cik).replace(/\D/g, "").padStart(10, "0");
export const stripCik = (cik) => String(Number(String(cik).replace(/\D/g, "")));

export function validateCik(cik) {
  const digits = String(cik ?? "").replace(/\D/g, "");
  if (!digits || digits.length > 10 || !/^\d+$/.test(String(cik).trim())) {
    throw new FetchError("cik must be a numeric SEC Central Index Key (up to 10 digits).", "invalid_cik");
  }
  return padCik(digits);
}

/** Fetch JSON from sec.gov (rate-limited, User-Agent applied by safeRequest). Cached 24h. */
export async function secJson(url, { maxBytes = 60 * 1024 * 1024 } = {}) {
  const { value } = await cached(
    `SECJSON ${url}`,
    async () => {
      const res = await safeRequest(url, { maxBytes, headers: { accept: "application/json" } });
      if (res.status === 404) return { status: 404 };
      if (res.status < 200 || res.status >= 300) {
        throw new FetchError(`SEC returned HTTP ${res.status}.`, "sec_http_error");
      }
      return { status: res.status, retrieved_at: new Date().toISOString(), json: JSON.parse(decodeBody(res.body)) };
    },
    (v) => v.status === 200
  );
  return value;
}

export async function secText(url, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const { value } = await cached(
    `SECTEXT ${url}`,
    async () => {
      const res = await safeRequest(url, { maxBytes });
      if (res.status < 200 || res.status >= 300) {
        throw new FetchError(`SEC returned HTTP ${res.status}.`, "sec_http_error");
      }
      return {
        status: res.status,
        retrieved_at: new Date().toISOString(),
        contentType: String(res.headers["content-type"] || ""),
        text: decodeBody(res.body, String(res.headers["content-type"] || "")),
      };
    },
    (v) => v.status === 200
  );
  return value;
}

export async function getSubmissions(cik) {
  const padded = validateCik(cik);
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const r = await secJson(url);
  if (r.status === 404) return null;
  return { url, retrieved_at: r.retrieved_at, json: r.json };
}

export function recentFilings(submissions) {
  const r = submissions?.filings?.recent;
  if (!r?.accessionNumber) return [];
  return r.accessionNumber.map((accession, i) => ({
    accession,
    form: r.form[i],
    filingDate: r.filingDate[i],
    reportDate: r.reportDate?.[i] || null,
    primaryDocument: r.primaryDocument?.[i] || null,
    items: r.items?.[i] || "",
    primaryDocDescription: r.primaryDocDescription?.[i] || null,
  }));
}

export function filingDocUrl(cik, f) {
  const acc = f.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${stripCik(cik)}/${acc}/${f.primaryDocument}`;
}

export function filingIndexUrl(cik, f) {
  const acc = f.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${stripCik(cik)}/${acc}/`;
}

export const ANNUAL_FORMS = ["10-K", "10-K405", "10-KT", "20-F", "40-F"];

export function latestAnnualFiling(submissions) {
  return recentFilings(submissions.json).find((f) => ANNUAL_FORMS.includes(f.form) && f.primaryDocument) || null;
}
