import { fetchPages } from "./tinyfish";

// Counted-at-scale collection. Everything in this file is deterministic:
// sitemaps and ATS JSON APIs are enumerated and counted in code — no LLM
// touches a number. "We should be counting things, not reading things."

const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md",
  "ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc",
  "sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

export type StoreFootprint = {
  total: number;
  byState: Record<string, number>; // "TN" -> 58
  sitemapUrl: string;
  note: string;
};

/**
 * Count a chain's physical locations from its own sitemap: robots.txt names the
 * sitemaps, the location sitemap enumerates every store page, the state is a
 * 2-letter path segment. One number per state, zero judgment calls.
 */
export async function collectStoreFootprint(companyDomain: string): Promise<StoreFootprint | null> {
  const robotsUrl = `https://${companyDomain}/robots.txt`;
  const robots = await fetchPages([robotsUrl]);
  const robotsText = robots.results.map((r) => ("text" in r ? r.text : "")).join("\n");

  const declared = [...robotsText.matchAll(/sitemap:\s*(\S+)/gi)].map((m) => m[1]);
  const candidates = [
    ...declared.filter((u) => /locat|store/i.test(u)),
    ...declared.filter((u) => !/locat|store/i.test(u)),
    `https://${companyDomain}/sitemap.xml`,
  ];

  for (const sitemapUrl of dedupe(candidates).slice(0, 4)) {
    const counted = await countLocationUrls(sitemapUrl);
    if (counted && counted.total >= 10) {
      const states = Object.keys(counted.byState).length;
      return {
        ...counted,
        sitemapUrl,
        note: `${counted.total} locations across ${states} states — live sitemap enumeration`,
      };
    }
  }
  console.log(`footprint: ${companyDomain} has no enumerable location sitemap`);
  return null;
}

async function countLocationUrls(sitemapUrl: string): Promise<Omit<StoreFootprint, "sitemapUrl" | "note"> | null> {
  let text: string;
  try {
    const res = await fetchPages([sitemapUrl]);
    text = res.results.map((r) => ("text" in r ? r.text : "")).join("\n");
  } catch {
    return null;
  }
  if (!text.trim()) return null;

  // store detail urls: a path containing /locations/ or /stores/ with a
  // 2-letter US state segment somewhere after it
  const urls = text.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  const byState: Record<string, number> = {};
  let total = 0;
  for (const url of urls) {
    const path = url.split("?")[0].toLowerCase();
    if (!/\/(locations?|stores?|restaurants?)\//.test(path)) continue;
    const segments = path.split("/").slice(3); // drop protocol + host
    const state = segments.find((s) => US_STATES.has(s));
    if (!state) continue;
    // must be a detail page (something after the state), not the state index itself
    if (segments.indexOf(state) === segments.length - 1) continue;
    byState[state.toUpperCase()] = (byState[state.toUpperCase()] ?? 0) + 1;
    total++;
  }
  return total > 0 ? { total, byState } : null;
}

export type JobsFootprint = {
  total: number;
  byDepartment: Record<string, number>;
  byMarket: Record<string, number>;
  note: string;
};

/** Count open roles from the ATS's public JSON API — parsed in code, no agent. */
export async function collectJobsFootprint(board: { kind: "greenhouse" | "lever"; slug: string }): Promise<JobsFootprint> {
  const byDepartment: Record<string, number> = {};
  const byMarket: Record<string, number> = {};
  let total = 0;

  if (board.kind === "greenhouse") {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`, {
      headers: { "User-Agent": "Upstream research demo contact@tinyfish.ai" },
    });
    if (!res.ok) throw new Error(`greenhouse board returned ${res.status}`);
    const data = (await res.json()) as { jobs: { location?: { name?: string }; departments?: { name: string }[] }[] };
    for (const job of data.jobs) {
      total++;
      const dept = job.departments?.[0]?.name ?? "Unassigned";
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
      const market = job.location?.name ?? "Unlisted";
      byMarket[market] = (byMarket[market] ?? 0) + 1;
    }
  } else {
    const res = await fetch(`https://api.lever.co/v0/postings/${board.slug}?mode=json`, {
      headers: { "User-Agent": "Upstream research demo contact@tinyfish.ai" },
    });
    if (!res.ok) throw new Error(`lever board returned ${res.status}`);
    const data = (await res.json()) as { categories?: { team?: string; location?: string } }[];
    for (const job of data) {
      total++;
      const dept = job.categories?.team ?? "Unassigned";
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
      const market = job.categories?.location ?? "Unlisted";
      byMarket[market] = (byMarket[market] ?? 0) + 1;
    }
  }

  const departments = Object.keys(byDepartment).length;
  return { total, byDepartment, byMarket, note: `${total} open roles across ${departments} departments — counted from the ATS API` };
}

/**
 * Delta-based directional read for a counted series: no judgment on levels,
 * only on movement vs the prior scan. First scan = baseline, no read.
 */
export function countDeltaRead(previous: number | null, current: number): number | null {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (pct <= -15) return 32;
  if (pct <= -5) return 42;
  if (pct < 5) return 52;
  return 60;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
