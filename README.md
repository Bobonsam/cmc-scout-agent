# CMC Scout Agent

> Status 26 Nov 2026 — **natural-language screener + transparent risk score are built and live-tested**. The MCP server now exposes 7 tools. The 26 Nov live evidence run used CoinMarketCap's keyless mode because no `CMC_API_KEY` was present in that build session's environment or workspace; **zero campaign-key credits were used**. Keyed-only checks are listed honestly under "Still unverified".

## What this is

**CMC Scout Agent** is an MCP server + scheduled alert agent that puts live CoinMarketCap data in front of an LLM agent. An agent can ask ordinary market questions, run a plain-English token screen, inspect why each result matched, and drill into a fully traceable market-structure risk score.

Built for **Build with CMC: API Hackathon**, track **AI Agents and Automation**.

## Tools

Verified through a real MCP client (`tools/list`) on 26 Nov 2026:

1. `top_movers` — top gainers/losers by 24h percent change.
2. `new_listings` — newest listings; keyed mode uses real `listings/new`, keyless mode uses a clearly labelled `date_added` stand-in.
3. `coin_quote` — price, market cap, volume and 1h/24h/7d changes for symbols.
4. `dex_pair_check` — DEX pair price/liquidity/volume by network + pool address (code present; keyed live verification still pending).
5. `market_mood` — global market cap/volume, BTC/ETH dominance and Fear & Greed.
6. `natural_language_screener` — **new 26 Nov**; deterministic NL parser → CMC query + explicit filters → ranked, explained results.
7. `risk_score` — **new 26 Nov**; transparent 0–100 score with every component and input returned.

The scheduled alert agent (`npm run alert`) reuses the same client and filters junk microcaps by minimum market cap before emitting alerts.

## Natural-language screener

Example:

```json
{
  "query": "find mid-cap DeFi tokens with rising volume",
  "limit": 5,
  "scan_limit": 200
}
```

The parser is deterministic — no LLM is trusted to invent filters or numbers. It returns:

- `parsed_filters`: exact thresholds and tag rules it understood;
- `api_query`: the CoinMarketCap endpoint, sort, page size and scan limit used;
- `scanned_count` / `candidate_count`;
- ranked `results`, each with the live CMC fields, a risk score, and an `explanation` naming the actual values that passed.

Supported language includes named bands (`micro-cap`, `small-cap`, `mid-cap`, `large-cap`), explicit money bounds ("market cap above $250m", "under $1b market cap"), categories (DeFi, Gaming, AI, Meme, Layer 1/2, RWA, Stablecoin, Privacy, Oracle), ecosystems (BNB Chain, Ethereum, Solana, Polygon, Arbitrum, Base, Avalanche), rising/surging volume, price momentum, liquidity/turnover, listing age, market-pair breadth, and low/high-risk bounds. Unsupported wording is not guessed: it simply does not become a filter, and the returned `parsed_filters` shows exactly what was applied.

### Live evidence — 26 Nov 2026

Command: `npm run test:features` (2 listings pages + 1 quotes call).

- Query: `find mid-cap DeFi tokens with rising volume`
- Parsed band: **$100M–$10B market cap**, DeFi tags, **24h volume change > 0%**
- API slice: **200 listings scanned**, **34 candidates**, top 5 returned
- Top result: **WSTETH** — market cap $8,116,412,540.88; 24h volume change **+522.95%**; risk **26.6/100**
- Full input/output: [`examples/nl-screener-live.json`](examples/nl-screener-live.json)

## Risk-score formula

`risk_score` is a **market-structure risk score from 0 to 100; higher means higher measured risk**. It is not a credit rating, not a safety guarantee, and not financial advice.

| Component | Weight | CMC inputs | Scale |
|---|---:|---|---|
| Liquidity / turnover | 25 | `volume_24h`, `market_cap` | Turnover = volume / market cap. Log scale: 0.0005 → full 25 points; 0.25 → 0 points. |
| Volatility | 25 | `percent_change_24h`, `percent_change_7d`, `percent_change_30d` | Daily volatility = 50%·|24h| + 30%·(|7d|/√7) + 20%·(|30d|/√30). 15% or more → full 25 points. |
| Market size | 15 | `market_cap` | Log scale: $1M → full 15 points; $100B → 0 points. |
| Dilution proxy | 15 | `fully_diluted_market_cap`, `market_cap`, supplies | FDV / market-cap ratio, log scale: 1× → 0 points; 10× → full 15 points. |
| Market-pair breadth | 10 | `num_market_pairs` | Log scale: 1 pair → full 10 points; 10,000 pairs → 0 points. |
| Listing age | 10 | `date_added` | Log scale: 7 days → full 10 points; 10 years → 0 points. |

Rules that keep the score honest:

