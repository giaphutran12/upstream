import type { Sql } from "postgres";
import type { Family } from "./sources";

// Scan-over-scan deltas, computed in code. "The delta is the product, not the
// snapshot" — this module answers "what moved" so the UI and the synthesis
// prompt only ever repeat numbers that exist in the database.

export type MetricMove = {
  metricKey: string;
  family: Family;
  unit: string | null;
  previous: number | null;
  current: number;
  deltaPct: number | null; // null when no baseline
  sources: string | null;
};

export type FootprintMove = {
  dimension: string; // stores_by_state | jobs_by_department | jobs_by_market
  key: string;
  previous: number | null;
  current: number | null; // null = disappeared entirely
  delta: number;
};

export type ScanDeltas = {
  scanId: number;
  previousScanId: number | null;
  previousScanAt: string | null;
  score: { previous: number | null; current: number | null };
  families: Record<string, { previous: number | null; current: number | null }>;
  metrics: MetricMove[];
  footprintTotals: Record<string, { previous: number | null; current: number }>;
  footprintMoves: FootprintMove[]; // only keys that actually changed
};

export async function computeDeltas(sql: Sql, companyId: number, scanId: number): Promise<ScanDeltas> {
  const [current] = await sql`
    select id, direction_score, family_scores from scans where id = ${scanId}`;
  // baseline = a scan far enough back to mean something (≥20h), not one from
  // ten minutes ago; when all history is young, use the earliest scan so the
  // window is as wide as the data allows
  let [previous] = await sql`
    select id, direction_score, family_scores, completed_at from scans
    where company_id = ${companyId} and status = 'complete' and id < ${scanId} and direction_score is not null
      and completed_at < now() - interval '20 hours'
    order by id desc limit 1`;
  if (!previous) {
    [previous] = await sql`
      select id, direction_score, family_scores, completed_at from scans
      where company_id = ${companyId} and status = 'complete' and id < ${scanId} and direction_score is not null
      order by id asc limit 1`;
  }

  const currentFamilies = (current?.family_scores ?? {}) as Record<string, { score: number }>;
  const previousFamilies = (previous?.family_scores ?? {}) as Record<string, { score: number }>;
  const families: ScanDeltas["families"] = {};
  for (const key of new Set([...Object.keys(currentFamilies), ...Object.keys(previousFamilies)])) {
    families[key] = {
      previous: previousFamilies[key]?.score ?? null,
      current: currentFamilies[key]?.score ?? null,
    };
  }

  const currentMetrics = await sql`
    select metric_key, family, value, unit, sources from signal_metrics where scan_id = ${scanId}`;
  const previousMetrics = previous
    ? await sql`select metric_key, value from signal_metrics where scan_id = ${previous.id}`
    : [];
  const previousByKey = new Map(previousMetrics.map((m) => [m.metric_key as string, Number(m.value)]));

  const metrics: MetricMove[] = currentMetrics.map((m) => {
    const prev = previousByKey.get(m.metric_key as string) ?? null;
    const value = Number(m.value);
    return {
      metricKey: m.metric_key as string,
      family: m.family as Family,
      unit: (m.unit as string) ?? null,
      previous: prev,
      current: value,
      deltaPct: prev != null && prev !== 0 ? Math.round(((value - prev) / Math.abs(prev)) * 1000) / 10 : null,
      sources: (m.sources as string) ?? null,
    };
  });

  const currentCounts = await sql`
    select dimension, key, count from footprint_counts where scan_id = ${scanId}`;
  const previousCounts = previous
    ? await sql`select dimension, key, count from footprint_counts where scan_id = ${previous.id}`
    : [];
  // NUL separator: count keys contain spaces ("New York, NY"), NUL never does
  const prevCount = new Map(previousCounts.map((c) => [`${c.dimension}\u0000${c.key}`, Number(c.count)]));
  const currCount = new Map(currentCounts.map((c) => [`${c.dimension}\u0000${c.key}`, Number(c.count)]));

  const footprintTotals: ScanDeltas["footprintTotals"] = {};
  for (const c of currentCounts) {
    const dim = c.dimension as string;
    (footprintTotals[dim] ??= { previous: previousCounts.length ? 0 : null, current: 0 }).current += Number(c.count);
  }
  for (const c of previousCounts) {
    const dim = c.dimension as string;
    if (footprintTotals[dim]) footprintTotals[dim].previous = (footprintTotals[dim].previous ?? 0) + Number(c.count);
  }

  const footprintMoves: FootprintMove[] = [];
  for (const key of new Set([...prevCount.keys(), ...currCount.keys()])) {
    const [dimension, k] = key.split("\u0000");
    const prev = prevCount.get(key) ?? null;
    const curr = currCount.get(key) ?? null;
    // a key only moves when both scans measured its dimension
    if (!footprintTotals[dimension] || footprintTotals[dimension].previous == null) continue;
    if ((prev ?? 0) === (curr ?? 0)) continue;
    footprintMoves.push({ dimension, key: k, previous: prev, current: curr, delta: (curr ?? 0) - (prev ?? 0) });
  }
  footprintMoves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    scanId,
    previousScanId: previous ? Number(previous.id) : null,
    previousScanAt: previous?.completed_at ? new Date(previous.completed_at as string).toISOString() : null,
    score: {
      previous: previous?.direction_score != null ? Number(previous.direction_score) : null,
      current: current?.direction_score != null ? Number(current.direction_score) : null,
    },
    families,
    metrics,
    footprintTotals,
    footprintMoves,
  };
}
