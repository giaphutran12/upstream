import type { Sql } from "postgres";
import { computeDeltas, type ScanDeltas } from "./movers";

// The read: three conclusions an analyst opens with — what we found, why it
// matters, what it changes. The model gets ONLY numbers and quotes that exist
// in the database (deltas computed in code, evidence verbatim-gated upstream),
// and is ordered to repeat them, not invent them.

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";

export type Takeaway = {
  finding: string;
  why_it_matters: string;
  what_it_changes: string;
  sources: string[];
};

export async function synthesizeTakeaways(
  sql: Sql,
  opts: { companyId: number; companyName: string; ticker: string; scanId: number },
): Promise<{ takeaways: Takeaway[]; deltas: ScanDeltas } | null> {
  const deltas = await computeDeltas(sql, opts.companyId, opts.scanId);

  const evidence = await sql`
    select quote, family, source_label, published_at from evidence
    where scan_id = ${opts.scanId}
    order by abs(coalesce(sentiment, 0)) desc, published_at desc nulls last
    limit 18`;
  const [leadTime] = await sql`
    select lead_days, narrative, signal_metric from lead_time_reads
    where company_id = ${opts.companyId} order by created_at desc limit 1`;
  const events = await sql`
    select event_type, title, occurred_on from official_events
    where company_id = ${opts.companyId} order by occurred_on desc limit 5`;

  // counted-at-scale digest: one line per dimension, totals that actually add up
  const footprintDigest = await sql`
    select dimension, count(*)::int as distinct_keys, sum(count)::int as total
    from footprint_counts where scan_id = ${opts.scanId} group by dimension`;

  const facts = {
    company: `${opts.companyName} (${opts.ticker})`,
    direction_score: deltas.score,
    family_scores: deltas.families,
    metrics: deltas.metrics,
    counted_at_scale: Object.fromEntries(
      footprintDigest.map((r) => [
        r.dimension,
        { total: Number(r.total), across: `${r.distinct_keys} ${String(r.dimension).split("_").pop()}s` },
      ]),
    ),
    footprint_changes_since_last_scan: deltas.footprintMoves.slice(0, 12),
    is_first_scan: deltas.previousScanId == null,
    measured_lead_time: leadTime
      ? { lead_days: leadTime.lead_days, narrative: leadTime.narrative, metric: leadTime.signal_metric }
      : null,
    official_events: events.map((e) => ({ type: e.event_type, title: e.title, on: e.occurred_on })),
    evidence: evidence.map((e) => ({
      family: e.family,
      source: e.source_label,
      date: e.published_at,
      quote: e.quote,
    })),
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an equity research analyst writing the top of a company page. From the scan data provided (all of it measured or verbatim-scraped — nothing else exists), write EXACTLY 3 takeaways. STRICT JSON:
{"takeaways":[{"finding":"one sentence: the conclusion, stated plainly, with its number(s)","why_it_matters":"one sentence: the business consequence","what_it_changes":"one sentence: what a reader should do or watch differently","sources":["source labels used"]}]}
Rules:
- A takeaway is a CONCLUSION, not a report. Test: if the sentence could have been written by reading one source's summary line, it fails. Every finding must JOIN at least two different sources or dimensions (complaint trend × store footprint, hiring mix × leadership timeline, outage reports × review velocity) and state what the combination means for the business.
- State the conclusion first; numbers arrive as the supporting clause. Never open with "<Source> remains at / shows / reports…".
- Every number, date, and quote fragment MUST appear verbatim in the data. Never estimate, extrapolate, or fill gaps. If the data is too thin to support a join, say precisely what is missing and what the next scan will resolve — never pad.
- what_it_changes must be decision-relevant and falsifiable: a stated expectation for coming scans, a thesis strengthened or weakened, or a threshold that would flip the read. "Watch/monitor/track X" phrasing may appear at most once across all three takeaways.
- If a measured lead time exists, exactly one takeaway must calibrate today's leading signal against it: the signal family led the last official filing by N days — say what that same family is doing right now and what that implies about where the company is in that cycle.
- Lead with movement (deltas since the last scan) when it exists; on a first scan, say the baseline is set and what the next scan will resolve.
- Takeaways are about the company's business — customers, stores, hiring, leadership, operations. The scoring system itself is never the subject; family score moves are supporting color only.
- Direction-of-business language only. No buy/sell/hold advice, no price targets.
- sources: only labels present in the data (e.g. "Reddit", "SEC EDGAR", "Company sitemap").`,
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.log(`synthesize: OpenAI ${response.status} — ${body.slice(0, 200)}`);
    return null;
  }
  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  let parsed: { takeaways?: Takeaway[] };
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    console.log("synthesize: model returned unparseable JSON — takeaways skipped");
    return null;
  }
  const takeaways = (parsed.takeaways ?? [])
    .filter((t) => t.finding && t.why_it_matters && t.what_it_changes)
    .slice(0, 3)
    .map((t) => ({ ...t, sources: Array.isArray(t.sources) ? t.sources.slice(0, 4) : [] }));
  if (takeaways.length === 0) {
    console.log("synthesize: model returned no usable takeaways");
    return null;
  }

  await sql`
    update scans set takeaways = ${sql.json({ generated_at: new Date().toISOString(), model: MODEL, items: takeaways } as never)}
    where id = ${opts.scanId}`;
  console.log(`synthesize: scan ${opts.scanId} — ${takeaways.length} takeaways saved`);
  return { takeaways, deltas };
}
