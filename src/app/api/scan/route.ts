import { db } from "@/lib/db";
import { fetchPages, runAgent, searchWeb, withBrowserSlot } from "@/lib/tinyfish";
import { plannedSources, FAMILY_WEIGHTS, type Family, type SourceProfile, type SourceSpec } from "@/lib/sources";
import { normalizeSource, verifyQuotes } from "@/lib/normalize";
import { readEdgar } from "@/lib/edgar";
import { collectStoreFootprint, collectJobsFootprint, countDeltaRead } from "@/lib/footprint";
import { directionScore, familyScores } from "@/lib/scoring";
import { resolveCompany } from "@/lib/resolve";
import { planDeepProbes, probeToSpec, type PlaybookEntry } from "@/lib/planner";
import { synthesizeTakeaways, type CycleCall, type Takeaway } from "@/lib/synthesize";

export const runtime = "nodejs";
export const maxDuration = 800;

type ScanEvent =
  | { type: "scan_created"; scanId: number; company: { id: number; ticker: string; name: string }; sources: { key: string; label: string; family: Family }[] }
  | { type: "sources_added"; sources: { key: string; label: string; family: Family }[] }
  | { type: "source_started"; key: string }
  | { type: "source_progress"; key: string; purpose: string }
  | { type: "source_streaming"; key: string; streamingUrl: string }
  | { type: "source_complete"; key: string; ok: boolean; durationMs: number; itemsRead: number; note: string | null; error?: string; samples?: { quote: string; source_label: string; published_at: string | null }[] }
  | { type: "score_updated"; score: number | null; provisional: boolean; families: Record<string, { score: number; weight: number }> }
  | { type: "takeaways"; items: Takeaway[]; cycle: CycleCall | null }
  | { type: "scan_complete"; scanId: number; score: number | null }
  | { type: "scan_error"; message: string };

