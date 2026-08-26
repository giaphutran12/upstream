"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { rememberActiveScan } from "@/hooks/use-scan";

type ScanStatus = {
  scan: { id: number; status: string; error: string | null } | null;
  sources?: { total: number; complete: number; failed: number; running: number };
  working?: string[];
};

/**
 * Read-only view of a scan that is already running server-side. The scan is
 * one background job persisting to Postgres as it goes; this component never
 * starts work — it polls /api/scan/status and refreshes this page into the
 * full read the moment the job lands. Clicking around never loses the scan.
 */
export function ScanWait({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [landed, setLanded] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`/api/scan/status?ticker=${encodeURIComponent(ticker)}`);
        const data = (await res.json()) as ScanStatus;
        if (stopped) return;
        setStatus(data);
        if (data.scan?.status === "running") setRestarting(false);
        if (data.scan?.status === "complete") {
          setLanded(true);
          router.refresh(); // the server page re-renders into the full read
          return;
        }
      } catch {
        // transient poll failure — the job is server-side either way, keep polling
      }
      if (!stopped) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [ticker, router]);

  if (landed) {
    return (
      <div className="card" style={{ borderColor: "var(--color-rust)" }}>
        <div className="text-[13px] font-semibold">Scan complete — the read is opening in place…</div>
      </div>
    );
  }

  if (status?.scan?.status === "failed" && !restarting) {
    return (
      <div className="border p-4 text-[13px]" style={{ borderColor: "var(--color-rust)" }}>
        <div>The scan stopped: {status.scan.error ?? "unknown error"}.</div>
        <button
          onClick={() => {
            setRestarting(true);
            rememberActiveScan(ticker); // the Live Scan tab reattaches to this run too
            // fire the background job and drop the stream immediately — the
            // pipeline persists on its own and the poll above tracks it
            void fetch("/api/scan", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ticker }),
            })
              .then((r) => r.body?.cancel())
              .catch(() => {});
          }}
          className="mt-3 border px-4 py-2 text-[12.5px] font-semibold"
          style={{ borderColor: "var(--color-rust)", color: "var(--color-rust)", background: "transparent", cursor: "pointer" }}
        >
          Run it again
        </button>
      </div>
    );
  }

  const s = status?.sources;
  const done = s ? s.complete + s.failed : 0;
  return (
    <div className="card" style={{ borderColor: "var(--color-rust)" }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="pulse-dot pulse-dot--fast" aria-hidden />
        <span className="text-[13px] font-semibold">
          {restarting
            ? "Restarting the scan…"
            : s
              ? `Scan in progress — ${done} of ${s.total} sources in`
              : "Scan in progress — checking status…"}
        </span>
        {!restarting && status?.working && status.working.length > 0 && (
          <span className="text-[12px] text-muted">
            working: {status.working.slice(0, 4).map((k) => k.replaceAll("_", " ")).join(", ")}
          </span>
        )}
      </div>
      <div className="card-footer">
        The scan runs and persists on the server — leave, click around, come back; this page becomes the read when it lands.
      </div>
    </div>
  );
}
