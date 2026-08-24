import type { Sql } from "postgres";

// The reporting cycle, framed in code: anchor on the company's most recent
// periodic report (10-Q/10-K — every listed company has one), split evidence
// at that date. Evidence dated after the anchor is THIS cycle's early signal —
// the thing that led the filing by 84 days in the calibration case.

export type CycleFrame = {
  anchor: { form: string; occurred_on: string; url: string | null } | null;
  daysSinceAnchor: number | null;
  expectedNextOn: string | null; // anchor + ~91 days, labeled "expected"
  daysUntilExpected: number | null;
  freshSignals: { quote: string; source_label: string; published_at: string; family: string }[];
  freshCount: number;
  priorCycleCount: number; // dated evidence from before the anchor (context, not signal)
  officerChangeSinceAnchor: { title: string; occurred_on: string } | null;
  measuredLeadDays: number | null; // calibration from lead_time_reads when it exists
};

export async function computeCycle(sql: Sql, companyId: number): Promise<CycleFrame> {
  const [anchor] = await sql`
    select title, occurred_on, url from official_events
    where company_id = ${companyId} and event_type = 'periodic_report'
    order by occurred_on desc limit 1`;

  const [leadTime] = await sql`
    select lead_days from lead_time_reads where company_id = ${companyId} order by created_at desc limit 1`;

  if (!anchor) {
    return {
      anchor: null,
      daysSinceAnchor: null,
      expectedNextOn: null,
      daysUntilExpected: null,
      freshSignals: [],
      freshCount: 0,
      priorCycleCount: 0,
      officerChangeSinceAnchor: null,
      measuredLeadDays: leadTime ? Number(leadTime.lead_days) : null,
    };
  }

  const anchorOn = isoDay(anchor.occurred_on);
  const day = 86_400_000;
  const daysSinceAnchor = Math.floor((Date.now() - Date.parse(anchorOn)) / day);
  const expectedNext = new Date(Date.parse(anchorOn) + 91 * day);
  const expectedNextOn = expectedNext.toISOString().slice(0, 10);

  // freshest dated evidence after the anchor, strongest sentiment first
  const fresh = await sql`
    select quote, source_label, published_at, family from evidence
    where company_id = ${companyId} and published_at > ${anchorOn}::date
    order by published_at desc, abs(coalesce(sentiment, 0)) desc limit 10`;
  const [counts] = await sql`
    select
      count(*) filter (where published_at > ${anchorOn}::date) as fresh,
      count(*) filter (where published_at <= ${anchorOn}::date) as prior
    from evidence where company_id = ${companyId} and published_at is not null`;

  const [officerChange] = await sql`
    select title, occurred_on from official_events
    where company_id = ${companyId} and event_type = '8k_502' and occurred_on > ${anchorOn}::date
    order by occurred_on desc limit 1`;

  return {
    anchor: { form: String(anchor.title).replace(" filed", ""), occurred_on: anchorOn, url: anchor.url as string | null },
    daysSinceAnchor,
    expectedNextOn,
    daysUntilExpected: Math.floor((expectedNext.getTime() - Date.now()) / day),
    freshSignals: fresh.map((e) => ({
      quote: String(e.quote),
      source_label: String(e.source_label),
      published_at: isoDay(e.published_at),
      family: String(e.family),
    })),
    freshCount: Number(counts?.fresh ?? 0),
    priorCycleCount: Number(counts?.prior ?? 0),
    officerChangeSinceAnchor: officerChange
      ? { title: String(officerChange.title), occurred_on: isoDay(officerChange.occurred_on) }
      : null,
    measuredLeadDays: leadTime ? Number(leadTime.lead_days) : null,
  };
}

/** postgres returns date columns as JS Dates — String() on those is NOT ISO. */
function isoDay(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
