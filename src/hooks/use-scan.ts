"use client";

import { useCallback, useRef, useState } from "react";

export type SourceState = {
  key: string;
  label: string;
  family: string;
  status: "queued" | "working" | "complete" | "failed";
  purpose?: string;
  streamingUrl?: string;
  durationMs?: number;
  itemsRead?: number;
  note?: string | null;
  error?: string;
  samples?: { quote: string; source_label: string; published_at: string | null }[];
};

export type TakeawayItem = {
  finding: string;
  why_it_matters: string;
  what_it_changes: string;
  sources: string[];
};

export type CycleCallState = {
  position: string;
  early_signals: string;
  direction: "down" | "up" | "mixed";
  call: string;
};

export type ScanState = {
  phase: "idle" | "running" | "complete" | "error";
  scanId?: number;
  company?: { id: number; ticker: string; name: string };
  sources: SourceState[];
  score: number | null;
  provisional: boolean;
  families: Record<string, { score: number; weight: number }>;
  takeaways: TakeawayItem[];
  cycle: CycleCallState | null;
  startedAt?: number;
  error?: string;
};

const IDLE: ScanState = { phase: "idle", sources: [], score: null, provisional: true, families: {}, takeaways: [], cycle: null };

/** The last ticker this browser scanned — survives refresh and navigation. */
export const ACTIVE_SCAN_KEY = "upstream:active-scan";

// A just-started scan takes a beat to exist server-side (a brand-new ticker
// resolves its source profile first). For this long after starting, "no scan
// found" means "still materializing", not "nothing running".
const START_GRACE_MS = 150_000;

export function rememberActiveScan(ticker: string) {
  try {
    localStorage.setItem(ACTIVE_SCAN_KEY, JSON.stringify({ ticker: ticker.toUpperCase(), at: Date.now() }));
  } catch {}
}

export function readActiveScan(): { ticker: string; at: number | null } | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SCAN_KEY);
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { ticker?: string; at?: number };
      if (!parsed.ticker) return null;
      return { ticker: String(parsed.ticker).toUpperCase(), at: Number(parsed.at) || null };
    }
    return { ticker: raw.trim().toUpperCase(), at: null }; // pre-JSON value from an older session
  } catch {
    return null;
  }
}

function clearActiveScan() {
  try {
    localStorage.removeItem(ACTIVE_SCAN_KEY);
  } catch {}
}

type StatusSnapshot = {
  company: { ticker: string; name: string } | null;
  scan: { id: number; status: string; error: string | null } | null;
  runs?: { key: string; label: string; family: string; status: string; durationMs: number | null; itemsRead: number | null; error: string | null; streamingUrl: string | null }[];
  samples?: { source_key: string; quote: string; source_label: string; published_at: string | null }[];
  read?: { score: number | null; provisional: boolean; families: ScanState["families"]; takeaways: TakeawayItem[]; cycle: CycleCallState | null };
};

/** Rebuild the live-scan view from the persisted job — same shapes the stream produces. */
function stateFromSnapshot(data: StatusSnapshot): ScanState {
  const scan = data.scan!;
  return {
    phase: scan.status === "running" ? "running" : scan.status === "complete" ? "complete" : "error",
    error: scan.status === "failed" ? (scan.error ?? "the scan failed") : undefined,
    scanId: scan.id,
    company: data.company ? { id: 0, ticker: data.company.ticker, name: data.company.name } : undefined,
    sources: (data.runs ?? []).map((r) => ({
      key: r.key,
      label: r.label,
      family: r.family,
      status: r.status === "running" ? ("working" as const) : r.status === "complete" ? ("complete" as const) : r.status === "failed" ? ("failed" as const) : ("queued" as const),
      durationMs: r.durationMs ?? undefined,
      itemsRead: r.itemsRead ?? undefined,
      error: r.error ?? undefined,
      streamingUrl: r.streamingUrl ?? undefined,
      samples: (data.samples ?? [])
        .filter((s) => s.source_key === r.key)
        .map((s) => ({ quote: s.quote, source_label: s.source_label, published_at: s.published_at })),
    })),
    score: data.read?.score ?? null,
    provisional: data.read?.provisional ?? true,
    families: data.read?.families ?? {},
    takeaways: data.read?.takeaways ?? [],
    cycle: data.read?.cycle ?? null,
  };
}