- Every component is returned with its **raw inputs, points, formula note and missing flag** — any score can be recomputed by hand.
- A missing input gets **half its component weight** (neutral midpoint) and lowers `confidence_pct`; missing data is never treated as safe or dangerous.
- Bands: `<25` Lower · `25–49.9` Moderate · `50–74.9` Elevated · `≥75` High.
- CoinMarketCap listings data used here does **not** expose holder concentration. Pair breadth and FDV/market cap are explicitly labelled **proxies**, never presented as ownership/concentration measurements.

### Live evidence — 26 Nov 2026

`risk_score` for BTC and ETH (full breakdown in [`examples/risk-score-live.json`](examples/risk-score-live.json)):

- **BTC: 12.7/100 — Lower**, confidence 100% (liquidity 8.08 + volatility 4.39 + size 0 + dilution 0.28 + pair breadth 0 + age 0)
- **ETH: 9.8/100 — Lower**, confidence 100% (liquidity 5.36 + volatility 4.46 + all other components 0)

## CoinMarketCap endpoints used

- `GET /v3/cryptocurrency/listings/latest` — ranked listings + filters; the screener's core endpoint (keyless path; the client selects the keyed Pro base when `CMC_API_KEY` is set).
- `GET /v3/cryptocurrency/quotes/latest` — latest quotes; the risk score's endpoint.
- `GET /v1/cryptocurrency/listings/new` — real new listings (**keyed-only**; keyless mode uses the labelled stand-in above).
- `GET /v1/cryptocurrency/map` — symbol → stable CMC ID mapping.
- `GET /v2/cryptocurrency/info` — asset metadata.
- `GET /v1/global-metrics/quotes/latest` — global market cap/volume + dominance.
- `GET /v3/fear-and-greed/latest` — CMC Fear & Greed index.
- `GET /v1/dex/search` — DEX token/pair search.
- `GET /v4/dex/pairs/quotes/latest` — DEX pair quotes.

Response-shape notes learned live (23 Nov): v3 `quote` is an array keyed by convert symbol; global-metrics dominance sits at the payload top level, not inside `quote.USD`; quotes responses can contain duplicate symbols and are deduplicated by the client code.

## Run it

Requirements: Node.js 18+. A CoinMarketCap API key is optional for the keyless prototype and required for keyed-only endpoints.

```bash
cp .env.example .env   # put YOUR OWN key in .env; never commit .env
npm install
npm run test:unit      # offline parser/formula checks (no API calls)
npm run test:features  # LIVE evidence run: 2 listings pages + 1 quotes call
npm test               # broader live smoke test (more API calls; run deliberately)
npm run mcp            # MCP server over stdio
npm run alert          # scheduled alert agent
```

The key is read **only** from the `CMC_API_KEY` environment variable. `.env` is git-ignored; the repository contains only `.env.example` with an empty value.

## Project structure

```
cmc-build/
├── README.md
├── .env.example
├── package.json
├── src/
│   ├── cmc-client.js     thin CMC REST client (keyless/keyed, 429 backoff)
│   ├── screener.js       NL parser + screening engine + risk-score formula
│   ├── mcp-server.js     MCP server (7 tools, stdio transport)
│   └── alert-agent.js    scheduled alert loop
├── test/
│   ├── screener-unit.mjs offline unit checks (no credits)
│   ├── features-live.mjs live NL screener + risk evidence generator
│   └── smoke.mjs         broader live smoke test
├── examples/             real API responses + MCP tool-list evidence
└── demo/
    ├── SCRIPT.md         <3-minute demo script with evidence placeholders
    └── X_POST_DRAFT.md   draft for bobon to post himself with #BuildwithCMC
```

## API experience notes (for the submission form)

What the API made easy: one listings call returns rich, score-ready fields (tags, supplies, market pairs, listing date, multi-window percent changes and volume change), so a transparent screener + risk model needs no stitched-together third-party data.

What slowed us down: the keyless anonymous DEX quota is tight (`dex/search` returned error 1022 after a few calls) and some keyless DEX network coverage differs from the keyed catalog, so `dex_pair_check` still needs a keyed re-test; `listings/new` is keyed-only, forcing an explicitly labelled stand-in in keyless demos.

## Still unverified / remaining before submission

1. **Keyed live checks** — `dex_pair_check` (BSC + Ethereum pools) and real `listings/new`, using bobon's campaign key via env. Not run on 26 Nov because no key was present in the build session; the key itself was never written to the workspace.
2. **Public GitHub repo** — local repository is prepared and committed; creating/pushing the public repo still needs a working non-interactive GitHub path or bobon creating the empty repo (same blocker pattern as Jagain).
3. **Demo video** — script is ready in `demo/SCRIPT.md`; no final render is claimed while item 1 is open.
4. **X post** — draft is ready in `demo/X_POST_DRAFT.md`; **bobon posts it himself** near the 7 Dec internal submit target, with the DoraHacks submission link + demo video + `#BuildwithCMC`.
5. **DoraHacks submission** — not submitted in this build run. Hard deadline: **10 Dec 2026, 06:59 WIB**.

## License

MIT (see `package.json`).
