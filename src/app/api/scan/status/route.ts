import { db } from "@/lib/db";
import { SOURCES, FAMILY_WEIGHTS, type Family } from "@/lib/sources";

export const runtime = "nodejs";

const FIXED_META = new Map(SOURCES.map((s) => [s.key, { label: s.label, family: s.family }]));

/** Rebuild label + family for a run row; probe runs carry them in probeMeta. */
function metaFor(key: string, result: unknown): { label: string; family: Family } {
  const fixed = FIXED_META.get(key);
  if (fixed) return fixed;
  const meta = (result ?? {}) as { label?: string; family?: string };
  return {
    label: meta.label ?? `${key.replace(/^probe_/, "").replaceAll("_", " ")} · discovered`,
    family: (meta.family as Family) ?? "ops",
  };
}

/**
 * Read model for the one-background-job-per-company architecture: the scan
 * pipeline persists as it runs, and every page asks THIS endpoint where that
 * job stands instead of holding a stream open or starting its own. Returns a
 * full snapshot — source runs, score, findings, takeaways — so a viewer that
 * navigated away can reattach and see the same progress.
 */
export async function GET(request: Request) {
  const ticker = new URL(request.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker query param required" }, { status: 400 });

  const sql = db();
  const [company] = await sql`select id, ticker, name from companies where ticker = ${ticker}`;
  if (!company) return Response.json({ company: null, scan: null });

  // self-heal: a scan still 'running' past the pipeline's own time limit is
  // dead — mark it failed so nothing waits on it forever
  const healed = await sql`
    update scans set status = 'failed', completed_at = now(),
      error = 'timed out — no completion within 15 minutes'
    where company_id = ${company.id} and status = 'running'
      and started_at < now() - interval '15 minutes'
    returning id`;
  if (healed.length > 0) {
    console.warn(`scan status: marked ${healed.length} stale running scan(s) failed for ${ticker} (ids ${healed.map((r) => r.id).join(", ")})`);
  }

  const [scan] = await sql`
    select id, status, started_at, completed_at, error, direction_score, provisional, family_scores, takeaways
    from scans where company_id = ${company.id} order by started_at desc limit 1`;
  if (!scan) return Response.json({ company: { ticker: company.ticker, name: company.name }, scan: null });

  const runRows = await sql`
    select source_key, status, duration_ms, items_read, error, streaming_url, result
    from source_runs where scan_id = ${scan.id} order by id`;
  const count = (status: string) => runRows.filter((r) => r.status === status).length;

  const samples = await sql`
    select source_key, quote, source_label, to_char(published_at, 'YYYY-MM-DD') as published_at
    from evidence where scan_id = ${scan.id} order by id desc limit 18`;

  const familyScores = (scan.family_scores ?? {}) as Partial<Record<Family, { score: number }>>;
  const families = Object.fromEntries(
    (Object.keys(familyScores) as Family[]).map((f) => [f, { score: familyScores[f]!.score, weight: FAMILY_WEIGHTS[f] }]),
  );
  const takeawaysMeta = scan.takeaways as { items?: unknown[]; cycle?: unknown } | null;

  return Response.json({
    company: { ticker: company.ticker, name: company.name },
    scan: {
      id: Number(scan.id),
      status: String(scan.status),
      startedAt: scan.started_at,
      completedAt: scan.completed_at,
      error: (scan.error as string | null) ?? null,
    },
    sources: { total: runRows.length, complete: count("complete"), failed: count("failed"), running: count("running") },
    working: runRows.filter((r) => r.status === "running").map((r) => String(r.source_key)),
    runs: runRows.map((r) => {
      const meta = metaFor(String(r.source_key), r.result);
      return {
        key: String(r.source_key),
        label: meta.label,
        family: meta.family,
        status: String(r.status),
        durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
        itemsRead: r.items_read != null ? Number(r.items_read) : null,
        error: (r.error as string | null) ?? null,
        streamingUrl: (r.streaming_url as string | null) ?? null,
      };
    }),
    samples: samples.map((s) => ({
      source_key: String(s.source_key),
      quote: String(s.quote),
      source_label: String(s.source_label),
      published_at: (s.published_at as string | null) ?? null,
    })),
    read: {
      score: scan.direction_score != null ? Number(scan.direction_score) : null,
      provisional: Boolean(scan.provisional),
      families,
      takeaways: takeawaysMeta?.items ?? [],
      cycle: takeawaysMeta?.cycle ?? null,
    },
  });
}
