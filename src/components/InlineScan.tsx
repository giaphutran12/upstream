"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useScan } from "@/hooks/use-scan";

/**
 * The scan, embedded where the reader already is: the company page. Auto-runs
 * for a company with no read yet; otherwise offers a rescan. When the scan
 * lands, the server-rendered read refreshes in place — no tab bouncing.
 */
export function InlineScan({ ticker, autoStart }: { ticker: string; autoStart: boolean }) {
  const { state, start } = useScan();
  const router = useRouter();
  const fired = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (autoStart && !fired.current) {
      fired.current = true;
      void start(ticker);
    }
  }, [autoStart, start, ticker]);

  useEffect(() => {
    if (state.phase === "complete") {
      setRefreshing(true);
      const timer = setTimeout(() => router.refresh(), 1400);
      return () => clearTimeout(timer);
    }
  }, [state.phase, router]);

  if (state.phase === "idle") {
    return (
      <button
        onClick={() => {
          if (!fired.current) {
            fired.current = true;
            void start(ticker);
          }
        }}
        className="border px-4 py-2 text-[12.5px] font-semibold"
        style={{ borderColor: "var(--color-rust)", color: "var(--color-rust)", background: "transparent", cursor: "pointer" }}
      >
        Scan again now
      </button>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="border p-4 text-[13px]" style={{ borderColor: "var(--color-rust)" }}>
        The scan stopped: {state.error}
      </div>
    );
  }

  const complete = state.sources.filter((s) => s.status === "complete").length;
  const working = state.sources.filter((s) => s.status === "working");
  const latestFinding = state.sources
    .flatMap((s) => s.samples ?? [])
    .slice(-1)[0];

  return (
    <div className="card" style={{ borderColor: "var(--color-rust)" }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="pulse-dot pulse-dot--fast" aria-hidden />
        <span className="text-[13px] font-semibold">
          {state.phase === "complete"
            ? refreshing
              ? "Scan complete — the read is refreshing in place…"
              : "Scan complete."
            : `Agents on the ground: ${complete} of ${state.sources.length || "…"} sources in`}
        </span>
        {state.phase === "running" && working.length > 0 && (
          <span className="text-[12px] text-muted">
            working: {working.map((s) => s.label).slice(0, 4).join(", ")}
          </span>
        )}
        {state.score != null && (
          <span className="ml-auto text-[13px] font-semibold tnum">direction {state.score}{state.provisional ? " · provisional" : ""}</span>
        )}
      </div>
      {state.phase === "running" && latestFinding && (
        <div className="quote mt-2.5" style={{ fontSize: 14.5 }}>
          “{latestFinding.quote}” <span className="text-[11.5px] not-italic text-muted">— {latestFinding.source_label}</span>
        </div>
      )}
      <div className="card-footer">
        Live agents against primary sources — nothing here is cached coverage. The full read renders on this page when they land.
      </div>
    </div>
  );
}
