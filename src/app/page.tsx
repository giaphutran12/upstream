"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Takeaways } from "@/components/Takeaways";
import { CycleStrip } from "@/components/CycleStrip";
import { useScan, ACTIVE_SCAN_KEY, type SourceState } from "@/hooks/use-scan";

const FAMILY_ROWS = [
  { key: "sentiment", label: "Customer Sentiment", weight: "40%" },
  { key: "workforce", label: "Workforce", weight: "30%" },
  { key: "leadership", label: "Leadership", weight: "20%" },
  { key: "ops", label: "Product / Ops", weight: "10%" },
] as const;

type CompanyHit = { ticker: string; name: string };

export default function LiveScanPage() {
  const { state, start, resume, stopPolling } = useScan();
  const [ticker, setTicker] = useState("");
  const [suggestions, setSuggestions] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const picked = useRef<string | null>(null);

  // fuzzy company lookup: type "MCDONALDS", get MCD — nobody memorizes tickers
  useEffect(() => {
    if (picked.current === ticker || ticker.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/companies?q=${encodeURIComponent(ticker.trim())}`);
        const data = (await res.json()) as { results?: CompanyHit[] };
        setSuggestions(data.results ?? []);
        setHighlight(0);
        setOpen((data.results ?? []).length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [ticker]);

  const launch = (tk: string) => {
    if (state.phase === "running") return; // one scan at a time — no restart-by-Enter
    picked.current = tk;
    setTicker(tk);
    setOpen(false);
    void start(tk);
  };

  // deep link from a company page that had no data yet: /?scan=MCD auto-runs
  // the first scan, then forwards to the company read it just built
  const router = useRouter();
  const autoScanFired = useRef(false);
  const [autoTicker, setAutoTicker] = useState<string | null>(null);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("scan")?.trim().toUpperCase();
    if (wanted && !autoScanFired.current) {
      autoScanFired.current = true;
      setAutoTicker(wanted);
      launch(wanted);
      return;
    }
    // reattach: the scan is a server-side job that persists on its own — a
    // refresh or a wander through other tabs rebuilds this exact view from
    // the last ticker this browser scanned, running or finished
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(ACTIVE_SCAN_KEY)?.trim().toUpperCase() ?? null;
    } catch {}
    if (stored) {
      picked.current = stored;
      setTicker(stored);
      void resume(stored);
    }
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state.phase === "complete" && autoTicker && state.company?.ticker === autoTicker) {
      const timer = setTimeout(() => router.push(`/company/${autoTicker}`), 1600);
      return () => clearTimeout(timer);
    }
  }, [state.phase, state.company, autoTicker, router]);
  const counts = useMemo(() => {
    const c = { complete: 0, working: 0, queued: 0, failed: 0 };
    for (const s of state.sources) c[s.status === "failed" ? "failed" : s.status]++;
    return c;
  }, [state.sources]);

  const findings = useMemo(
    () =>
      state.sources
        .flatMap((s) => (s as SourceState & { samples?: { quote: string; source_label: string; published_at: string | null }[] }).samples ?? [])
        .slice(0, 6),
    [state.sources],
  );

  return (
    <main className="min-h-screen">
      <TopBar active="scan" ticker={state.company?.ticker} />

      <form
        className="flex items-end gap-8 px-12 pb-6 pt-10 rule-hairline"
        onSubmit={(e) => {
          e.preventDefault();
          if (state.phase === "running") return;
          const typed = ticker.trim().toUpperCase();
          if (!typed) return;
          const exact = suggestions.find((s) => s.ticker === typed);
          if (open && suggestions.length > 0 && !exact) launch(suggestions[highlight].ticker);
          else launch(typed);
        }}
      >
        <div className="relative flex-1">
          <div className="eyebrow text-rust mb-3" style={{ letterSpacing: "0.16em", color: "var(--color-rust)" }}>
            New scan
          </div>
          <div className="flex max-w-[560px] items-baseline gap-4 border-b-2 border-ink pb-2.5">
            <input
              value={ticker}
              onChange={(e) => {
                picked.current = null;
                setTicker(e.target.value.toUpperCase());
              }}
              onKeyDown={(e) => {
                if (!open || suggestions.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % suggestions.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="COMPANY OR TICKER"
              aria-label="Company name or ticker to scan"
              autoComplete="off"
              className="w-full bg-transparent font-serif text-[40px] font-medium tracking-wide outline-none placeholder:text-hairline"
            />
            <div className="whitespace-nowrap text-[13px] text-muted">
              {state.company ? `${state.company.name}` : "Name or ticker, press return"}
            </div>
          </div>
          {open && suggestions.length > 0 && (
            <div
              className="absolute z-10 max-w-[560px] w-full border border-hairline"
              style={{ background: "var(--color-panel)", top: "100%" }}
              role="listbox"
            >
              {suggestions.map((hit, i) => (
                <button
                  key={hit.ticker}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => launch(hit.ticker)}
                  className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left rule-hairline"
                  style={i === highlight ? { background: "var(--color-track)" } : undefined}
                >
                  <span className="w-16 text-[13.5px] font-semibold tnum">{hit.ticker}</span>
                  <span className="text-[12.5px] text-muted">{hit.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="text-right tnum">
          {state.phase === "running" || state.phase === "complete" ? (
            <>
              <div className="text-[13px] font-semibold">
                <span className="pulse-dot pulse-dot--fast mr-2" aria-hidden />
                {state.sources.length} agents dispatched
              </div>
              <div className="mt-1 text-xs text-muted">
                {counts.complete} complete · {counts.working} working · {counts.queued} queued
                {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
              </div>
            </>
          ) : (
            <div className="text-xs text-muted">Scans run live — nothing here is cached coverage.</div>
          )}
        </div>
      </form>

      {autoTicker && state.phase !== "error" && (
        <div className="mx-12 mt-6 border border-hairline p-4 text-[13px]" style={{ background: "var(--color-panel)" }}>
          {state.phase === "complete"
            ? `First scan of ${autoTicker} complete — opening the company read…`
            : `${autoTicker} hasn't been scanned before. Running its first scan now — the company read opens itself when the agents finish.`}
        </div>
      )}

      {state.phase === "error" && (
        <div className="mx-12 mt-6 border border-rust p-4 text-[13px]" style={{ borderColor: "var(--color-rust)" }}>
          The scan stopped: {state.error}. Adjust the ticker and run it again.
        </div>
      )}

      <div className="grid grid-cols-[1fr_330px] gap-11 px-12 pb-14 pt-8 max-lg:grid-cols-1">
        <div>
          <div className="mb-10 grid grid-cols-2 gap-4 max-md:grid-cols-1">
            {state.sources.map((source) => (
              <SourceCard key={source.key} source={source} />
            ))}
            {state.sources.length === 0 && (
              <div className="card card--queued col-span-2 py-10 text-center text-[13px] text-muted">
                Pick a company to dispatch the agents — Reddit, Trustpilot, app stores, careers pages, SEC EDGAR.
              </div>
            )}
          </div>

          {state.takeaways.length > 0 && (
            <div className="mb-10">
              <Takeaways items={state.takeaways} />
              {state.cycle && (
                <div className="mt-6">
                  <CycleStrip cycle={state.cycle} />
                </div>
              )}
            </div>
          )}

          {findings.length > 0 && (
            <div>
              <div className="rule-ink mb-0.5 flex items-baseline gap-4 pb-2">
                <div className="eyebrow">Findings · streaming in</div>
                <div className="text-[11px] text-muted">newest first</div>
              </div>
              {findings.map((f, i) => (
                <div key={i} className="rule-hairline flex items-baseline gap-4 py-3">
                  <div className="quote flex-1" style={{ fontSize: 15.5 }}>
                    “{f.quote}”
                  </div>
                  <div className="whitespace-nowrap text-xs">
                    <span className="text-muted tnum">
                      {f.source_label}
                      {f.published_at ? ` · ${f.published_at}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside>
          <div className="card p-6">
            <div className="mb-4 flex items-baseline gap-3">
              <div className="eyebrow text-muted" style={{ letterSpacing: "0.16em" }}>
                Direction score
              </div>
              {state.phase === "running" && (
                <div className="ml-auto text-[11px] font-semibold" style={{ color: "var(--color-rust)" }}>
                  <span className="pulse-dot pulse-dot--fast mr-1.5" style={{ width: 6, height: 6 }} aria-hidden />
                  assembling
                </div>
              )}
            </div>
            <div className="flex items-baseline gap-3">
              <div className="font-serif text-[64px] font-medium leading-[0.8] tnum">{state.score ?? "—"}</div>
              {state.provisional && state.score != null && (
                <div className="text-xs leading-snug text-muted">
                  provisional
                  <br />
                  until all sources land
                </div>
              )}
            </div>
            <div className="my-3 text-xs text-muted tnum">
              {counts.complete} of {state.sources.length || "—"} sources in
            </div>
            <div className="grid gap-2.5">
              {FAMILY_ROWS.map((row) => {
                const fam = state.families[row.key];
                const pendingSources = state.sources.filter((s) => s.family === row.key && s.status !== "complete" && s.status !== "failed");
                return (
                  <div key={row.key} className="grid grid-cols-[1fr_34px] items-center gap-3">
                    <div>
                      <div className="text-[12.5px]">
                        {row.label}{" "}
                        <span className="text-muted">
                          {row.weight}
                          {pendingSources.length > 0 ? ` · ${pendingSources[0].label} pending` : ""}
                        </span>
                      </div>
                      <div className="score-track mt-1.5" style={{ height: 6 }}>
                        {fam && <div className="score-fill" style={{ width: `${fam.score}%`, opacity: pendingSources.length ? 0.45 : 1 }} />}
                      </div>
                    </div>
                    <div className="text-right text-[13px] font-semibold tnum" style={fam ? undefined : { color: "var(--color-muted)" }}>
                      {fam?.score ?? "—"}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="card-footer" style={{ marginTop: 16, lineHeight: 1.5 }}>
              Families with no completed source are excluded; remaining weights are renormalized. Final score lands when every agent
              reports.
            </div>
          </div>
          {state.phase === "complete" && state.company && (
            <div className="mt-4 text-xs leading-relaxed text-muted">
              Scan complete — see the full{" "}
              <Link href={`/company/${state.company.ticker}`} className="text-xs">
                company read →
              </Link>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function SourceCard({ source }: { source: SourceState & { samples?: unknown } }) {
  const cardClass =
    source.status === "working" ? "card card--working" : source.status === "queued" ? "card card--queued" : "card";
  return (
    <div className={cardClass} style={{ padding: "16px 18px" }}>
      <div className="flex items-baseline gap-2.5">
        <div className={`flex-1 text-[13.5px] font-semibold ${source.status === "queued" ? "text-muted" : ""}`}>{source.label}</div>
        {source.status === "complete" && (
          <div className="text-[11.5px] font-semibold tnum" style={{ color: "var(--color-ok)" }}>
            ✓ Complete · {((source.durationMs ?? 0) / 1000).toFixed(1)} s
          </div>
        )}
        {source.status === "failed" && (
          <div className="text-[11.5px] font-semibold" style={{ color: "var(--color-rust)" }}>
            Failed
          </div>
        )}
        {source.status === "working" && (
          <div className="text-[11.5px] font-semibold" style={{ color: "var(--color-rust)" }}>
            <span className="pulse-dot pulse-dot--fast mr-1.5" style={{ width: 6, height: 6 }} aria-hidden />
            Working
          </div>
        )}
        {source.status === "queued" && <div className="text-[11.5px] font-semibold text-muted">Queued</div>}
      </div>
      <div className="mt-1.5 text-[12.5px] text-muted tnum">
        {source.status === "working" && <em>{source.purpose ?? "dispatching browser…"}</em>}
        {source.status === "complete" && (source.note ?? `${source.itemsRead ?? 0} items read`)}
        {source.status === "failed" && `${source.error} — this source is skipped; the score renormalizes without it.`}
        {source.status === "queued" && <em>waiting for a browser…</em>}
      </div>
      {source.status === "working" && source.streamingUrl && (
        <div className="mt-1.5">
          <a href={source.streamingUrl} target="_blank" rel="noreferrer" className="text-[11.5px]">
            Watch the agent’s browser →
          </a>
        </div>
      )}
    </div>
  );
}
