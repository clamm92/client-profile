import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// quiet: true keeps dotenv from writing to stdout (stdout is the MCP protocol channel).
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const CACHE_DIR = path.join(ROOT, "cache");
export const PROFILES_DIR = path.join(ROOT, "profiles");
export const DOCS_DIR = path.join(ROOT, "docs");
export const FEEDBACK_FILE = path.join(ROOT, "feedback.md");
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class ConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** SEC requires a User-Agent that identifies the requester and a contact address. */
export function secUserAgent() {
  const email = (process.env.SEC_CONTACT_EMAIL || "").trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email !== "your.email@example.com";
  if (!valid) {
    throw new ConfigError(
      "SEC_CONTACT_EMAIL is not set. Copy .env.example to .env, set SEC_CONTACT_EMAIL to your own address, and restart the MCP server.",
      "sec_contact_email_missing"
    );
  }
  return `PrepBobClientProfile/0.1 (contact: ${email})`;
}

export const GENERIC_UA = "PrepBobClientProfile/0.1 (public-data research tool)";
