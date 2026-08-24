// Fuzzy company lookup over the SEC's full ticker universe (~10k listings).
// Nobody memorizes tickers: "mcdonalds" → MCD. The SEC file is roughly
// market-cap ordered, so ties resolve to the company people actually mean.

export type CompanyHit = { ticker: string; name: string };

type Entry = { ticker: string; name: string; norm: string; tokens: string[]; rank: number };

let universe: Entry[] | null = null;

async function loadUniverse(): Promise<Entry[]> {
  if (universe) return universe;
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "Upstream research demo contact@tinyfish.ai" },
    cache: "force-cache",
  });
  if (!response.ok) throw new Error(`company search: SEC ticker map returned ${response.status}`);
  const map = (await response.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  universe = Object.values(map).map((e, i) => ({
    ticker: e.ticker,
    name: e.title,
    norm: normalize(e.title),
    tokens: normalize(e.title).split(" ").filter(Boolean),
    rank: i,
  }));
  console.log(`company search: universe loaded, ${universe.length} listings`);
  return universe;
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/['’.,&()-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchCompanies(query: string, limit = 8): Promise<CompanyHit[]> {
  const entries = await loadUniverse();
  const q = query.trim();
  if (q.length < 1) return [];
  const upper = q.toUpperCase();
  const norm = normalize(q);
  const normSquashed = norm.replaceAll(" ", "");
  const qTokens = norm.split(" ").filter(Boolean);

  const scored: { entry: Entry; score: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    const squashed = entry.norm.replaceAll(" ", "");
    if (entry.ticker === upper) score = 100;
    else if (entry.norm === norm || squashed === normSquashed) score = 96;
    else if (entry.ticker.startsWith(upper) && upper.length >= 2) score = 90;
    else if (entry.norm.startsWith(norm) || squashed.startsWith(normSquashed)) score = 84;
    else if (qTokens.length > 0 && qTokens.every((t) => entry.tokens.some((et) => et.startsWith(t)))) score = 74;
    else if (normSquashed.length >= 3 && squashed.includes(normSquashed)) score = 62;
    if (score > 0) scored.push({ entry, score });
  }

  // typo tier: "STARBUX" → Starbucks, "CRAKCER BARREL" → CBRL. Compares the
  // query against the same-length prefix of the squashed name, so partial
  // typing with a typo still lands. Only runs when nothing better matched.
  if (scored.length === 0 && normSquashed.length >= 4) {
    const tolerance = normSquashed.length >= 8 ? 2 : 1;
    for (const entry of entries) {
      const prefix = entry.norm.replaceAll(" ", "").slice(0, normSquashed.length);
      const d = editDistance(prefix, normSquashed, tolerance);
      if (d <= tolerance) scored.push({ entry, score: 40 - d });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.rank - b.entry.rank);
  return scored.slice(0, limit).map(({ entry }) => ({ ticker: entry.ticker, name: entry.name }));
}

/** Bounded Levenshtein: bails at `max`+1 so the 10k-entry sweep stays cheap. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}
