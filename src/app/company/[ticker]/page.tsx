import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { TopBar } from "@/components/TopBar";
import { Sparkline } from "@/components/Sparkline";
import { Takeaways, type TakeawayRow } from "@/components/Takeaways";
import { CycleStrip, type CycleCallRow } from "@/components/CycleStrip";
import { computeDeltas, type ScanDeltas } from "@/lib/movers";
import { FAMILY_LABELS, FAMILY_WEIGHTS, type Family } from "@/lib/sources";

export const dynamic = "force-dynamic";

const FAMILY_ORDER: Family[] = ["sentiment", "workforce", "leadership", "ops"];

export default async function CompanyReadPage({ params }: PageProps<"/company/[ticker]">) {
  const { ticker } = await params;
  const sql = db();

  const [company] = await sql`select id, ticker, name, sector from companies where ticker = ${ticker.toUpperCase()}`;
  // never-scanned ticker: send it to Live scan, which auto-starts the first scan
  if (!company) redirect(`/?scan=${encodeURIComponent(ticker.toUpperCase())}`);

  const [scan] = await sql`
    select id, direction_score, provisional, family_scores, takeaways, completed_at, started_at
    from scans where company_id = ${company.id} and status = 'complete'
    order by started_at desc limit 1`;

  const deltas: ScanDeltas | null = scan ? await computeDeltas(sql, Number(company.id), Number(scan.id)) : null;

  const metrics = scan
    ? await sql`
        select metric_key, family, value, unit, baseline_label, sources, scraped_at
        from signal_metrics where scan_id = ${scan.id} order by id`
    : [];

  const history = await sql`
    select metric_key, value from signal_metrics
    where company_id = ${company.id} order by scraped_at asc`;
  const seriesFor = (key: string) => history.filter((h) => h.metric_key === key).map((h) => Number(h.value));

  const evidence = scan
    ? await sql`
        select quote, family, source_key, source_label, source_url, published_at, scraped_at
        from evidence where scan_id = ${scan.id}
        order by published_at desc nulls last limit 12`
    : [];

  const counts = scan
    ? await sql`
        select dimension, key, count from footprint_counts
        where scan_id = ${scan.id} order by count desc`
    : [];

  const runs = scan
    ? await sql`
        select source_key, status, duration_ms, items_read, completed_at, error
        from source_runs where scan_id = ${scan.id} order by id`
    : [];

  const [leadTime] = await sql`
    select lead_days from lead_time_reads where company_id = ${company.id} order by created_at desc limit 1`;

  const families = (scan?.family_scores ?? {}) as Partial<Record<Family, { score: number }>>;
  const score = scan?.direction_score != null ? Number(scan.direction_score) : null;
  const previous = deltas?.score.previous ?? null;
  const falling = score != null && (previous != null ? score < previous : score < 50);

  const scanMeta = scan?.takeaways as { items?: TakeawayRow[]; cycle?: CycleCallRow | null; generated_at?: string } | null;
  const takeaways = (scanMeta?.items ?? []) as TakeawayRow[];
  const cycleCall = scanMeta?.cycle ?? null;

  // movers: metrics with a baseline, largest relative change first — each with
  // its freshest piece of evidence from the same family
  const movers = (deltas?.metrics ?? [])
    .filter((m) => m.deltaPct != null && Math.abs(m.deltaPct) >= 0.5)
    .sort((a, b) => Math.abs(b.deltaPct!) - Math.abs(a.deltaPct!));
  const evidenceForFamily = (family: string) => evidence.find((e) => e.family === family);

  const deltaByStateKey = new Map((deltas?.footprintMoves ?? []).map((m) => [`${m.dimension} ${m.key}`, m.delta]));
  const storeRows = counts.filter((c) => c.dimension === "stores_by_state").slice(0, 12);
  const jobRows = counts.filter((c) => c.dimension === "jobs_by_department").slice(0, 8);
  const storeTotal = deltas?.footprintTotals["stores_by_state"];
  const jobTotal = deltas?.footprintTotals["jobs_by_department"];

  return (
    <main className="min-h-screen">
      <TopBar active="company" ticker={company.ticker} />

      <div className="rule-hairline grid grid-cols-[1fr_600px] items-end gap-14 px-12 pb-8 pt-10 max-lg:grid-cols-1">
        <div>
          <div className="eyebrow mb-3.5" style={{ color: "var(--color-rust)", letterSpacing: "0.16em" }}>
            Company read
          </div>
          <h1 className="font-serif text-[46px] font-medium leading-[1.05] tracking-tight">{company.name}</h1>
          <div className="mt-3.5 text-[13px] text-muted tnum">
            {company.ticker}
            {company.sector ? <> &nbsp;·&nbsp; {company.sector}</> : null}
            {leadTime ? (
              <>
                &nbsp;·&nbsp;{" "}
                <Link href={`/company/${company.ticker}/lead-time`} className="text-[13px]">
                  Signal led filing by {leadTime.lead_days} days →
                </Link>
              </>
            ) : null}
          </div>
        </div>
        <div>
          <div className="mb-4 flex items-baseline gap-4">
            <div className="eyebrow text-muted" style={{ letterSpacing: "0.16em" }}>
              Direction score
            </div>
            {previous != null && score != null && (
              <div className="ml-auto text-xs text-muted tnum">
                was {previous} · {score - previous >= 0 ? "+" : ""}
                {score - previous} vs prior scan
              </div>
            )}
          </div>
          <div className="mb-5 flex items-baseline gap-3.5">
            <div className="font-serif text-[76px] font-medium leading-[0.8] tnum">{score ?? "—"}</div>
            {score != null && (
              <div className="text-[15px] font-semibold" style={{ color: falling ? "var(--color-rust)" : "var(--color-ink)" }}>
                {falling ? "▼ Falling" : "▲ Holding"}
              </div>
            )}
          </div>
          <div className="grid gap-2.5">
            {FAMILY_ORDER.map((family) => {
              const fam = families[family];
              const worst = fam && Object.values(families).every((f) => fam.score <= (f?.score ?? 100));
              return (
                <div key={family} className="grid grid-cols-[170px_1fr_110px] items-center gap-3.5">
                  <div className="text-[12.5px]">
                    {FAMILY_LABELS[family]} <span className="text-muted">{Math.round(FAMILY_WEIGHTS[family] * 100)}%</span>
                  </div>
                  <div className="score-track">
                    {fam && <div className={worst ? "score-fill score-fill--rust" : "score-fill"} style={{ width: `${fam.score}%` }} />}
                  </div>
                  <div className="text-right text-[13px] tnum">
                    <strong>{fam?.score ?? "—"}</strong>{" "}
                    {fam == null && <span className="text-muted">no source</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-[11px] text-muted">
            Components are live; families with no completed source are excluded and weights renormalize.
          </div>
        </div>
      </div>

      {takeaways.length > 0 && (
        <div className="rule-hairline px-12 pb-9 pt-7">
          <Takeaways items={takeaways} generatedAgo={timeAgo(scanMeta?.generated_at ?? null)} />
          {cycleCall && (
            <div className="mt-7">
              <CycleStrip cycle={cycleCall} />
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-[1fr_292px] gap-11 px-12 pb-14 pt-8 max-lg:grid-cols-1">
        <div>
          <div className="mb-3.5 flex items-baseline gap-4">
            <h2 className="font-serif text-[26px] font-medium">What moved since the last scan</h2>
            {deltas?.previousScanAt && (
              <div className="text-xs text-muted tnum">
                vs scan of {formatDay(deltas.previousScanAt)} · {daysAgoLabel(deltas.previousScanAt)}
              </div>
            )}
          </div>
          {deltas?.previousScanId == null ? (
            <div className="card card--queued mb-11 py-6 text-center text-[13px] text-muted">
              First scan on record — the baseline is set. Movement shows here from the next run; every scan accumulates.
            </div>
          ) : (
            <div className="mb-11">
              <div className="rule-ink grid grid-cols-[200px_210px_1fr] gap-x-5 pb-2">
                <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Signal</div>
                <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Move</div>
                <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>The evidence behind it</div>
              </div>
              {movers.map((m) => {
                const ev = evidenceForFamily(m.family);
                const upIsBad = ["reddit", "downdetector"].includes(m.metricKey);
                const bad = upIsBad ? m.deltaPct! > 0 : m.deltaPct! < 0;
                return (
                  <div key={m.metricKey} className="rule-hairline grid grid-cols-[200px_210px_1fr] items-baseline gap-x-5 py-3.5">
                    <div className="text-[13px] font-semibold capitalize">{m.metricKey.replaceAll("_", " ")}</div>
                    <div className="text-[13px] tnum">
                      {fmt(m.previous)} → {fmt(m.current)}
                      {m.unit ? <span className="text-muted"> {m.unit}</span> : null}{" "}
                      <span className={bad ? "delta-bad" : "font-semibold"}>
                        ({m.deltaPct! >= 0 ? "+" : ""}
                        {m.deltaPct}%)
                      </span>
                    </div>
                    <div className="text-[12.5px] text-muted">
                      {ev ? <>“{clip(String(ev.quote), 110)}” — {ev.source_label}</> : m.sources ?? "counted in code"}
                    </div>
                  </div>
                );
              })}
              {deltas.footprintMoves.slice(0, 6).map((m) => (
                <div key={`${m.dimension}-${m.key}`} className="rule-hairline grid grid-cols-[200px_210px_1fr] items-baseline gap-x-5 py-3.5">
                  <div className="text-[13px] font-semibold">{footprintLabel(m.dimension, m.key)}</div>
                  <div className="text-[13px] tnum">
                    {fmt(m.previous)} → {fmt(m.current ?? 0)}{" "}
                    <span className={m.delta < 0 ? "delta-bad" : "font-semibold"}>
                      ({m.delta >= 0 ? "+" : ""}
                      {m.delta})
                    </span>
                  </div>
                  <div className="text-[12.5px] text-muted">counted from the company’s own {m.dimension.startsWith("stores") ? "sitemap" : "ATS board"} — no model in the loop</div>
                </div>
              ))}
              {movers.length === 0 && deltas.footprintMoves.length === 0 && (
                <div className="rule-hairline py-4 text-[13px] text-muted">
                  Nothing moved between the last two scans — that is itself a read.
                </div>
              )}
            </div>
          )}

          {(storeRows.length > 0 || jobRows.length > 0) && (
            <div className="mb-11">
              <div className="mb-3.5 flex items-baseline gap-4">
                <h2 className="font-serif text-[26px] font-medium">Counted at scale</h2>
                <div className="text-xs text-muted">Enumerated live from the company’s own infrastructure, counted in code.</div>
              </div>
              <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
                {storeRows.length > 0 && (
                  <div className="card">
                    <div className="eyebrow mb-2.5 text-muted" style={{ letterSpacing: "0.14em" }}>
                      Locations by state
                    </div>
                    <div className="text-[30px] font-semibold leading-none tnum">
                      {storeTotal?.current.toLocaleString()}
                      <span className="text-sm font-normal text-muted"> locations</span>
                      {storeTotal?.previous != null && storeTotal.current !== storeTotal.previous && (
                        <span className={storeTotal.current < storeTotal.previous ? "delta-bad text-sm" : "text-sm font-semibold"}>
                          {" "}
                          ({storeTotal.current - storeTotal.previous >= 0 ? "+" : ""}
                          {storeTotal.current - storeTotal.previous} vs last scan)
                        </span>
                      )}
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-1.5">
                      {storeRows.map((row) => {
                        const delta = deltaByStateKey.get(`stores_by_state ${row.key}`);
                        return (
                          <div key={String(row.key)} className="flex items-baseline justify-between text-[12.5px] tnum">
                            <span>{row.key}</span>
                            <span>
                              <strong>{row.count}</strong>
                              {delta != null && (
                                <span className={delta < 0 ? "delta-bad" : "font-semibold"}>
                                  {" "}
                                  {delta >= 0 ? "+" : ""}
                                  {delta}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="card-footer tnum">Top {storeRows.length} states · every store page enumerated from the location sitemap</div>
                  </div>
                )}
                {jobRows.length > 0 && (
                  <div className="card">
                    <div className="eyebrow mb-2.5 text-muted" style={{ letterSpacing: "0.14em" }}>
                      Open roles by department
                    </div>
                    <div className="text-[30px] font-semibold leading-none tnum">
                      {jobTotal?.current.toLocaleString()}
                      <span className="text-sm font-normal text-muted"> open</span>
                      {jobTotal?.previous != null && jobTotal.current !== jobTotal.previous && (
                        <span className={jobTotal.current < jobTotal.previous ? "delta-bad text-sm" : "text-sm font-semibold"}>
                          {" "}
                          ({jobTotal.current - jobTotal.previous >= 0 ? "+" : ""}
                          {jobTotal.current - jobTotal.previous} vs last scan)
                        </span>
                      )}
                    </div>
                    <div className="mt-4 grid gap-y-1.5">
                      {jobRows.map((row) => {
                        const delta = deltaByStateKey.get(`jobs_by_department ${row.key}`);
                        return (
                          <div key={String(row.key)} className="flex items-baseline justify-between text-[12.5px] tnum">
                            <span>{row.key}</span>
                            <span>
                              <strong>{row.count}</strong>
                              {delta != null && (
                                <span className={delta < 0 ? "delta-bad" : "font-semibold"}>
                                  {" "}
                                  {delta >= 0 ? "+" : ""}
                                  {delta}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="card-footer tnum">Counted from the public ATS board API</div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mb-11 grid grid-cols-2 gap-5 max-md:grid-cols-1">
            {metrics.map((metric) => (
              <div key={metric.metric_key} className="card">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="eyebrow mb-2.5 text-muted" style={{ letterSpacing: "0.14em" }}>
                      {String(metric.metric_key).replaceAll("_", " ")}
                    </div>
                    <div className="text-[30px] font-semibold leading-none tnum">
                      {Number(metric.value).toLocaleString()}
                      {metric.unit ? <span className="text-sm font-normal text-muted"> {metric.unit}</span> : null}
                    </div>
                    <div className="mt-1.5 text-[13px] font-semibold tnum">{metric.baseline_label}</div>
                  </div>
                  <Sparkline points={seriesFor(String(metric.metric_key))} rust={metric.family === "sentiment"} />
                </div>
                <div className="card-footer tnum">
                  {metric.sources} &nbsp;·&nbsp; scraped {timeAgo(metric.scraped_at as unknown as string)}
                </div>
              </div>
            ))}
            {metrics.length === 0 && (
              <div className="card card--queued col-span-2 py-8 text-center text-[13px] text-muted">
                No completed scan yet — run one from <Link href="/">Live scan</Link>.
              </div>
            )}
          </div>

          <div className="mb-3.5 flex items-baseline gap-4">
            <h2 className="font-serif text-[26px] font-medium">Supporting evidence, verbatim</h2>
            <div className="text-xs text-muted">Every quote links to its source and its scrape.</div>
          </div>
          <div className="rule-ink grid grid-cols-[1fr_210px_82px_118px] gap-x-5 pb-2">
            <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Quote</div>
            <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Source</div>
            <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Date</div>
            <div className="eyebrow" style={{ letterSpacing: "0.12em" }}>Scraped</div>
          </div>
          {evidence.map((row, i) => (
            <div key={i} className="rule-hairline grid grid-cols-[1fr_210px_82px_118px] items-baseline gap-x-5 py-4">
              <div className="quote">“{row.quote}”</div>
              <div className="text-[12.5px]">
                {row.source_url ? (
                  <a href={row.source_url} target="_blank" rel="noreferrer" className="text-[12.5px]">
                    {row.source_label}
                  </a>
                ) : (
                  row.source_label
                )}
              </div>
              <div className="text-[12.5px] tnum">{formatDay(row.published_at as unknown as string)}</div>
              <div className="text-[12.5px] text-muted tnum">{timeAgo(row.scraped_at as unknown as string)}</div>
            </div>
          ))}
        </div>

        <aside>
          <div className="rule-ink eyebrow pb-2 text-muted" style={{ letterSpacing: "0.16em" }}>
            Agents
          </div>
          {runs.map((run) => (
            <div key={run.source_key} className="rule-hairline flex items-baseline gap-2.5 py-3.5">
              <span
                className="pulse-dot"
                style={{
                  animation: "none",
                  background: run.status === "complete" ? "var(--color-ok)" : "var(--color-rust)",
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <div className="flex-1">
                <div className="text-[13px] font-semibold capitalize">{String(run.source_key).replaceAll("_", " ")}</div>
                <div className="text-[11.5px] text-muted tnum">
                  {run.status === "complete"
                    ? `${run.items_read ?? 0} items read · ${((run.duration_ms ?? 0) / 1000).toFixed(1)} s`
                    : `skipped — ${run.error}`}
                </div>
              </div>
            </div>
          ))}
          <div className="pt-2.5 text-[11px] text-muted">
            Excluded by design: LinkedIn (ToS). Failed sources renormalize out of the score.
          </div>
        </aside>
      </div>
    </main>
  );
}

function fmt(n: number | null) {
  return n == null ? "—" : Number(n).toLocaleString();
}

function clip(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function footprintLabel(dimension: string, key: string) {
  if (dimension === "stores_by_state") return `${key} locations`;
  if (dimension === "jobs_by_department") return `${key} roles`;
  return `${key} roles`;
}

function formatDay(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysAgoLabel(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days < 1) return "earlier today — history is accumulating, the window widens daily";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function timeAgo(value: string | null) {
  if (!value) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
