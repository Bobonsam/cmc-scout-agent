// CMC Scout Agent — natural-language screener + transparent risk score.
//
// The parser is deterministic (no LLM and no invented market data). It
// translates a request into:
//   1. a CoinMarketCap listings/latest API query (endpoint + sort), and
//   2. explicit client-side filters whose thresholds are returned verbatim.
// Every result is built only from fields in the CMC response and carries an
// explanation that names the actual value that passed each requested filter.

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function quoteFor(raw, convert = "USD") {
  if (Array.isArray(raw?.quote)) return raw.quote.find((q) => q.symbol === convert) ?? raw.quote[0] ?? {};
  if (raw?.quote && typeof raw.quote === "object") return raw.quote[convert] ?? {};
  if (Array.isArray(raw?.quotes)) return raw.quotes.find((q) => q.symbol === convert) ?? raw.quotes[0] ?? {};
  return {};
}

export function normalizeAsset(raw, convert = "USD") {
  const q = quoteFor(raw, convert);
  const price = finite(q.price);
  const totalSupply = finite(raw.total_supply);
  const maxSupply = finite(raw.max_supply);
  const fdv = finite(q.fully_diluted_market_cap)
    ?? (price !== null ? price * (totalSupply ?? maxSupply ?? NaN) : null);

  return {
    id: raw.id,
    name: raw.name,
    symbol: raw.symbol,
    slug: raw.slug,
    cmc_rank: raw.cmc_rank ?? null,
    date_added: raw.date_added ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    platform: raw.platform ? {
      name: raw.platform.name ?? null,
      symbol: raw.platform.symbol ?? null,
      slug: raw.platform.slug ?? null,
      token_address: raw.platform.token_address ?? null,
    } : null,
    num_market_pairs: finite(raw.num_market_pairs),
    circulating_supply: finite(raw.circulating_supply),
    total_supply: totalSupply,
    max_supply: maxSupply,
    infinite_supply: typeof raw.infinite_supply === "boolean" ? raw.infinite_supply : null,
    price_usd: price,
    market_cap_usd: finite(q.market_cap),
    fully_diluted_market_cap_usd: Number.isFinite(fdv) ? fdv : null,
    volume_24h_usd: finite(q.volume_24h),
    volume_change_24h_pct: finite(q.volume_change_24h),
    change_1h_pct: finite(q.percent_change_1h),
    change_24h_pct: finite(q.percent_change_24h),
    change_7d_pct: finite(q.percent_change_7d),
    change_30d_pct: finite(q.percent_change_30d),
    last_updated: q.last_updated ?? raw.last_updated ?? null,
  };
}

function ageDays(asset, now = new Date()) {
  if (!asset.date_added) return null;
  const added = new Date(asset.date_added).getTime();
  if (!Number.isFinite(added)) return null;
  return Math.max(0, (now.getTime() - added) / DAY_MS);
}

function missingComponent(name, weight, input, note) {
  return { name, weight, points: weight / 2, input, missing: true, explanation: `${note}; neutral midpoint used.` };
}

function scoredComponent(name, weight, fraction, input, explanation) {
  return { name, weight, points: Number((weight * clamp(fraction, 0, 1)).toFixed(2)), input, missing: false, explanation };
}

function logPosition(value, low, high) {
  if (value === null || value <= 0) return null;
  return clamp((Math.log(value) - Math.log(low)) / (Math.log(high) - Math.log(low)), 0, 1);
}

