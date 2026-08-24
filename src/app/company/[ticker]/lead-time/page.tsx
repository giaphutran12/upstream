import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { TopBar } from "@/components/TopBar";
import { MeasureLeadTime } from "@/components/MeasureLeadTime";
import { CycleStrip, type CycleCallRow } from "@/components/CycleStrip";
import { CycleTimeline } from "@/components/CycleTimeline";

export const dynamic = "force-dynamic";

type SeriesPoint = { t: string; v: number };
type EventMark = { title: string; occurred_on: string; is_key: boolean; url: string | null };

export default async function LeadTimePage({ params }: PageProps<"/company/[ticker]/lead-time">) {
  const { ticker } = await params;
  const sql = db();

  const [company] = await sql`select id, ticker, name from companies where ticker = ${ticker.toUpperCase()}`;
  // never-scanned ticker: the company page runs the first scan inline
  if (!company) redirect(`/company/${encodeURIComponent(ticker.toUpperCase())}`);

  const [read] = await sql`
    select signal_metric, signal_start_on, signal_rule, filed_on, lead_days, narrative, series
    from lead_time_reads where company_id = ${company.id} order by created_at desc limit 1`;

  // this cycle, for any company: filings are the anchors, dated evidence is the signal
  const cycleEvents = await sql`
    select distinct on (event_type, occurred_on) event_type, title, occurred_on, url from official_events
    where company_id = ${company.id} and event_type in ('periodic_report', '8k_502')
      and occurred_on > now() - interval '15 months'
    order by event_type, occurred_on asc`;
  cycleEvents.sort((a, b) => new Date(a.occurred_on as string).getTime() - new Date(b.occurred_on as string).getTime());
  const datedEvidence = await sql`
    select published_at, family, quote, source_label from evidence
    where company_id = ${company.id} and published_at is not null
      and published_at > now() - interval '15 months'
    order by published_at asc limit 300`;
  const [latestScan] = await sql`
    select takeaways from scans
    where company_id = ${company.id} and status = 'complete' and takeaways is not null
    order by started_at desc limit 1`;
  const cycleCall = (latestScan?.takeaways as { cycle?: CycleCallRow | null } | null)?.cycle ?? null;

  const anchor = [...cycleEvents].reverse().find((e) => e.event_type === "periodic_report");
  const anchorOn = anchor ? isoDay(anchor.occurred_on) : null;
  const expectedOn = anchorOn ? new Date(Date.parse(anchorOn) + 91 * 86_400_000).toISOString().slice(0, 10) : null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const daysSinceAnchor = anchorOn ? Math.floor((Date.now() - Date.parse(anchorOn)) / 86_400_000) : null;
  const daysUntilExpected = expectedOn ? Math.ceil((Date.parse(expectedOn) - Date.now()) / 86_400_000) : null;
  const freshCount = anchorOn ? datedEvidence.filter((e) => isoDay(e.published_at) > anchorOn).length : 0;

  const timeline = layoutCycleTimeline(
    cycleEvents.map((e) => ({
      type: String(e.event_type),
      title: String(e.title),
      on: isoDay(e.occurred_on),
      url: e.url as string | null,
    })),
    // future-dated announcements (a layoff effective next month) stay in evidence
    // but never plot right of TODAY — the chart is the record so far
    datedEvidence
      .map((e) => ({
        on: isoDay(e.published_at),
        family: String(e.family),
        quote: String(e.quote),
        sourceLabel: String(e.source_label),
      }))
      .filter((e) => e.on <= todayIso),
    anchorOn,
    expectedOn,
    expectedOn
      ? `next report · expected ~${formatDay(expectedOn)}${daysUntilExpected != null && daysUntilExpected >= 0 ? ` · in ${daysUntilExpected} days` : ""}`
      : null,
  );

  return (
    <main className="min-h-screen">
      <TopBar active="lead" ticker={company.ticker} />

      <div className="max-w-[1100px] px-12 pb-5 pt-12">
        <div className="eyebrow mb-3.5" style={{ color: "var(--color-rust)", letterSpacing: "0.16em" }}>
          Lead-time analysis · {company.ticker} — {company.name}
        </div>
        {read ? (
          <>
            <h1 className="font-serif text-[50px] font-medium leading-[1.05] tracking-tight">
              Last cycle, customers turned <span style={{ color: "var(--color-rust)" }}>{read.lead_days} days</span> before the
              filing. Where is this cycle?
            </h1>
            <div className="mt-4 max-w-[760px] text-[15px] leading-relaxed text-muted">
              {String(read.signal_metric).replaceAll("_", " ")} began a sustained rise on {formatDay(String(read.signal_start_on))};
              the filing reached EDGAR {read.lead_days} days later. That calibration is the yardstick for the signals arriving now.
            </div>
          </>
        ) : (
          <>
            <h1 className="font-serif text-[50px] font-medium leading-[1.05] tracking-tight">This cycle, watched live.</h1>
            <div className="mt-4 max-w-[760px] text-[15px] leading-relaxed text-muted">
              Every listed company reports on a cycle. The filings below are its official record; the dots are dated customer
              evidence collected from primary sources — the signal that precedes the record.
            </div>
          </>
        )}
      </div>

      <div className="max-w-[1100px] px-12 pt-4">
        {cycleCall ? (
          <CycleStrip cycle={cycleCall} />
        ) : (
          <div className="card card--queued py-5 text-center text-[13px] text-muted">
            No cycle call yet — <a href={`/company/${company.ticker}`}>open the company read</a>; a fresh scan generates it.
          </div>
        )}
      </div>

      {timeline && (
        <div className="px-12 pt-9">
          <div className="rule-ink mb-2 flex items-baseline gap-4 pb-2">
            <div className="eyebrow" style={{ letterSpacing: "0.14em" }}>
              The reporting cycle · trailing 15 months
            </div>
            <div className="text-[11px] text-muted tnum">
              ■ SEC filing (<span style={{ color: "var(--color-rust)" }}>rust</span> = officer change) · ● customer evidence at
              its own date (<span style={{ color: "var(--color-rust)" }}>rust</span> = this cycle, gray = before the last
              report) · □ expected next report
            </div>
          </div>
          <CycleTimeline
            timeline={timeline}
            ariaLabel={`Reporting-cycle timeline for ${company.name}: official filings and dated customer evidence.`}
            bracketLabel={`THIS CYCLE · ${freshCount} SIGNAL${freshCount === 1 ? "" : "S"} · ${daysSinceAnchor} DAYS → TODAY`}
          />
          <div className="rule-hairline max-w-[900px] pt-2.5 text-[11px] leading-normal text-muted" style={{ borderTop: "1px solid var(--color-hairline)", borderBottom: "none" }}>
            Squares: SEC filings (rust = officer change, 8-K Item 5.02). Dots: customer evidence at its published date — rust dots
            landed after the latest periodic report, i.e. this cycle. The hollow square is the next report, estimated at 91 days,
            labeled expected. Evidence accumulates with every scan.
          </div>
        </div>
      )}

      {!timeline && (
        <div className="max-w-[760px] px-12 pt-9 text-[14px] leading-relaxed text-muted">
          No filings ingested yet for {company.name} — <a href={`/company/${company.ticker}`}>open the company read</a>; SEC
          EDGAR lands in seconds and this timeline builds itself.
        </div>
      )}

      {read ? (
        <BacktestChart read={read as never} events={(await sql`
          select distinct on (occurred_on) title, occurred_on, is_key, url from official_events
          where company_id = ${company.id} and occurred_on >= ${read.signal_start_on}::date - interval '90 days'
          order by occurred_on asc, is_key desc limit 3`) as unknown as EventMark[]} />
      ) : (
        <div className="max-w-[760px] px-12 pb-16 pt-10">
          <div className="rule-ink mb-3 pb-2">
            <div className="eyebrow" style={{ letterSpacing: "0.14em" }}>Measure the last cycle</div>
          </div>
          <MeasureLeadTime ticker={company.ticker} />
        </div>
      )}
    </main>
  );
}

