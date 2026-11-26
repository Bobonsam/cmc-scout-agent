// CMC Scout Agent — thin CoinMarketCap REST client (agent-written, 23 Nov 2026).
//
// Two modes, same response shape (per CMC keyless docs, read 23 Nov 2026):
//   - keyless: base https://pro-api.coinmarketcap.com/public-api, no header.
//     Only the 18 standard + 17 DEX endpoints listed on the keyless page.
//   - keyed:   base https://pro-api.coinmarketcap.com, header X-CMC_PRO_API_KEY.
//     Full Pro + DEX catalog. Key comes ONLY from env CMC_API_KEY, never
//     from a file that gets committed.
//
// Known keyless coverage (verified against the docs page + live calls):
//   /v2/simple/price, /v3/cryptocurrency/listings/latest,
//   /v3/cryptocurrency/quotes/latest, /v2/cryptocurrency/info,
//   /v1/cryptocurrency/map, /v1/global-metrics/quotes/latest,
//   /v3/fear-and-greed/latest, /v4/dex/pairs/quotes/latest,
//   /v1/dex/search, /v1/dex/token
// NOT in the keyless list: /v1/cryptocurrency/listings/new — the
// new_listings tool therefore uses listings/latest sorted by date_added
// as a prototype stand-in, and must switch to listings/new once the
// campaign key is in place (see newListings() below).

const KEYLESS_BASE = "https://pro-api.coinmarketcap.com/public-api";
const KEYED_BASE = "https://pro-api.coinmarketcap.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CmcClient {
  constructor({ apiKey = process.env.CMC_API_KEY || "", fetchFn = fetch } = {}) {
    this.apiKey = (apiKey || "").trim();
    this.base = this.apiKey ? KEYED_BASE : KEYLESS_BASE;
    this.mode = this.apiKey ? "keyed" : "keyless";
    this.fetchFn = fetchFn;
    this.lastCreditCount = null;
  }

  async get(path, params = {}, tries = 5) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { Accept: "application/json" };
    if (this.apiKey) headers["X-CMC_PRO_API_KEY"] = this.apiKey;
    for (let i = 0; i < tries; i++) {
      const res = await this.fetchFn(url.toString(), { headers });
      if (res.status === 429 && i < tries - 1) {
        await sleep(2 ** i * 1000); // docs-recommended exponential backoff
        continue;
      }
      const body = await res.json();
      if (!res.ok || String(body?.status?.error_code) !== "0") {
        const msg = body?.status?.error_message || `HTTP ${res.status}`;
        throw new Error(`CMC ${path} failed: ${msg}`);
      }
      if (typeof body?.status?.credit_count === "number") {
        this.lastCreditCount = body.status.credit_count;
      }
      return body.data;
    }
    throw new Error(`CMC ${path} failed: retries exhausted`);
  }

  // --- standard endpoints (all keyless-capable) ---
  simplePrice(symbols, convert = "USD") {
    return this.get("/v2/simple/price", { symbol: symbols, convert });
  }

  listingsLatest({ start = 1, limit = 100, convert = "USD", sort = "market_cap", sort_dir = "desc" } = {}) {
    return this.get("/v3/cryptocurrency/listings/latest", { start, limit, convert, sort, sort_dir });
  }

  quotesLatest(symbols, convert = "USD") {
    return this.get("/v3/cryptocurrency/quotes/latest", { symbol: symbols, convert });
  }

  coinInfo(symbols) {
    return this.get("/v2/cryptocurrency/info", { symbol: symbols });
  }

  coinMap({ symbol } = {}) {
    return this.get("/v1/cryptocurrency/map", symbol ? { symbol } : {});
  }

  globalMetrics(convert = "USD") {
    return this.get("/v1/global-metrics/quotes/latest", { convert });
  }

  fearGreed() {
    return this.get("/v3/fear-and-greed/latest");
  }

  // --- DEX endpoints (keyless-capable) ---
  dexPairQuote({ network_id, contract_address }) {
    return this.get("/v4/dex/pairs/quotes/latest", { network_id, contract_address });
  }

  dexSearch(keyword) {
    return this.get("/v1/dex/search", { keyword });
  }

  dexToken({ platform, address }) {
    return this.get("/v1/dex/token", { platform, address });
  }

  // --- listings/new: keyed-only (not on the keyless list). In keyless
  // mode this falls back to listings/latest sorted by date_added, and
  // the result is flagged so callers (and the README) stay honest.
  async newListings({ start = 1, limit = 20, convert = "USD" } = {}) {
    if (this.apiKey) {
      const data = await this.get("/v1/cryptocurrency/listings/new", { start, limit, convert });
      return { source: "listings/new", items: data };
    }
    const data = await this.listingsLatest({ start, limit, convert, sort: "date_added", sort_dir: "desc" });
    return { source: "listings/latest?sort=date_added (keyless stand-in)", items: data };
  }
}
