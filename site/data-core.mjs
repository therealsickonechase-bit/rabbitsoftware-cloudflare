// Pure helpers for data.html: build read-only requests to the public RabbitOS data hub. No DOM, no secrets, GET only.
export const API_ORIGIN = "https://app.rabbitsoftware.io";
export const MAX_LIMIT = 200;
export const FORMATS = ["json", "csv", "ndjson"];

const DATASET = /^[a-z_]{1,40}$/;
const COLUMN = /^-?[a-z_]{1,40}$/;

/** URL of one page of one dataset. Throws on anything that is not a plain dataset id or column name. */
export function datasetUrl(id, { q = "", limit = 25, cursor = "", sort = "", format = "json", download = false, filters = {} } = {}) {
  if (!DATASET.test(id)) throw new Error("bad dataset");
  const u = new URL(`/api/data/${id}`, API_ORIGIN);
  u.searchParams.set("limit", String(Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || 25))));
  if (q) u.searchParams.set("q", String(q).slice(0, 80));
  if (cursor) u.searchParams.set("cursor", String(cursor).slice(0, 64));
  if (sort) { if (!COLUMN.test(sort)) throw new Error("bad sort"); u.searchParams.set("sort", sort); }
  for (const [k, v] of Object.entries(filters)) { if (v && COLUMN.test(k) && !k.startsWith("-")) u.searchParams.set(k, String(v).slice(0, 120)); }
  if (format !== "json") { if (!FORMATS.includes(format)) throw new Error("bad format"); u.searchParams.set("format", format); }
  if (download) u.searchParams.set("download", "1");
  return u.toString();
}

export const manifestUrl = () => `${API_ORIGIN}/api/data`;
export const headUrl = () => `${API_ORIGIN}/api/chain/head`;

/** The command for the public CloudShell at app.rabbitsoftware.io/cloudshell-public. */
export function curlSnippet(id) {
  if (!DATASET.test(id)) throw new Error("bad dataset");
  return `curl -fsS "${API_ORIGIN}/api/data/${id}?limit=50" | jq`;
}

/** Text for a failed request. A TypeError from fetch means the network or CORS blocked it; the page cannot tell which. */
export function failureMessage(error, status) {
  if (status) return `The data hub answered ${status}. Try again in a moment.`;
  if (error instanceof TypeError) return "The data hub could not be reached. The API may be down, your connection may be offline, or the browser blocked the cross-origin request (CORS). The same data is on app.rabbitsoftware.io/data.";
  return "Something went wrong reading the data hub.";
}

/** Only http(s) links are shown as links. */
export const safeLink = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");

export const cellText = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