// Risk score: 0 = lower measured risk, 100 = higher measured risk.
// Formula (also in README.md):
//   liquidity/volume depth 25 + volatility 25 + market size 15
//   + dilution (FDV/market cap) 15 + market-pair breadth 10 + listing age 10
// Missing inputs receive half their component weight and reduce confidence;
// they are never silently treated as either safe or dangerous.
export function calculateRiskScore(rawAsset, convert = "USD", now = new Date()) {
  const asset = rawAsset?.price_usd !== undefined && rawAsset?.market_cap_usd !== undefined
    ? rawAsset
    : normalizeAsset(rawAsset, convert);
  const components = [];

  const turnover = asset.volume_24h_usd !== null && asset.market_cap_usd
    ? asset.volume_24h_usd / asset.market_cap_usd
    : null;
  if (turnover === null) {
    components.push(missingComponent("Liquidity / turnover", 25, { volume_24h_usd: asset.volume_24h_usd, market_cap_usd: asset.market_cap_usd, turnover_ratio: null }, "Volume or market cap missing"));
  } else {
    // 0.0005 turnover -> full risk; 0.25 turnover -> zero risk (log scale).
    const pos = logPosition(turnover, 0.0005, 0.25) ?? 0;
    components.push(scoredComponent("Liquidity / turnover", 25, 1 - pos,
      { volume_24h_usd: asset.volume_24h_usd, market_cap_usd: asset.market_cap_usd, turnover_ratio: turnover },
      "Turnover is 24h volume divided by market cap, log-scaled from 0.0005 (riskiest) to 0.25 (least risky)."));
  }

  const volParts = [];
  if (asset.change_24h_pct !== null) volParts.push({ weight: 0.5, daily: Math.abs(asset.change_24h_pct) });
  if (asset.change_7d_pct !== null) volParts.push({ weight: 0.3, daily: Math.abs(asset.change_7d_pct) / Math.sqrt(7) });
  if (asset.change_30d_pct !== null) volParts.push({ weight: 0.2, daily: Math.abs(asset.change_30d_pct) / Math.sqrt(30) });
  if (!volParts.length) {
    components.push(missingComponent("Volatility", 25, { change_24h_pct: null, change_7d_pct: null, change_30d_pct: null }, "No price-change fields returned"));
  } else {
    const weightSum = volParts.reduce((s, p) => s + p.weight, 0);
    const dailyVolatilityPct = volParts.reduce((s, p) => s + p.weight * p.daily, 0) / weightSum;
    components.push(scoredComponent("Volatility", 25, dailyVolatilityPct / 15,
      { change_24h_pct: asset.change_24h_pct, change_7d_pct: asset.change_7d_pct, change_30d_pct: asset.change_30d_pct, weighted_daily_volatility_pct: dailyVolatilityPct },
      "Weighted daily volatility = 50% |24h| + 30% (|7d|/sqrt(7)) + 20% (|30d|/sqrt(30)); 15% or more receives full points."));
  }

  if (!asset.market_cap_usd) {
    components.push(missingComponent("Market size", 15, { market_cap_usd: asset.market_cap_usd }, "Market cap missing"));
  } else {
    const pos = logPosition(asset.market_cap_usd, 1_000_000, 100_000_000_000) ?? 0;
    components.push(scoredComponent("Market size", 15, 1 - pos,
      { market_cap_usd: asset.market_cap_usd },
      "Market cap log-scaled from $1M (riskiest) to $100B (least risky)."));
  }

  const dilutionRatio = asset.fully_diluted_market_cap_usd && asset.market_cap_usd
    ? asset.fully_diluted_market_cap_usd / asset.market_cap_usd
    : null;
  if (dilutionRatio === null) {
    components.push(missingComponent("Dilution proxy", 15,
      { fully_diluted_market_cap_usd: asset.fully_diluted_market_cap_usd, market_cap_usd: asset.market_cap_usd, fdv_to_market_cap_ratio: null, circulating_supply: asset.circulating_supply, total_supply: asset.total_supply },
      "FDV or market cap missing"));
  } else {
    const fraction = clamp(Math.log(Math.max(1, dilutionRatio)) / Math.log(10), 0, 1);
    components.push(scoredComponent("Dilution proxy", 15, fraction,
      { fully_diluted_market_cap_usd: asset.fully_diluted_market_cap_usd, market_cap_usd: asset.market_cap_usd, fdv_to_market_cap_ratio: dilutionRatio, circulating_supply: asset.circulating_supply, total_supply: asset.total_supply },
      "FDV/market-cap ratio log-scaled from 1x (no measured dilution gap) to 10x (full points). This is a supply/dilution proxy, not holder-concentration data."));
  }

  if (!asset.num_market_pairs) {
    components.push(missingComponent("Market-pair breadth", 10, { num_market_pairs: asset.num_market_pairs }, "Market-pair count missing"));
  } else {
    const pos = logPosition(asset.num_market_pairs, 1, 10_000) ?? 0;
    components.push(scoredComponent("Market-pair breadth", 10, 1 - pos,
      { num_market_pairs: asset.num_market_pairs },
      "Number of CMC market pairs log-scaled from 1 (riskiest) to 10,000 (least risky); a breadth/access proxy, not holder concentration."));
  }

  const days = ageDays(asset, now);
  if (days === null) {
    components.push(missingComponent("Listing age", 10, { date_added: asset.date_added, age_days: null }, "Listing date missing"));
  } else {
    const pos = logPosition(Math.max(days, 1), 7, 3650) ?? 0;
    components.push(scoredComponent("Listing age", 10, 1 - pos,
      { date_added: asset.date_added, age_days: Math.floor(days) },
      "Listing age log-scaled from 7 days (riskiest) to 10 years (least risky)."));
  }

  const score = Number(components.reduce((sum, c) => sum + c.points, 0).toFixed(1));
  const observedWeight = components.filter((c) => !c.missing).reduce((sum, c) => sum + c.weight, 0);
  const band = score < 25 ? "Lower" : score < 50 ? "Moderate" : score < 75 ? "Elevated" : "High";
  return {
    symbol: asset.symbol,
    name: asset.name,
    risk_score: score,
    risk_band: band,
    confidence_pct: observedWeight,
    formula: "25 liquidity/turnover + 25 volatility + 15 market size + 15 dilution proxy + 10 pair breadth + 10 listing age = 100 (higher = higher measured risk)",
    components,
    caveat: "Transparent market-structure score only. CMC listings data used here does not expose holder concentration; pair breadth and FDV/market cap are labelled proxies, not ownership measurements. Not financial advice.",
  };
}