export async function POST(request: Request) {
  if (!process.env.TINYFISH_API_KEY) return Response.json({ error: "TINYFISH_API_KEY not set" }, { status: 500 });
  if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });

  let ticker: string;
  try {
    const body = (await request.json()) as { ticker?: string };
    ticker = (body.ticker ?? "").trim().toUpperCase();
    if (!ticker) throw new Error("empty");
  } catch {
    return Response.json({ error: "body must be {ticker}" }, { status: 400 });
  }

  const sql = db();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // The scan must survive a dropped viewer: send() never throws, and the
      // pipeline keeps persisting after the stream dies.
      let closed = false;
      const send = (event: ScanEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
          console.log("scan: viewer disconnected — continuing headless");
        }
      };
      try {
        controller.enqueue(encoder.encode(": ping\n\n"));
      } catch {
        closed = true;
      }

      try {
        // 1. company (seeded or resolved live)
        let [company] = await sql`select id, ticker, name, source_profile from companies where ticker = ${ticker}`;
        if (!company) {
          const resolved = await resolveCompany(ticker);
          if (!resolved) {
            send({ type: "scan_error", message: `No SEC-listed company found for ${ticker}.` });
            return;
          }
          [company] = await sql`
            insert into companies (ticker, name, source_profile)
            values (${ticker}, ${resolved.name}, ${sql.json(resolved.profile as never)})
            returning id, ticker, name, source_profile`;
          console.log(`scan: resolved new company ${ticker} with ${Object.keys(resolved.profile).length} profile keys`);
        }
        const profile = company.source_profile as SourceProfile;
        const sources = plannedSources(profile);
        if (sources.length === 0) {
          send({ type: "scan_error", message: `${ticker} resolved but no scannable sources in its profile.` });
          return;
        }

        const [scan] = await sql`insert into scans (company_id) values (${company.id}) returning id`;
        send({
          type: "scan_created",
          scanId: scan.id,
          company: { id: company.id, ticker: company.ticker, name: company.name },
          sources: sources.map((s) => ({ key: s.key, label: s.label, family: s.family })),
        });
        console.log(`scan ${scan.id}: started for ${ticker} across ${sources.length} sources`);

        const reads: { family: Family; read: number | null }[] = [];

        const runOne = async (spec: SourceSpec) => {
          send({ type: "source_started", key: spec.key });
          const urls = spec.urls(profile);
          const [run] = await sql`
            insert into source_runs (scan_id, source_key, primitive, status, started_at, result)
            values (${scan.id}, ${spec.key}, ${spec.kind}, 'running', now(),
              ${spec.probeMeta ? sql.json(spec.probeMeta) : null}) returning id`;
          const started = Date.now();

          try {
            let itemsRead = 0;
            let note: string | null = null;
            let familyRead: number | null = null;
            let runId: string | undefined;
            let samples: { quote: string; source_label: string; published_at: string | null }[] = [];

            if (spec.kind === "code" && spec.key === "store_footprint") {
              // counted, not read: robots.txt → location sitemap → per-state counts in code
              const footprint = await collectStoreFootprint(profile.companyDomain!);
              if (!footprint) throw new Error("no enumerable location sitemap on the company domain");
              for (const [state, count] of Object.entries(footprint.byState)) {
                await sql`
                  insert into footprint_counts (company_id, scan_id, dimension, key, count)
                  values (${company.id}, ${scan.id}, 'stores_by_state', ${state}, ${count})`;
              }
              const [prior] = await sql`
                select value from signal_metrics
                where company_id = ${company.id} and metric_key = 'store_locations' and scan_id <> ${scan.id}
                order by scraped_at desc limit 1`;
              familyRead = countDeltaRead(prior ? Number(prior.value) : null, footprint.total);
              await sql`
                insert into signal_metrics (company_id, scan_id, metric_key, family, value, unit, baseline_label, sources)
                values (${company.id}, ${scan.id}, 'store_locations', 'ops', ${footprint.total}, 'locations', ${footprint.note}, 'Company sitemap')`;
              itemsRead = footprint.total;
              note = footprint.note;
              console.log(`scan ${scan.id}: store footprint counted ${footprint.total} locations in ${Object.keys(footprint.byState).length} states from ${footprint.sitemapUrl}`);
            } else if (spec.key === "careers" && profile.atsBoard) {
              // ATS boards are public JSON — counted by department and market in code, no agent
              const jobs = await collectJobsFootprint(profile.atsBoard);
              // store every key so per-dimension sums equal the real total; 200 is a runaway guard
              const topOf = (counts: Record<string, number>) =>
                Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 200);
              for (const [dept, count] of topOf(jobs.byDepartment)) {
                await sql`
                  insert into footprint_counts (company_id, scan_id, dimension, key, count)
                  values (${company.id}, ${scan.id}, 'jobs_by_department', ${dept}, ${count})`;
              }
              for (const [market, count] of topOf(jobs.byMarket)) {
                await sql`
                  insert into footprint_counts (company_id, scan_id, dimension, key, count)
                  values (${company.id}, ${scan.id}, 'jobs_by_market', ${market}, ${count})`;
              }
              const [prior] = await sql`
                select value from signal_metrics
                where company_id = ${company.id} and metric_key = 'careers' and scan_id <> ${scan.id}
                order by scraped_at desc limit 1`;
              familyRead = countDeltaRead(prior ? Number(prior.value) : null, jobs.total);
              await sql`
                insert into signal_metrics (company_id, scan_id, metric_key, family, value, unit, baseline_label, sources)
                values (${company.id}, ${scan.id}, 'careers', 'workforce', ${jobs.total}, 'open', ${jobs.note}, 'ATS board API')`;
              itemsRead = jobs.total;
              note = jobs.note;
              console.log(`scan ${scan.id}: careers counted ${jobs.total} roles across ${Object.keys(jobs.byDepartment).length} departments from the ${profile.atsBoard.kind} API`);
            } else if (spec.kind === "code" && spec.key === "edgar") {
              // deterministic path: structured API, code-parsed, zero LLM
              const edgar = await readEdgar(profile.edgarCik!);
              // periodic reports are the cycle anchors — every listed company has them
              for (const filing of edgar.filings) {
                if (!["10-Q", "10-K", "20-F", "40-F"].some((f) => filing.form.startsWith(f))) continue;
                await sql`
                  insert into official_events (company_id, event_type, title, occurred_on, url, source, is_key)
                  values (${company.id}, 'periodic_report', ${`${filing.form} filed`}, ${filing.filedOn}, ${filing.url}, 'sec_edgar', false)
                  on conflict do nothing`;
              }
              for (const filing of edgar.leadershipEvents) {
                await sql`
                  insert into official_events (company_id, event_type, title, occurred_on, url, source, is_key)
                  values (${company.id}, '8k_502', ${"Officer change filed (8-K, Item 5.02)"}, ${filing.filedOn}, ${filing.url}, 'sec_edgar', true)
                  on conflict do nothing`;
                await sql`
                  insert into evidence (company_id, scan_id, family, quote, source_key, source_label, source_url, published_at, sentiment, extra)
                  values (${company.id}, ${scan.id}, 'leadership',
                    ${`Form 8-K, Items ${filing.items} — filed ${filing.filedOn}`},
                    'edgar', 'SEC EDGAR', ${filing.url}, ${filing.filedOn}, ${-0.5}, ${sql.json({ verified: true, deterministic: true })})`;
                itemsRead++;
              }
              familyRead = edgar.familyRead;
              note = edgar.note;
              await sql`
                insert into signal_metrics (company_id, scan_id, metric_key, family, value, unit, baseline_label, sources)
                values (${company.id}, ${scan.id}, 'edgar_filings', 'leadership', ${edgar.filings.length}, 'filings, 12mo', ${edgar.note}, 'SEC EDGAR')`;
            } else {
              // collect raw content: fetch first, escalate to stealth agent when blocked
              let raw: unknown;
              let viaAgent = false;
              if (spec.kind === "search") {
                // targeted: search the open web, fetch the top hits, normalize those
                const found = await searchWeb(spec.searchQuery!(company.name));
                const topUrls = found.results.slice(0, 3).map((r) => r.url);
                if (topUrls.length === 0) throw new Error("search returned no results");
                const res = await fetchPages(topUrls);
                raw = res.results.map((r) => `# ${r.url}\n${"text" in r ? r.text : ""}`).join("\n\n").trim();
                if (!(raw as string).length) throw new Error(res.errors?.[0]?.error ?? "search hits could not be fetched");
              } else if (spec.kind === "fetch") {
                const res = await fetchPages(urls);
                const text = res.results.map((r) => `# ${r.url}\n${"text" in r ? r.text : ""}`).join("\n\n").trim();
                if (text.length > 0) {
                  raw = text;
                } else if (spec.agentFallback && spec.goal) {
                  console.log(`scan ${scan.id}: ${spec.key} fetch blocked (${res.errors?.[0]?.error ?? "empty"}) — escalating to stealth agent`);
                  viaAgent = true;
                } else {
                  throw new Error(res.errors?.[0]?.error ?? "fetch returned no content");
                }
              } else {
                viaAgent = true;
              }

              if (viaAgent) {
                const outcome = await withBrowserSlot(() =>
                  runAgent({
                    url: urls[0],
                    goal: spec.goal!(company.name),
                    stealth: spec.kind === "fetch" ? true : spec.stealth,
                    proxyUS: true,
                    onProgress: (purpose) => send({ type: "source_progress", key: spec.key, purpose }),
                    onStreamingUrl: (streamingUrl) => send({ type: "source_streaming", key: spec.key, streamingUrl }),
                  }),
                );
                runId = outcome.runId;
                if (!outcome.ok) throw new Error(outcome.error ?? "agent failed");
                raw = outcome.result;
              }

              const normalized = await normalizeSource({
                companyName: company.name,
                sourceKey: spec.key,
                sourceLabel: spec.label,
                family: spec.family,
                raw,
                metricHint: spec.metricHint,
                maxItems: spec.maxItems,
              });

              // bestbet-style gate: fetched text must contain the quote verbatim
              let items = normalized.items;
              if (!viaAgent && typeof raw === "string") {
                const gate = verifyQuotes(items, raw);
                if (gate.dropped > 0) console.log(`scan ${scan.id}: ${spec.key} dropped ${gate.dropped} unverifiable quotes`);
                items = gate.verified;
              }

              for (const item of items) {
                await sql`
                  insert into evidence (company_id, scan_id, family, quote, source_key, source_label, source_url, published_at, sentiment, extra)
                  values (${company.id}, ${scan.id}, ${spec.family}, ${item.quote}, ${spec.key}, ${item.source_label}, ${item.source_url}, ${item.published_at}, ${item.sentiment}, ${sql.json({ verified: !viaAgent, via: viaAgent ? "agent" : "fetch" })})`;
              }
              if (normalized.metric?.value != null) {
                await sql`
                  insert into signal_metrics (company_id, scan_id, metric_key, family, value, unit, baseline_label, sources)
                  values (${company.id}, ${scan.id}, ${spec.key}, ${spec.family}, ${normalized.metric.value}, ${normalized.metric.unit}, ${normalized.metric.note}, ${spec.label})`;
              }
              itemsRead = items.length;
              note = normalized.metric?.note ?? null;
              familyRead = normalized.family_read;
              samples = items.slice(0, 3).map((i) => ({ quote: i.quote, source_label: i.source_label, published_at: i.published_at }));
            }

            const durationMs = Date.now() - started;
            await sql`
              update source_runs set status = 'complete', completed_at = now(), duration_ms = ${durationMs},
                items_read = ${itemsRead}, tinyfish_run_id = ${runId ?? null}
              where id = ${run.id}`;
            console.log(`scan ${scan.id}: ${spec.key} complete in ${durationMs}ms, ${itemsRead} items`);
            reads.push({ family: spec.family, read: familyRead });
            send({ type: "source_complete", key: spec.key, ok: true, durationMs, itemsRead, note, samples });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const durationMs = Date.now() - started;
            await sql`
              update source_runs set status = 'failed', completed_at = now(), duration_ms = ${durationMs}, error = ${message}
              where id = ${run.id}`;
            console.log(`scan ${scan.id}: ${spec.key} failed after ${durationMs}ms because ${message}`);
            send({ type: "source_complete", key: spec.key, ok: false, durationMs, itemsRead: 0, note: null, error: message });
          }

          const families = familyScores(reads);
          const { score, provisional } = directionScore(families);
          await sql`
            update scans set direction_score = ${score}, provisional = ${provisional},
              family_scores = ${sql.json(families as never)}
            where id = ${scan.id}`;
          send({
            type: "score_updated",
            score,
            provisional,
            families: Object.fromEntries(
              (Object.keys(families) as Family[]).map((f) => [f, { score: families[f]!.score, weight: FAMILY_WEIGHTS[f] }]),
            ),
          });
        };

        // depth planner: an agent decides what "deeper" means for this company,
        // then the cheap fleet (search+fetch, no browsers) executes it. Playbook
        // memory comes from past probe runs — repeat what yielded, drop dead ends.
        const probesDone = (async () => {
          try {
            const playbookRows = await sql`
              select source_runs.source_key, source_runs.result, source_runs.items_read
              from source_runs join scans on scans.id = source_runs.scan_id
              where scans.company_id = ${company.id} and source_runs.source_key like 'probe_%'
                and source_runs.result is not null and source_runs.scan_id <> ${scan.id}
              order by source_runs.id desc limit 12`;
            const playbook: PlaybookEntry[] = playbookRows.map((r) => ({
              label: String(r.source_key).replace(/^probe_/, ""),
              query: (r.result as { query?: string })?.query ?? "",
              itemsRead: Number(r.items_read ?? 0),
            }));
            const probes = await planDeepProbes({
              companyName: company.name,
              ticker: company.ticker,
              sector: null,
              knownSources: sources.map((s) => s.label),
              playbook,
            });
            if (probes.length === 0) return;
            const specs = probes.map(probeToSpec);
            send({ type: "sources_added", sources: specs.map((s) => ({ key: s.key, label: s.label, family: s.family })) });
            await Promise.allSettled(specs.map((spec) => runOne(spec)));
          } catch (err) {
            console.log(`scan ${scan.id}: depth planner failed because ${err instanceof Error ? err.message : String(err)} — fixed plan continues`);
          }
        })();

        // everything dispatches at once; only live browser runs contend for the 5 slots
        await Promise.allSettled(sources.map((spec) => runOne(spec)));
        await probesDone;

        const families = familyScores(reads);
        const { score } = directionScore(families);
        await sql`update scans set status = 'complete', completed_at = now() where id = ${scan.id}`;

        // synthesis: three conclusions from this scan's own data — the page's lead
        try {
          const synthesis = await synthesizeTakeaways(sql, {
            companyId: company.id,
            companyName: company.name,
            ticker: company.ticker,
            scanId: scan.id,
          });
          if (synthesis) send({ type: "takeaways", items: synthesis.takeaways, cycle: synthesis.cycle });
        } catch (err) {
          console.log(`scan ${scan.id}: synthesis failed because ${err instanceof Error ? err.message : String(err)} — scan still completes`);
        }

        console.log(`scan ${scan.id}: complete, direction score ${score}`);
        send({ type: "scan_complete", scanId: scan.id, score });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`scan: failed because ${message}`);
        send({ type: "scan_error", message });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed by the runtime */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
