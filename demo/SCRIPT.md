# CMC Scout Agent — Demo Script (< 3 minutes)

Target runtime: **2:35**. Record the terminal/MCP client at readable speed. All market values in the final recording must come from the live run shown on screen; the bracketed values below are placeholders based on the verified 26 Nov 2026 evidence run and must be replaced if the recording run returns different values.

## 0:00–0:20 — Problem

**Narration:**
"Screening crypto markets usually means opening five dashboards, copying filters by hand, and then trusting a risk number nobody can explain. CMC Scout Agent puts live CoinMarketCap data directly in front of an AI agent through MCP — and shows its work."

**On screen:** README title + the seven MCP tool names from `examples/mcp-tools-live.json`.

## 0:20–0:40 — Connect the agent

**Narration:**
"The server exposes seven tools. Today we will use two new ones: natural-language screening and a transparent risk score."

**On screen:**

```bash
npm run mcp
```

Show the MCP client's tool list: `coin_quote`, `dex_pair_check`, `market_mood`, `natural_language_screener`, `new_listings`, `risk_score`, `top_movers`.

## 0:40–1:25 — Natural-language query

**Narration:**
"Instead of setting ten filters manually, I can simply ask: find mid-cap DeFi tokens with rising volume."

**On screen:** call MCP tool `natural_language_screener` with:

```json
{
  "query": "find mid-cap DeFi tokens with rising volume",
  "limit": 5,
  "scan_limit": 200
}
```

Point to the returned `parsed_filters` and `api_query`:
- DeFi category tags;
- market cap $100M–$10B;
- 24h volume change greater than 0%;
- CMC listings endpoint sorted by 24h volume;
- 200 listings scanned in two pages.

**Placeholder from evidence run (26 Nov 2026):** `[34]` candidates passed; top result `[WSTETH]`, with 24h volume change `[522.95%]` and risk `[26.6/100]`. Show each result's plain-language `explanation` — no hidden ranking magic.

## 1:25–2:15 — Risk-score drill-down

**Narration:**
"A match is not a recommendation. Scout attaches a risk score whose formula is public. It combines turnover, volatility, market size, dilution, market-pair breadth, and listing age. Every component returns its CMC inputs, so the score can be audited."

**On screen:** call MCP tool `risk_score` with:

```json
{ "symbols": "BTC,ETH" }
```

**Placeholders from evidence run (26 Nov 2026):**
- BTC: `[12.7/100 — Lower]`, confidence `[100%]`.
- ETH: `[9.8/100 — Lower]`, confidence `[100%]`.

Expand one component list and point to the actual inputs: 24h volume, market cap, percent changes, FDV/market cap, number of market pairs, and listing date.

## 2:15–2:35 — Close

**Narration:**
"CMC Scout Agent turns a plain-English market question into a reproducible CoinMarketCap query, then explains both the matches and their risks. It is open, inspectable, and ready for any MCP-compatible agent."

**On screen:** README sections "Risk-score formula" and "Evidence", then the repo URL placeholder: `[PUBLIC_GITHUB_REPO_URL]`.

## Recording notes

- Do not show `.env`, an API key, a shell history containing a key, or the CMC dashboard.
- Keep the raw JSON visible long enough for judges to see the endpoint/query and real response fields.
- If the recording is made with a campaign key, say "keyed mode" only if the tool output's `mode` field actually says `keyed`; the 26 Nov evidence run was `keyless`.
- Do not render/publish a final cut until the keyed-only checks (`dex_pair_check` and real `listings/new`) are either verified or explicitly described as unverified in the submission notes.