const CATEGORY_RULES = [
  { label: "DeFi", patterns: [/\bdefi\b/, /\bdecentralized finance\b/], tags: ["defi", "dex", "lending", "borrowing", "yield-farming", "liquid-staking", "derivatives"] },
  { label: "Gaming", patterns: [/\bgaming\b/, /\bgamefi\b/, /\bplay[- ]to[- ]earn\b/], tags: ["gaming", "play-to-earn", "metaverse"] },
  { label: "AI", patterns: [/\bai\b/, /\bartificial intelligence\b/], tags: ["ai-big-data", "artificial-intelligence", "ai"] },
  { label: "Meme", patterns: [/\bmeme\b/], tags: ["meme"] },
  { label: "Layer 1", patterns: [/\blayer[- ]?1\b/, /\bl1\b/], tags: ["layer-1"] },
  { label: "Layer 2", patterns: [/\blayer[- ]?2\b/, /\bl2\b/], tags: ["layer-2", "scaling"] },
  { label: "RWA", patterns: [/\brwa\b/, /\breal[- ]world assets?\b/, /\btokenized assets?\b/], tags: ["rwa", "real-world-assets", "tokenized-assets"] },
  { label: "Stablecoin", patterns: [/\bstablecoins?\b/], tags: ["stablecoin"] },
  { label: "Privacy", patterns: [/\bprivacy\b/], tags: ["privacy"] },
  { label: "Oracle", patterns: [/\boracles?\b/], tags: ["oracle"] },
];

