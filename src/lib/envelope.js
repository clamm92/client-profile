import { registerUrlsFrom } from "./known-urls.js";

/**
 * Shared tool contract:
 * { status: "ok" | "no_data" | "error", data, sources: [...], diagnostics? }
 * No confidence fields. Diagnostics are for orchestration and developers only and
 * must never be copied into a client profile.
 */

export class Sources {
  constructor() {
    this.items = [];
    this.byKey = new Map();
  }

  /** Register a source; identical URLs share one ID. Returns the source ID. */
  add({ url = null, title, publisher, published_at, retrieved_at, kind }) {
    const key = url || `${kind || "src"}:${title}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `S${this.items.length + 1}`;
    this.items.push(
      clean({
        id,
        url,
        title,
        publisher,
        published_at,
        retrieved_at: retrieved_at || new Date().toISOString(),
        kind,
      })
    );
    this.byKey.set(key, id);
    return id;
  }

  list() {
    return this.items;
  }
}

export function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export const ok = (data, sources = [], diagnostics) =>
  clean({ status: "ok", data, sources, diagnostics });

export const noData = (data, sources = [], diagnostics) =>
  clean({ status: "no_data", data: data ?? {}, sources, diagnostics });

export const error = (code, reason, extra = {}) => ({
  status: "error",
  data: {},
  sources: [],
  diagnostics: { code, reason, ...extra },
});

export function toToolResult(envelope) {
  registerUrlsFrom(envelope);
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: envelope.status === "error",
  };
}

/** Convert unexpected exceptions into a human-readable error envelope (no stack traces). */
export function fromException(err) {
  const code = err?.code && typeof err.code === "string" ? err.code : "tool_failed";
  const reason = err instanceof Error ? err.message : String(err);
  return error(code, reason);
}