export function useScan() {
  const [state, setState] = useState<ScanState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  /**
   * Reattach to a scan that is (or was) running server-side: hydrate the view
   * from /api/scan/status and poll until the job lands. The job itself never
   * depends on this — closing the page loses nothing but the view.
   */
  const resume = useCallback(
    async (ticker: string) => {
      stopPolling();
      const stored = readActiveScan();
      const graceUntil = (stored?.at ?? Date.now()) + START_GRACE_MS;
      const tick = async () => {
        let running = false;
        try {
          const res = await fetch(`/api/scan/status?ticker=${encodeURIComponent(ticker)}`);
          const data = (await res.json()) as StatusSnapshot;
          if (!data.scan) {
            if (Date.now() < graceUntil) {
              // the scan row hasn't materialized yet (new tickers resolve
              // their sources first) — show it as starting and keep polling
              setState((s) => (s.phase === "running" ? s : { ...IDLE, phase: "running", startedAt: stored?.at ?? Date.now() }));
              running = true;
            } else {
              console.log(`scan resume: no scan for ${ticker} after the grace window — clearing the reattach key`);
              clearActiveScan();
            }
          } else {
            setState(stateFromSnapshot(data));
            running = data.scan.status === "running";
          }
        } catch {
          running = true; // transient poll failure — the job is server-side, try again
        }
        if (running) pollRef.current = setTimeout(tick, 2500);
      };
      await tick();
    },
    [stopPolling],
  );

  const start = useCallback(async (ticker: string) => {
    abortRef.current?.abort();
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    const abort = new AbortController();
    abortRef.current = abort;
    rememberActiveScan(ticker);
    setState({ ...IDLE, phase: "running", startedAt: Date.now() });

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        setState((s) => ({ ...s, phase: "error", error: body.error ?? `HTTP ${response.status}` }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          setState((s) => applyEvent(s, event));
        }
      }
      setState((s) => (s.phase === "running" ? { ...s, phase: "complete" } : s));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState((s) => ({ ...s, phase: "error", error: (err as Error).message }));
    }
  }, []);

  return { state, start, resume, stopPolling };
}

function applyEvent(s: ScanState, e: Record<string, unknown>): ScanState {
  switch (e.type) {
    case "scan_created":
      return {
        ...s,
        scanId: Number(e.scanId),
        company: e.company as ScanState["company"],
        sources: (e.sources as { key: string; label: string; family: string }[]).map((src) => ({
          ...src,
          status: "queued" as const,
        })),
      };
    case "sources_added": {
      const added = (e.sources as { key: string; label: string; family: string }[]).map((src) => ({
        ...src,
        status: "queued" as const,
      }));
      return { ...s, sources: [...s.sources, ...added] };
    }
    case "source_started":
      return patch(s, e.key as string, { status: "working" });
    case "source_progress":
      return patch(s, e.key as string, { purpose: e.purpose as string });
    case "source_streaming":
      return patch(s, e.key as string, { streamingUrl: e.streamingUrl as string });
    case "source_complete":
      return patch(s, e.key as string, {
        status: e.ok ? "complete" : "failed",
        durationMs: e.durationMs as number,
        itemsRead: e.itemsRead as number,
        note: e.note as string | null,
        error: e.error as string | undefined,
        samples: e.samples as SourceState["samples"],
      });
    case "score_updated":
      return {
        ...s,
        score: e.score as number | null,
        provisional: e.provisional as boolean,
        families: e.families as ScanState["families"],
      };
    case "takeaways":
      return { ...s, takeaways: e.items as TakeawayItem[], cycle: (e.cycle as CycleCallState | null) ?? null };
    case "scan_complete":
      return { ...s, phase: "complete", score: e.score as number | null };
    case "scan_error":
      return { ...s, phase: "error", error: e.message as string };
    default:
      return s;
  }
}

function patch(s: ScanState, key: string, changes: Partial<SourceState>): ScanState {
  return { ...s, sources: s.sources.map((src) => (src.key === key ? { ...src, ...changes } : src)) };
}