const ECOSYSTEM_RULES = [
  { label: "BNB Chain", patterns: [/\bbsc\b/, /\bbnb chain\b/, /\bbinance smart chain\b/], tag: "bnb-chain-ecosystem", platformSlug: "binance-smart-chain" },
  { label: "Ethereum", patterns: [/\bethereum\b/, /\beth ecosystem\b/], tag: "ethereum-ecosystem", platformSlug: "ethereum" },
  { label: "Solana", patterns: [/\bsolana\b/], tag: "solana-ecosystem", platformSlug: "solana" },
  { label: "Polygon", patterns: [/\bpolygon\b/], tag: "polygon-ecosystem", platformSlug: "polygon" },
  { label: "Arbitrum", patterns: [/\barbitrum\b/], tag: "arbitrum-ecosystem", platformSlug: "arbitrum" },
  { label: "Base", patterns: [/\bbase chain\b/, /\bbase ecosystem\b/], tag: "base-ecosystem", platformSlug: "base" },
  { label: "Avalanche", patterns: [/\bavalanche\b/], tag: "avalanche-ecosystem", platformSlug: "avalanche" },
];

function parseMoney(raw, unit) {
  const base = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000, t: 1_000_000_000_000 }[(unit ?? "").toLowerCase()] ?? 1;
  return base * multiplier;
}

function moneyAfter(text, regex) {
  const match = text.match(regex);
  return match ? parseMoney(match[1], match[2]) : null;
}

