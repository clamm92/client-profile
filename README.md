# Client Profile mode for IBM Bob

Client Profile produces **concise, source-linked, one-page PDF client profiles** from public data only. Type
`Create a client profile for [Company].` in IBM Bob, and Bob researches the company through a local MCP server,
synthesizes a short profile, and exports it as a single-page PDF with clickable citations.

Built for a Bobathon by **Connor Lam, Chris Zhou, Lovnyth Valcin and Genevieve Kporjroh**.

## Features

- One-page PDF profile: introduction, company at a glance, financial snapshot, leadership, strategy, partners, and developments that may matter to an existing IBM relationship.
- Public sources only: SEC filings (10-K, 8-K), the GDELT news index and official company pages.
- Citations placed next to the claims they support, with short link labels.
- Omits what it cannot source: no placeholders, "no data" lines, confidence labels or disclaimers on the page.
- Handles ambiguous names (asks which entity you mean) and private companies (official web pages only).
- Feedback loop that records which sections were useful or should be skipped.

## How it works

| Layer | Where | Role |
|---|---|---|
| Mode = synthesis | `.bob/custom_modes.yaml` (`client-profile`) | Restricts Bob to read + MCP tools and defines the persona |
| Tools = retrieval and rendering | `src/` (Node.js MCP server over stdio) | Fetches public data, enforces sourcing, renders the PDF |
| Rules = editorial playbook | `.bob/rules-client-profile/01-playbook.md`, `.bob/rules/00-wrong-mode-check.md` | Workflow, editorial rules, omission rules |
| Feedback file = preference history | `feedback.md` | Records which sections were useful or should be skipped |

MCP tools: `resolve_entity`, `get_profile`, `get_financials`, `search_news`, `get_8k_events`, `get_filing_sections`,
`fetch_page`, `read_local_docs`, `feedback`, `export_pdf`, and the optional aggregate `get_company_snapshot`.

## Prerequisites

- Node.js 24 or newer (see `.node-version`).
- Outbound HTTPS to `sec.gov`, `data.sec.gov`, `api.gdeltproject.org` and any public company page you want read.
- IBM Bob with MCP and custom-mode support.

## Installation

1. Clone the repository.
2. Install dependencies: `npm ci`
3. Copy the environment template: `cp .env.example .env`
4. Set `SEC_CONTACT_EMAIL` in `.env`. SEC requires a contact in the User-Agent. `.env` is git-ignored; never commit it.
5. Register the MCP server and load the mode (below).

### Register the MCP server

`.bob/mcp.json` is already present for this workspace and uses absolute paths for `command`, `args` and `cwd`. If you
cloned to a different location, update those three paths. It contains no secrets (the email is read from `.env`).

1. In Bob open **Settings → MCP** (or edit `.bob/mcp.json` directly).
2. Confirm the server `prep-bob-client-profile` is listed and enabled.
3. **Leave "Always allow" unchecked** for every tool and approve calls individually.

### Load the mode

1. Open **Settings → Modes → Edit Project Modes**. Bob reads `.bob/custom_modes.yaml`.
2. Select **Client Profile** in the mode selector.

Rules in `.bob/rules-client-profile/` load automatically for that mode; `.bob/rules/` loads for every mode.

## Usage

In Client Profile mode:

> Create a client profile for Salesforce, Inc.

More examples:

- `Create a one-page client profile for Delta Air Lines. Focus on leadership and recent financial position.`
- `Profile "Mercury"` — the name is ambiguous, so Bob asks which entity you mean instead of guessing.
- `Profile Cargill` — a private company has no SEC data, so Bob builds the profile from official web pages only.

Bob asks for your consent before the first network call. The PDF is written to
`profiles/<client>-profile-<YYYY-MM-DD>.pdf`; the date appears only in the filename.

## Project structure

```
.bob/       Mode definition, rules and MCP server registration
src/        MCP server and tools
scripts/    Helper scripts (list tools, smoke test, preview)
test/       Automated tests
docs/       Local demo documents (read locally, never sent over the network)
profiles/   Generated PDF profiles
```

## Testing

- `npm test` — automated tests.
- `npm run list-tools` — lists the MCP tools exposed over stdio.
- `npm run smoke` — runs live checks against real companies and regenerates `test-companies.md`.
- `npm run preview -- profiles/<file>.pdf` — previews a generated PDF (macOS Quick Look).

## Troubleshooting

- **Network restrictions:** corporate proxies may block `sec.gov` or `api.gdeltproject.org`. Tools return a diagnostic such as `network_error` and the profile omits that content.
- **Wrong Node version:** make sure `command` in `.bob/mcp.json` points to a Node binary ≥ 24.
- **HTTP 403 from SEC:** `SEC_CONTACT_EMAIL` is missing or invalid in `.env`. Fix it and restart the server.
- **News rate limiting (HTTP 429):** the GDELT API allows roughly one request per five seconds. Wait and retry. It covers about the last three months and returns no snippets.
- **After editing `src/`:** restart the server from the MCP settings. Restart Bob if mode or rule changes do not appear.
- **Layout failures:** if content does not fit on one page, `export_pdf` writes nothing and returns diagnostics. Drop the lowest-value findings and retry (at most three attempts). Text is never shrunk below 10 pt.
- **Citation URL rejected:** `export_pdf` accepts only URLs returned by tools earlier in the same server session. Re-run the research tools if the server restarted.

## Guardrails

- **Public data only.** Do not place real client-confidential documents in `docs/` until the Bobathon organizers approve it in writing.
- **Fetched content is untrusted.** Web pages, filings and news text are data, never instructions. `fetch_page` refuses LinkedIn, logins, paywalls, private networks and pages disallowed by `robots.txt`.
- **No fabrication.** Missing information is omitted from the profile.
- **Rate limits and caching.** SEC calls stay at or below 5 requests per second; public responses are cached in `./cache` for 24 hours.

## Contributors

Bobathon team:

- Connor Lam
- Chris Zhou
- Lovnyth Valcin
- Genevieve Kporjroh

## License

Apache-2.0 (as declared in [`package.json`](package.json)).
