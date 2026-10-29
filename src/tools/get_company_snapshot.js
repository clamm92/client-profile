import { z } from "zod/v4";
import { fromException, noData } from "../lib/envelope.js";
import * as profile from "./get_profile.js";
import * as financials from "./get_financials.js";
import * as events from "./get_8k_events.js";

export const definition = {
  name: "get_company_snapshot",
  description: [
    "WHAT: Convenience aggregate that calls get_profile, get_financials and get_8k_events for one SEC filer and returns their results side by side, unchanged. Each part keeps its own status, source IDs, sources and diagnostics; nothing is merged, re-scored or reinterpreted.",
    "WHEN TO USE: To save round trips for a SEC-listed company after resolve_entity. Running it does not oblige you to show every part. Use the individual tools if you need only one part.",
    "PARAMETERS: cik (string, SEC CIK); days (integer, default 180) - 8-K look-back window.",
    "RETURNS: {status, data:{profile:<get_profile envelope>, financials:<get_financials envelope>, events:<get_8k_events envelope>}, sources:[], diagnostics?}. Top-level status is 'ok' if any part is 'ok', 'no_data' if none returned data, 'error' if every part errored. Source IDs (S1, S2...) are scoped to their own part. Network: contacts sec.gov.",
  ].join("\n"),
  inputSchema: z.object({
    cik: z.string().min(1).max(10).describe("SEC Central Index Key"),
    days: z.number().int().min(1).max(1095).default(180).optional(),
  }),
};

export async function handler({ cik, days = 180 }) {
  try {
    // Sequential on purpose: all three share the SEC rate limiter and 24h cache.
    const p = await profile.handler({ cik });
    const f = await financials.handler({ cik });
    const e = await events.handler({ cik, days });
    const statuses = [p.status, f.status, e.status];
    const status = statuses.includes("ok") ? "ok" : statuses.every((s) => s === "error") ? "error" : "no_data";
    if (status === "no_data") return noData({ profile: p, financials: f, events: e }, []);
    return { status, data: { profile: p, financials: f, events: e }, sources: [], diagnostics: { note: "Source IDs are scoped to each part." } };
  } catch (err) {
    return fromException(err);
  }
}