export function parseScreeningQuery(query) {
  const text = ` ${String(query).toLowerCase().replace(/\s+/g, " ").trim()} `;
  const filters = {
    categories: [],
    ecosystems: [],
    exclude_stablecoins: /\b(exclude|excluding|without|non[- ]stable|bukan stablecoin)\b/.test(text) && /\bstable/.test(text),
    asset_type: /\btokens?\b/.test(text) ? "token" : /\bcoins?\b/.test(text) ? "coin" : null,
  };

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      filters.categories.push({ label: rule.label, accepted_tags: rule.tags });
    }
  }
  for (const rule of ECOSYSTEM_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      filters.ecosystems.push({ label: rule.label, accepted_tag: rule.tag, platform_slug: rule.platformSlug });
    }
  }

  // Named market-cap bands are only defaults; explicit numbers below win.
  if (/\bmicro[- ]?cap\b/.test(text)) filters.market_cap_max_usd = 10_000_000;
  if (/\bsmall[- ]?cap\b/.test(text)) filters.market_cap_max_usd = 100_000_000;
  if (/\bmid[- ]?cap\b/.test(text)) { filters.market_cap_min_usd = 100_000_000; filters.market_cap_max_usd = 10_000_000_000; }
  if (/\blarge[- ]?cap\b/.test(text)) filters.market_cap_min_usd = 10_000_000_000;

  const amount = "([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*([kmbt])?";
  filters.market_cap_min_usd = moneyAfter(text, new RegExp(`(?:market cap|mcap)[^0-9$]{0,30}(?:above|over|greater than|at least|min(?:imum)?|>=|>)\\s*\\$?${amount}`))
    ?? moneyAfter(text, new RegExp(`\\$?${amount}\\s*(?:or more\\s+)?(?:market cap|mcap)`))
    ?? filters.market_cap_min_usd;
  filters.market_cap_max_usd = moneyAfter(text, new RegExp(`(?:market cap|mcap)[^0-9$]{0,30}(?:below|under|less than|at most|max(?:imum)?|<=|<)\\s*\\$?${amount}`))
    ?? moneyAfter(text, new RegExp(`(?:under|below|less than|max(?:imum)?)\\s*\\$?${amount}\\s*(?:market cap|mcap)`))
    ?? filters.market_cap_max_usd;

  filters.volume_24h_min_usd = moneyAfter(text, new RegExp(`(?:24h\\s+)?volume[^0-9$]{0,30}(?:above|over|greater than|at least|min(?:imum)?|>=|>)\\s*\\$?${amount}`))
    ?? moneyAfter(text, new RegExp(`\\$?${amount}\\s*(?:or more\\s+)?(?:24h\\s+)?volume`))
    ?? null;
  filters.price_min_usd = moneyAfter(text, new RegExp(`price[^0-9$]{0,25}(?:above|over|greater than|at least|>=|>)\\s*\\$?${amount}`)) ?? null;
  filters.price_max_usd = moneyAfter(text, new RegExp(`price[^0-9$]{0,25}(?:below|under|less than|at most|<=|<)\\s*\\$?${amount}`))
    ?? moneyAfter(text, new RegExp(`(?:under|below)\\s*\\$?${amount}\\s*(?:per\\s+)?(?:coin|token)?\\s*price`))
    ?? null;

  if (/\b(volume (is )?(rising|up|increasing)|rising volume|increasing volume|volume naik|volume melonjak)\b/.test(text)) filters.volume_change_24h_min_pct = 0;
  if (/\b(volume surge|surging volume|volume spike|volume melonjak tajam)\b/.test(text)) filters.volume_change_24h_min_pct = 25;
  if (/\b(gainers?|rising price|price (is )?(rising|up)|momentum|harga naik)\b/.test(text)) filters.change_24h_min_pct = 0;
  if (/\bstrong momentum\b/.test(text)) filters.change_24h_min_pct = 5;
  if (/\bhighly liquid\b/.test(text)) filters.turnover_min_ratio = 0.05;
  else if (/\bliquid\b/.test(text)) filters.turnover_min_ratio = 0.01;
  if (/\bestablished\b/.test(text)) filters.min_age_days = 730;
  if (/\b(new|recent|baru)\b/.test(text) && /\b(listing|listed|token|coin)\b/.test(text)) filters.max_age_days = 90;
  if (/\bwidely traded\b/.test(text)) filters.min_market_pairs = 100;
  if (/\blow risk\b|\bsafer\b|\blowest risk\b/.test(text)) filters.risk_score_max = 50;
  if (/\bhigh risk\b/.test(text)) filters.risk_score_min = 50;

  let sort = "market_cap";
  let ranking = "market_cap_desc";
  if (filters.volume_change_24h_min_pct !== undefined || filters.volume_24h_min_usd) { sort = "volume_24h"; ranking = filters.volume_change_24h_min_pct !== undefined ? "volume_change_24h_desc" : "volume_24h_desc"; }
  if (filters.change_24h_min_pct !== undefined) { sort = "percent_change_24h"; ranking = "change_24h_desc"; }
  if (filters.max_age_days !== undefined) { sort = "date_added"; ranking = "date_added_desc"; }
  if (/\blowest risk\b|\blow risk\b|\bsafer\b/.test(text)) ranking = "risk_score_asc";
  if (/\bmost liquid\b|\bhighest volume\b/.test(text)) { sort = "volume_24h"; ranking = "turnover_desc"; }

  const requestedLimit = text.match(/\btop\s+([0-9]{1,2})\b/);
  return {
    original_query: query,
    filters,
    api_query: {
      endpoint: "/v3/cryptocurrency/listings/latest (keyless) or the keyed Pro listings/latest equivalent selected by CmcClient",
      start: 1,
      limit_per_page: 100,
      sort,
      sort_dir: "desc",
      convert: "USD",
      client_side_filters: "All explicit thresholds, category/ecosystem tags, age, turnover and risk bounds are checked against returned CMC fields and reported per result.",
    },
    ranking,
    requested_limit: requestedLimit ? Number(requestedLimit[1]) : null,
  };
}

function hasAnyTag(asset, accepted) {
  const normalized = asset.tags.map((tag) => String(tag).toLowerCase().replace(/_/g, "-"));
  return accepted.some((tag) => normalized.includes(tag));
}

