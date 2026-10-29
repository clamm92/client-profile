import * as resolve_entity from "./resolve_entity.js";
import * as get_profile from "./get_profile.js";
import * as get_financials from "./get_financials.js";
import * as search_news from "./search_news.js";
import * as get_8k_events from "./get_8k_events.js";
import * as get_filing_sections from "./get_filing_sections.js";
import * as fetch_page from "./fetch_page.js";
import * as read_local_docs from "./read_local_docs.js";
import * as feedback from "./feedback.js";
import * as export_pdf from "./export_pdf.js";
import * as get_company_snapshot from "./get_company_snapshot.js";

export const tools = [
  resolve_entity,
  get_profile,
  get_financials,
  search_news,
  get_8k_events,
  get_filing_sections,
  fetch_page,
  read_local_docs,
  feedback,
  export_pdf,
  get_company_snapshot,
];
