// CMC Scout Agent — MCP server (agent-written, 23 Nov 2026).
// Exposes live CoinMarketCap data as tools for any MCP client:
//   top_movers, new_listings, coin_quote, dex_pair_check, market_mood,
//   natural_language_screener, risk_score
// Transport: stdio (standard for MCP servers). Run: `npm run mcp`.
// Handlers are exported as `toolHandlers` so they can be tested without
// the MCP transport (see test/smoke.mjs).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CmcClient } from "./cmc-client.js";
import { naturalLanguageScreen, riskScoreSymbols } from "./screener.js";

const client = new CmcClient();

function pickQuote(c, convert = "USD") {
  // v3 shape: quote is an ARRAY [{symbol:"USD", price, ...}];
  // simple-price shape: quotes is an array with the same layout;
  // keyed v1/v2 shape: quote is an object keyed by convert.
  let q;
  if (Array.isArray(c.quote)) q = c.quote.find((x) => x.symbol === convert);
  else if (c.quote) q = c.quote[convert];
  if (!q && Array.isArray(c.quotes)) q = c.quotes.find((x) => x.symbol === convert);
  if (!q) return {};
  return {
    price_usd: q.price,
    market_cap_usd: q.market_cap,
    volume_24h_usd: q.volume_24h,
    change_1h_pct: q.percent_change_1h,
    change_24h_pct: q.percent_change_24h,
    change_7d_pct: q.percent_change_7d,
  };
}

function coinSummary(c, convert = "USD") {
  return {
    id: c.id,
    name: c.name,
    symbol: c.symbol,
    slug: c.slug,
    date_added: c.date_added,
    ...pickQuote(c, convert),
  };
}

export const toolHandlers = {
  async top_movers({ limit = 10, direction = "gainers" }) {
    const n = Math.min(Math.max(limit, 1), 100);
    const list = await client.listingsLatest({ limit: 100, sort: "percent_change_24h", sort_dir: direction === "losers" ? "asc" : "desc" });
    return {
      direction,
      count: n,
      coins: list.slice(0, n).map((c) => coinSummary(c)),
      mode: client.mode,
    };
  },

  async new_listings({ limit = 10 }) {
    const n = Math.min(Math.max(limit, 1), 50);
    const { source, items } = await client.newListings({ limit: n });
    return {
      source,
      count: items.length,
      coins: items.map((c) => coinSummary(c)),
      mode: client.mode,
    };
  },

  async coin_quote({ symbols, convert = "USD" }) {
    const data = await client.quotesLatest(symbols, convert);
    const all = Array.isArray(data) ? data : Object.values(data ?? {});
    // Keyless v3 quotes/latest can return a broad array; keep only the
    // symbols asked for (case-insensitive) so the tool answers the question.
    const wanted = symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const seen = new Set();
    const coins = all.filter((c) => {
      const sym = String(c.symbol).toUpperCase();
      if (!wanted.includes(sym) || seen.has(sym)) return false;
      seen.add(sym);
      return true;
    });
    return {
      convert,
      coins: (coins.length ? coins : all.slice(0, wanted.length)).map((c) => coinSummary(c, convert)),
      mode: client.mode,
    };
  },

  async dex_pair_check({ network_id, contract_address }) {
    const data = await client.dexPairQuote({ network_id, contract_address });
    const pairs = Array.isArray(data) ? data : [data];
    return {
      network_id,
      contract_address,
      pairs: pairs.map((p) => ({
        pair: p.pair ?? p.name,
        base_symbol: p.base_token?.symbol ?? p.base_symbol,
        quote_symbol: p.quote_token?.symbol ?? p.quote_symbol,
        price_usd: p.price_usd ?? p.price,
        liquidity_usd: p.liquidity_usd ?? p.liquidity,
        volume_24h_usd: p.volume_24h_usd ?? p.volume_24h,
        txns_24h: p.txns_24h,
      })),
      mode: client.mode,
    };
  },

  async natural_language_screener({ query, limit = 10, scan_limit = 200, convert = "USD" }) {
    return naturalLanguageScreen(client, { query, limit, scan_limit, convert });
  },

  async risk_score({ symbols, convert = "USD" }) {
    return riskScoreSymbols(client, { symbols, convert });
  },

  async market_mood({ convert = "USD" }) {
    const [metrics, fg] = await Promise.all([
      client.globalMetrics(convert),
      client.fearGreed(),
    ]);
    const q = metrics.quote?.[convert] ?? {};
    return {
      total_market_cap_usd: q.total_market_cap,
      total_volume_24h_usd: q.total_volume_24h,
      // Dominance lives at the top level of the metrics payload, not inside quote.
      btc_dominance_pct: metrics.btc_dominance,
      eth_dominance_pct: metrics.eth_dominance,
      active_cryptocurrencies: metrics.active_cryptocurrencies,
      fear_and_greed: {
        value: fg.value,
        classification: fg.value_classification,
        updated: fg.update_time,
      },
      mode: client.mode,
    };
  },
};

const server = new McpServer({ name: "cmc-scout-agent", version: "0.1.0" });

server.tool(
  "top_movers",
  "Top gainers or losers by 24h percent change (CMC listings, top 100 by market cap).",
  { limit: z.number().int().min(1).max(100).default(10), direction: z.enum(["gainers", "losers"]).default("gainers") },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.top_movers(args), null, 2) }] }),
);

server.tool(
  "new_listings",
  "Newest-listed cryptocurrencies. Keyless mode uses listings sorted by date_added; keyed mode uses the real listings/new endpoint.",
  { limit: z.number().int().min(1).max(50).default(10) },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.new_listings(args), null, 2) }] }),
);

server.tool(
  "coin_quote",
  "Latest price, market cap, volume and 1h/24h/7d changes for one or more symbols (e.g. BTC,ETH).",
  { symbols: z.string().min(1), convert: z.string().default("USD") },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.coin_quote(args), null, 2) }] }),
);

server.tool(
  "dex_pair_check",
  "Price, liquidity and 24h volume of a DEX pool by chain network id and pool contract address.",
  { network_id: z.number().int(), contract_address: z.string().min(1) },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.dex_pair_check(args), null, 2) }] }),
);

server.tool(
  "natural_language_screener",
  "Screen CMC listings from a natural-language request. The deterministic parser returns the exact filters and CMC API query it used; results are ranked and explained from live CMC fields only.",
  { query: z.string().min(3), limit: z.number().int().min(1).max(50).default(10), scan_limit: z.number().int().min(1).max(500).default(200), convert: z.string().default("USD") },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.natural_language_screener(args), null, 2) }] }),
);

server.tool(
  "risk_score",
  "Transparent 0-100 market-structure risk score for symbols (higher = higher measured risk), with every component and CMC input returned. Not financial advice.",
  { symbols: z.string().min(1), convert: z.string().default("USD") },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.risk_score(args), null, 2) }] }),
);

server.tool(
  "market_mood",
  "Market briefing: total market cap, BTC/ETH dominance, active coins, and the CMC Fear & Greed index.",
  { convert: z.string().default("USD") },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await toolHandlers.market_mood(args), null, 2) }] }),
);

const isMain = process.argv[1]?.endsWith("mcp-server.js");
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`cmc-scout-agent MCP server running (mode: ${client.mode})`);
}