function money(value) {
  return value === null || value === undefined ? "not returned" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function pct(value) {
  return value === null || value === undefined ? "not returned" : `${Number(value).toFixed(2)}%`;
}

export function explainMatch(asset, filters, risk, now = new Date()) {
  const reasons = [];
  if (filters.categories?.length) reasons.push(`Category tags matched: ${asset.tags.filter((t) => filters.categories.some((c) => c.accepted_tags.includes(t))).join(", ") || "matching CMC tag"}.`);
  if (filters.ecosystems?.length) reasons.push(`Ecosystem matched via CMC tags/platform (${filters.ecosystems.map((e) => e.label).join(", ")}).`);
  if (filters.market_cap_min_usd !== undefined || filters.market_cap_max_usd !== undefined) reasons.push(`Market cap ${money(asset.market_cap_usd)} is inside the requested band.`);
  if (filters.volume_24h_min_usd) reasons.push(`24h volume ${money(asset.volume_24h_usd)} meets the requested minimum.`);
  if (filters.volume_change_24h_min_pct !== undefined) reasons.push(`24h volume change is ${pct(asset.volume_change_24h_pct)}, meeting the rising-volume threshold.`);
  if (filters.change_24h_min_pct !== undefined) reasons.push(`24h price change is ${pct(asset.change_24h_pct)}, meeting the momentum threshold.`);
  if (filters.turnover_min_ratio) reasons.push(`Turnover is ${asset.volume_24h_usd && asset.market_cap_usd ? (asset.volume_24h_usd / asset.market_cap_usd).toFixed(4) : "not returned"}, meeting the liquidity threshold.`);
  const days = ageDays(asset, now);
  if (filters.min_age_days || filters.max_age_days) reasons.push(`Listing age is ${days === null ? "not returned" : `${Math.floor(days)} days`}.`);
  reasons.push(`Risk score ${risk.risk_score}/100 (${risk.risk_band}, ${risk.confidence_pct}% of formula weight observed).`);
  return reasons;
}

function passesFilters(asset, filters, now) {
  if (filters.market_cap_min_usd !== undefined && !(asset.market_cap_usd >= filters.market_cap_min_usd)) return false;
  if (filters.market_cap_max_usd !== undefined && !(asset.market_cap_usd <= filters.market_cap_max_usd)) return false;
  if (filters.volume_24h_min_usd && !(asset.volume_24h_usd >= filters.volume_24h_min_usd)) return false;
  if (filters.volume_change_24h_min_pct !== undefined && !(asset.volume_change_24h_pct > filters.volume_change_24h_min_pct)) return false;
  if (filters.change_24h_min_pct !== undefined && !(asset.change_24h_pct > filters.change_24h_min_pct)) return false;
  if (filters.price_min_usd && !(asset.price_usd >= filters.price_min_usd)) return false;
  if (filters.price_max_usd && !(asset.price_usd <= filters.price_max_usd)) return false;
  if (filters.turnover_min_ratio && !(asset.volume_24h_usd / asset.market_cap_usd >= filters.turnover_min_ratio)) return false;
  if (filters.min_market_pairs && !(asset.num_market_pairs >= filters.min_market_pairs)) return false;
  if (filters.asset_type === "token" && !asset.platform) return false;
  if (filters.asset_type === "coin" && asset.platform) return false;
  if (filters.exclude_stablecoins && hasAnyTag(asset, ["stablecoin"])) return false;
  for (const category of filters.categories ?? []) if (!hasAnyTag(asset, category.accepted_tags)) return false;
  for (const eco of filters.ecosystems ?? []) {
    if (!hasAnyTag(asset, [eco.accepted_tag]) && asset.platform?.slug !== eco.platform_slug) return false;
  }
  const days = ageDays(asset, now);
  if (filters.min_age_days && !(days >= filters.min_age_days)) return false;
  if (filters.max_age_days && !(days <= filters.max_age_days)) return false;
  return true;
}

function sortResults(rows, ranking) {
  const by = {
    market_cap_desc: (a, b) => (b.market_cap_usd ?? -1) - (a.market_cap_usd ?? -1),
    volume_24h_desc: (a, b) => (b.volume_24h_usd ?? -1) - (a.volume_24h_usd ?? -1),
    volume_change_24h_desc: (a, b) => (b.volume_change_24h_pct ?? -Infinity) - (a.volume_change_24h_pct ?? -Infinity),
    change_24h_desc: (a, b) => (b.change_24h_pct ?? -Infinity) - (a.change_24h_pct ?? -Infinity),
    date_added_desc: (a, b) => new Date(b.date_added) - new Date(a.date_added),
    turnover_desc: (a, b) => ((b.volume_24h_usd / b.market_cap_usd) || -1) - ((a.volume_24h_usd / a.market_cap_usd) || -1),
    risk_score_asc: (a, b) => a.risk.risk_score - b.risk.risk_score,
  }[ranking] ?? ((a, b) => (b.market_cap_usd ?? -1) - (a.market_cap_usd ?? -1));
  return rows.sort(by);
}

export async function naturalLanguageScreen(client, { query, limit = 10, scan_limit = 200, convert = "USD" } = {}) {
  if (!query || !String(query).trim()) throw new Error("natural_language_screener requires a non-empty query");
  const parsed = parseScreeningQuery(query);
  const resultLimit = Math.min(Math.max(limit ?? parsed.requested_limit ?? 10, 1), 50);
  const scanLimit = Math.min(Math.max(scan_limit, resultLimit), 500);
  const raw = [];
  let pagesFetched = 0;
  for (let start = 1; start <= scanLimit; start += 100) {
    const pageLimit = Math.min(100, scanLimit - start + 1);
    const page = await client.listingsLatest({ start, limit: pageLimit, convert, sort: parsed.api_query.sort, sort_dir: "desc" });
    pagesFetched += 1;
    if (!Array.isArray(page)) throw new Error("CMC listings response was not an array");
    raw.push(...page);
    if (page.length < pageLimit) break;
  }

  const now = new Date();
  const candidates = [];
  for (const item of raw) {
    const asset = normalizeAsset(item, convert);
    if (!passesFilters(asset, parsed.filters, now)) continue;
    const risk = calculateRiskScore(asset, convert, now);
    if (parsed.filters.risk_score_max !== undefined && risk.risk_score > parsed.filters.risk_score_max) continue;
    if (parsed.filters.risk_score_min !== undefined && risk.risk_score < parsed.filters.risk_score_min) continue;
    candidates.push({ ...asset, risk, explanation: explainMatch(asset, parsed.filters, risk, now) });
  }

  return {
    query,
    parsed_filters: parsed.filters,
    api_query: { ...parsed.api_query, pages_fetched: pagesFetched, scan_limit: scanLimit },
    ranking: parsed.ranking,
    scanned_count: raw.length,
    candidate_count: candidates.length,
    returned_count: Math.min(resultLimit, candidates.length),
    results: sortResults(candidates, parsed.ranking).slice(0, resultLimit),
    mode: client.mode,
    credit_count_last_response: client.lastCreditCount ?? null,
    generated_at: now.toISOString(),
    note: "Results and explanations use only fields returned by CoinMarketCap for this call. An empty result means no asset in the scanned slice passed every parsed filter; it is not filled with approximations.",
  };
}

export async function riskScoreSymbols(client, { symbols, convert = "USD" } = {}) {
  const wanted = String(symbols ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!wanted.length) throw new Error("risk_score requires at least one symbol");
  const data = await client.quotesLatest(wanted.join(","), convert);
  const all = Array.isArray(data) ? data : Object.values(data ?? {});
  const bySymbol = new Map();
  for (const item of all) {
    const symbol = String(item.symbol ?? "").toUpperCase();
    if (wanted.includes(symbol) && !bySymbol.has(symbol)) bySymbol.set(symbol, normalizeAsset(item, convert));
  }
  const missing = wanted.filter((symbol) => !bySymbol.has(symbol));
  return {
    symbols: wanted,
    results: wanted.filter((symbol) => bySymbol.has(symbol)).map((symbol) => {
      const asset = bySymbol.get(symbol);
      return { asset, ...calculateRiskScore(asset, convert) };
    }),
    missing_symbols: missing,
    mode: client.mode,
    credit_count_last_response: client.lastCreditCount ?? null,
    generated_at: new Date().toISOString(),
  };
}
