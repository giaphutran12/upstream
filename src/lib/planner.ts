import type { Family, SourceSpec } from "./sources";

// The depth planner: an agent that figures out what "deeper" means for THIS
// company — then hands the work to the cheap fleet. Probes are search+fetch
// only (agents cost browsers; search and fetch are near-free). Memory: the
// playbook of past probes and their evidence yield, read back from source_runs.

const MODEL = process.env.PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6-luna";

export type Probe = {
  label: string;
  family: Family;
  query: string;
  why: string;
  metricHint?: string;
};

export type PlaybookEntry = { label: string; query: string; itemsRead: number };

export async function planDeepProbes(opts: {
  companyName: string;
  ticker: string;
  sector?: string | null;
  knownSources: string[]; // labels already covered by the fixed plan
  playbook: PlaybookEntry[];
}): Promise<Probe[]> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the research planner for a primary-source equity scan of ${opts.companyName} (${opts.ticker}${opts.sector ? `, ${opts.sector}` : ""}).
Already covered by the fixed plan: ${opts.knownSources.join(", ")}. Your job is DEPTH: propose up to 4 probes for places specific to this company or its industry where customers, employees, franchisees, drivers, sellers, developers, patients, or regulators leave dated primary evidence. Think: health-inspection portals for restaurant chains, driver/seller forums for marketplaces, developer or repair communities for device makers, state insurance-complaint indexes for insurers, court/WARN/OSHA records, niche review sites with real volume.
HARD CONSTRAINT: each probe must be answerable by a WEB SEARCH whose top results can be read as plain fetched pages — no logins, no interactive browsing, no PDFs behind forms. Write the query the way a skilled researcher would type it (site: filters welcome).
STRICT JSON: {"probes":[{"label":"short human name of the place/angle","family":"sentiment|workforce|leadership|ops","query":"the exact search query","why":"one line: what this could surface that the fixed plan cannot","metricHint":"optional: the one number to extract, phrased precisely"}]}
Playbook from previous scans of this company (query → evidence rows it yielded): ${opts.playbook.length ? JSON.stringify(opts.playbook) : "none yet"}. Repeat angles that yielded, drop dead ends (0 yield twice), and include at least one angle never tried.`,
        },
        { role: "user", content: `Plan the deep probes for ${opts.companyName}.` },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`planner: OpenAI ${response.status} — ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as { probes?: Probe[] };
  const families: Family[] = ["sentiment", "workforce", "leadership", "ops"];
  const probes = (parsed.probes ?? [])
    .filter((p) => p.label && p.query && families.includes(p.family))
    .slice(0, 4);
  console.log(`planner: ${opts.ticker} — ${probes.length} deep probes planned (${probes.map((p) => p.label).join("; ")})`);
  return probes;
}

/** A planned probe becomes an ordinary search-kind source the scan runner already knows how to execute. */
export function probeToSpec(probe: Probe): SourceSpec {
  return {
    key: `probe_${slug(probe.label)}`,
    label: `${probe.label} · discovered`,
    family: probe.family,
    kind: "search",
    urls: () => ["planned"], // presence marker; search-kind gets its urls from the query
    searchQuery: () => probe.query,
    metricHint: probe.metricHint,
    probeMeta: { query: probe.query, why: probe.why },
  };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}