function BacktestChart({ read, events }: { read: { signal_metric: string; signal_start_on: string; signal_rule: string; filed_on: string; lead_days: number; narrative: string; series: SeriesPoint[] }; events: EventMark[] }) {
  const series = read.series;
  const chart = layoutChart(series, String(read.signal_start_on), String(read.filed_on), events);
  const startLabel = formatDay(String(read.signal_start_on));
  const filedLabel = formatDay(String(read.filed_on));
  return (
    <>
      <div className="px-12 pt-10">
        <div className="rule-ink mb-2 flex items-baseline gap-4 pb-2">
          <div className="eyebrow" style={{ letterSpacing: "0.14em" }}>
            Last cycle, measured · {String(read.signal_metric).replaceAll("_", " ")}, indexed
          </div>
          <div className="text-[11px] text-muted tnum">{formatDay(series[0].t)} = 100 · weekly</div>
        </div>
        {/* the signature: measured gap between signal turn and filing */}
        <svg viewBox="0 0 1240 440" className="block w-full" role="img"
          aria-label={`${read.narrative} Signal start ${startLabel}, filing ${filedLabel}.`}>
          {chart.gridY.map((y, i) => (
            <g key={i}>
              <line x1={60} y1={y.px} x2={1180} y2={y.px} stroke="var(--color-hairline)" strokeWidth={1} />
              <text x={52} y={y.px + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">{y.label}</text>
            </g>
          ))}
          <rect x={chart.startX} y={36} width={chart.filedX - chart.startX} height={266} fill="var(--color-rust)" opacity={0.06} />
          <line x1={chart.startX} y1={32} x2={chart.startX} y2={302} stroke="var(--color-rust)" strokeWidth={1} strokeDasharray="2 4" opacity={0.6} />
          <line x1={chart.filedX} y1={32} x2={chart.filedX} y2={302} stroke="var(--color-rust)" strokeWidth={1} strokeDasharray="2 4" opacity={0.6} />
          <line x1={chart.startX} y1={26} x2={chart.filedX} y2={26} stroke="var(--color-rust)" strokeWidth={1.5} />
          <line x1={chart.startX} y1={20} x2={chart.startX} y2={32} stroke="var(--color-rust)" strokeWidth={1.5} />
          <line x1={chart.filedX} y1={20} x2={chart.filedX} y2={32} stroke="var(--color-rust)" strokeWidth={1.5} />
          <text x={(chart.startX + chart.filedX) / 2} y={152} textAnchor="middle" fontFamily="var(--font-serif)" fontSize={122} fontWeight={500} fill="var(--color-rust)">
            {read.lead_days}
          </text>
          <text x={(chart.startX + chart.filedX) / 2} y={186} textAnchor="middle" fontSize={13} letterSpacing={3} fill="var(--color-ink)">
            DAYS BEFORE THE FILING
          </text>
          <polyline points={chart.linePoints} fill="none" stroke="var(--color-ink)" strokeWidth={2} />
          <circle cx={chart.startX} cy={chart.startY} r={4.5} fill="var(--color-rust)" />
          <line x1={60} y1={302} x2={1180} y2={302} stroke="var(--color-ink)" strokeWidth={1.5} />
          {chart.months.map((m) => (
            <text key={m.label} x={m.px} y={320} fontSize={10.5} fill="var(--color-muted)">{m.label}</text>
          ))}
          <line x1={chart.startX} y1={306} x2={chart.startX} y2={chart.signalMark.labelY - 12} stroke="var(--color-rust)" strokeWidth={1} />
          {chart.eventMarks.map((mark, i) => (
            <g key={i}>
              <rect x={mark.px - 3} y={299} width={6} height={6} fill={mark.isKey ? "var(--color-rust)" : "var(--color-ink)"} />
              <line x1={mark.px} y1={306} x2={mark.px} y2={mark.labelY - 12} stroke={mark.isKey ? "var(--color-rust)" : "var(--color-muted)"} strokeWidth={1} />
            </g>
          ))}
          {/* all labels after all leaders; the paper halo keeps glyphs clean
              even on the fallback path where a leader may still cross */}
          <text x={chart.signalMark.anchorEnd ? chart.startX - 8 : chart.startX + 8} y={chart.signalMark.labelY}
            textAnchor={chart.signalMark.anchorEnd ? "end" : "start"} fontSize={12} fontWeight={600} fill="var(--color-rust)"
            paintOrder="stroke" stroke="var(--color-paper)" strokeWidth={3.5} strokeLinejoin="round">
            Signal turns · {startLabel}
          </text>
          {chart.eventMarks.map((mark, i) => (
            <text key={`label-${i}`} x={mark.anchorEnd ? mark.px - 6 : mark.px + 7} y={mark.labelY}
              textAnchor={mark.anchorEnd ? "end" : "start"} fontSize={mark.isKey ? 12 : 11.5}
              fontWeight={mark.isKey ? 600 : 400} fill={mark.isKey ? "var(--color-ink)" : "var(--color-muted)"}
              paintOrder="stroke" stroke="var(--color-paper)" strokeWidth={3.5} strokeLinejoin="round">
              {mark.title} · {formatDay(mark.date)}
            </text>
          ))}
        </svg>
        <div className="rule-hairline max-w-[900px] pt-2.5 text-[11px] leading-normal text-muted" style={{ borderTop: "1px solid var(--color-hairline)", borderBottom: "none" }}>
          Line: {String(read.signal_metric).replaceAll("_", " ")} per week across primary sources, indexed to the week of {formatDay(series[0].t)} = 100.
          Events: company press releases and SEC filings, dated as published. Sources scraped continuously.
        </div>
      </div>

      <div className="grid max-w-[1100px] grid-cols-3 gap-11 px-12 pb-16 pt-9 max-md:grid-cols-1">
        <div className="pt-3.5" style={{ borderTop: "1px solid var(--color-ink)" }}>
          <div className="eyebrow mb-2 text-muted" style={{ letterSpacing: "0.14em" }}>Signal start</div>
          <div className="font-serif text-2xl font-medium">{startLabel}</div>
          <div className="mt-1.5 text-[12.5px] leading-normal text-muted">{read.signal_rule}.</div>
        </div>
        <div className="pt-3.5" style={{ borderTop: "1px solid var(--color-ink)" }}>
          <div className="eyebrow mb-2 text-muted" style={{ letterSpacing: "0.14em" }}>Official filing</div>
          <div className="font-serif text-2xl font-medium">{filedLabel}</div>
          <div className="mt-1.5 text-[12.5px] leading-normal text-muted">
            Form 8-K, Item 5.02 — departure or appointment of officers.{" "}
            {events.find((e) => e.is_key)?.url && (
              <a href={events.find((e) => e.is_key)!.url!} target="_blank" rel="noreferrer" className="text-[12.5px]">
                View on EDGAR →
              </a>
            )}
          </div>
        </div>
        <div className="pt-3.5" style={{ borderTop: "1px solid var(--color-rust)" }}>
          <div className="eyebrow mb-2" style={{ color: "var(--color-rust)", letterSpacing: "0.14em" }}>Lead time</div>
          <div className="font-serif text-2xl font-medium" style={{ color: "var(--color-rust)" }}>{read.lead_days} days</div>
          <div className="mt-1.5 text-[12.5px] leading-normal text-muted">
            The measured gap between the first sustained customer signal and the official record.
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One collision model for every annotation a timeline draws. A rendered mark
 * is TWO primitives: a text box in some lane, and a vertical leader at px that
 * crosses every lane above that one — so a placement is legal only if no
 * leader pierces any text box and no text boxes overlap in a lane. DFS over
 * (lane, anchor side) per mark, rightmost first; returns null when no legal
 * layout exists within `lanes` lanes (callers fall back and rely on the halo).
 */
function placeLabels(
  marks: { px: number; w: number; anchorEnd: boolean }[],
  lanes: number,
  minX: number,
  maxX: number,
): { lane: number; anchorEnd: boolean }[] | null {
  const order = marks.map((_, i) => i).sort((a, b) => marks[b].px - marks[a].px);
  const placed: { px: number; start: number; end: number; lane: number }[] = [];
  const result: { lane: number; anchorEnd: boolean }[] = new Array(marks.length);
  let nodes = 0;
  const legal = (c: { px: number; start: number; end: number; lane: number }) =>
    placed.every(
      (p) =>
        !(p.lane === c.lane && c.start <= p.end && p.start <= c.end) && // text overprints text
        !(p.lane > c.lane && c.start < p.px && p.px < c.end) && // p's leader pierces c's text
        !(c.lane > p.lane && p.start < c.px && c.px < p.end), // c's leader pierces p's text
    );
  const dfs = (k: number): boolean => {
    if (k === order.length) return true;
    if (++nodes > 20_000) return false;
    const m = marks[order[k]];
    for (let lane = 0; lane < lanes; lane++) {
      for (const anchorEnd of [m.anchorEnd, !m.anchorEnd]) {
        const start = anchorEnd ? m.px - m.w : m.px;
        const end = anchorEnd ? m.px : m.px + m.w;
        if (start < minX || end > maxX) continue;
        const cand = { px: m.px, start, end, lane };
        if (!legal(cand)) continue;
        placed.push(cand);
        if (dfs(k + 1)) {
          result[order[k]] = { lane, anchorEnd };
          return true;
        }
        placed.pop();
      }
    }
    return false;
  };
  return dfs(0) ? result : null;
}

function layoutCycleTimeline(
  events: { type: string; title: string; on: string; url: string | null }[],
  evidence: { on: string; family: string; quote: string; sourceLabel: string }[],
  anchorOn: string | null,
  expectedOn: string | null,
  expectedLabel: string | null,
) {
  if (events.length === 0 && evidence.length === 0) return null;
  const x0 = 60, x1 = 1180;
  const day = 86_400_000;
  const today = Date.now();
  const times = [...events.map((e) => Date.parse(e.on)), ...evidence.map((e) => Date.parse(e.on)), today];
  const t0 = Math.min(...times) - 10 * day;
  const t1 = Math.max(today, expectedOn ? Date.parse(expectedOn) : today) + 14 * day;
  const xOf = (t: number) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);

  // labels and their leader lines share one collision model (placeLabels):
  // the solver assigns each mark a lane and anchor side so no leader ever
  // pierces another label's text. The expected-report label rides the same
  // lanes — below the axis, no dots there.
  const marks = events.map((event) => {
    const px = Math.round(xOf(Date.parse(event.on)));
    const label =
      event.type === "8k_502"
        ? `Officer change (8-K) · ${formatDay(event.on)}`
        : `${event.title.replace(" filed", "")} · ${formatDay(event.on)}`;
    return { px, label, isKey: event.type === "8k_502", expected: false, anchorEnd: px > 960 };
  });
  if (expectedOn && expectedLabel) {
    const px = Math.round(xOf(Date.parse(expectedOn)));
    marks.push({ px, label: expectedLabel, isKey: false, expected: true, anchorEnd: px > 860 });
  }
  marks.sort((a, b) => a.px - b.px);
  const widths = marks.map((m) => m.label.length * (m.isKey || m.expected ? 7.4 : 6.4) + 16);
  const placement = placeLabels(
    marks.map((m, i) => ({ px: m.px, w: widths[i], anchorEnd: m.anchorEnd })),
    4,
    8,
    1232,
  );
  let filings: ((typeof marks)[number] & { labelY: number })[];
  if (placement) {
    console.log(`[lead-time] cycle timeline: placed ${marks.length} labels with zero leader-text crossings`);
    filings = marks.map((mark, i) => ({ ...mark, anchorEnd: placement[i].anchorEnd, labelY: 152 + placement[i].lane * 21 }));
  } else {
    console.warn(
      `[lead-time] cycle timeline: no crossing-free layout for ${marks.length} labels within 4 lanes — greedy lanes, text halo covers crossings`,
    );
    const laneEnds: number[] = [];
    filings = marks.map((mark, i) => {
      const start = mark.anchorEnd ? mark.px - widths[i] : mark.px;
      const end = mark.anchorEnd ? mark.px : mark.px + widths[i];
      let lane = laneEnds.findIndex((laneEnd) => start > laneEnd);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      return { ...mark, labelY: 152 + lane * 21 };
    });
  }

  // evidence dots stack upward when several land the same week; each dot
  // keeps its source + verbatim quote so the hover can name the exact signal
  const weekCounts = new Map<number, number>();
  const dots = evidence.map((item) => {
    const t = Date.parse(item.on);
    const week = Math.floor(t / (7 * day));
    const stack = weekCounts.get(week) ?? 0;
    weekCounts.set(week, stack + 1);
    return {
      px: Math.round(xOf(t)),
      // stacks cap at 5 rows so dots never climb into the annotation band up top
      py: 104 - Math.min(stack, 4) * 11,
      fresh: anchorOn != null && item.on > anchorOn,
      on: item.on,
      family: item.family,
      quote: item.quote,
      sourceLabel: item.sourceLabel,
    };
  });

  const months: { label: string; px: number }[] = [];
  const cursor = new Date(t0);
  cursor.setDate(1);
  while (cursor.getTime() <= t1) {
    if (cursor.getTime() >= t0) {
      const px = Math.round(xOf(cursor.getTime()));
      if (filings.every((f) => Math.abs(f.px - px) > 40)) {
        months.push({ label: cursor.toLocaleDateString("en-US", { month: "short" }).toUpperCase(), px });
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return {
    filings,
    dots,
    months,
    todayX: Math.round(xOf(today)),
    expectedX: expectedOn ? Math.round(xOf(Date.parse(expectedOn))) : null,
    cycleShade: anchorOn ? { x0: Math.round(xOf(Date.parse(anchorOn))), x1: Math.round(xOf(today)) } : null,
  };
}

function layoutChart(series: SeriesPoint[], startOn: string, filedOn: string, events: EventMark[]) {
  const x0 = 60, x1 = 1180, yTop = 55, yBase = 288;
  const t0 = new Date(series[0].t).getTime();
  const t1 = new Date(series[series.length - 1].t).getTime();
  const xOf = (iso: string) => x0 + ((new Date(iso).getTime() - t0) / (t1 - t0)) * (x1 - x0);
  const values = series.map((p) => p.v);
  const vMin = 100, vMax = Math.max(...values);
  const yOf = (v: number) => yBase - ((v - vMin) / (vMax - vMin || 1)) * (yBase - yTop);

  const linePoints = series.map((p) => `${xOf(p.t).toFixed(0)},${yOf(p.v).toFixed(0)}`).join(" ");
  const startX = Math.round(xOf(startOn));
  const filedX = Math.round(xOf(filedOn));
  const startPoint = series.find((p) => p.t >= startOn) ?? series[0];

  const step = Math.ceil((vMax - vMin) / 3 / 50) * 50 || 50;
  const gridY = [];
  for (let v = vMin; v <= vMax; v += step) gridY.push({ label: `${v}`, px: Math.round(yOf(v)) });

  const eventLabels = events.map((event) => ({
    px: Math.round(xOf(String(event.occurred_on))),
    date: String(event.occurred_on),
    title: shorten(event.title.replace(/ \(8-K.*\)/, " (8-K)"), 30),
    isKey: event.is_key,
  }));
  // the signal-turn label rides the same lanes as event labels — one collision
  // model (placeLabels) covering text boxes AND leader lines for all of them
  const signalLabel = `Signal turns · ${formatDay(startOn)}`;
  const labelMarks = [
    { px: startX, w: signalLabel.length * 7.4 + 16, anchorEnd: true },
    ...eventLabels.map((m) => ({
      px: m.px,
      w: `${m.title} · ${formatDay(m.date)}`.length * (m.isKey ? 7.4 : 6.4) + 16,
      // labels near the right edge anchor leftward so nothing bleeds off-canvas
      anchorEnd: m.px > 940,
    })),
  ];
  const placement = placeLabels(labelMarks, 3, 8, 1232);
  if (placement) {
    console.log(`[lead-time] backtest chart: placed ${labelMarks.length} labels with zero leader-text crossings`);
  } else {
    console.warn(
      `[lead-time] backtest chart: no crossing-free layout for ${labelMarks.length} labels within 3 lanes — zigzag lanes, text halo covers crossings`,
    );
  }
  const signalMark = placement
    ? { anchorEnd: placement[0].anchorEnd, labelY: 374 + placement[0].lane * 28 }
    : { anchorEnd: true, labelY: 344 };
  const eventMarks = eventLabels.map((m, i) => ({
    ...m,
    anchorEnd: placement ? placement[i + 1].anchorEnd : m.px > 940,
    labelY: placement ? 374 + placement[i + 1].lane * 28 : 374 + (i % 2) * 28,
  }));

  // month ticks skip any position where a marker's leader line will cross them
  const busyXs = [startX, filedX, ...eventMarks.map((m) => m.px)];
  const months: { label: string; px: number }[] = [];
  const cursor = new Date(series[0].t);
  cursor.setDate(1);
  while (cursor.getTime() <= t1) {
    if (cursor.getTime() >= t0) {
      const px = Math.round(xOf(cursor.toISOString()));
      if (busyXs.every((busy) => Math.abs(busy - px) > 46)) {
        months.push({ label: cursor.toLocaleDateString("en-US", { month: "short" }).toUpperCase(), px });
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return { linePoints, startX, filedX, startY: Math.round(yOf(startPoint.v)), gridY, months, eventMarks, signalMark };
}

function shorten(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** postgres returns date columns as JS Dates — String() on those is NOT ISO. */
function isoDay(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function formatDay(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
