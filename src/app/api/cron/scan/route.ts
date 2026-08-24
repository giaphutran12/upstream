import { NextRequest } from "next/server";

// Scheduled accumulation: the delta view is only worth anything once history
// exists, so Vercel cron drives a real scan per ticker daily (vercel.json).
// This route POSTs to /api/scan on its own origin and drains the SSE stream
// so the function stays alive until the scan lands.

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker query param required" }, { status: 400 });

  // Vercel sends Authorization: Bearer CRON_SECRET when the env var is set.
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    console.log(`cron scan ${ticker}: rejected — bad or missing authorization`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  console.log(`cron scan ${ticker}: starting`);
  const response = await fetch(new URL("/api/scan", request.nextUrl.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker }),
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    console.log(`cron scan ${ticker}: /api/scan returned ${response.status} — ${body.slice(0, 200)}`);
    return Response.json({ error: `scan returned ${response.status}` }, { status: 502 });
  }

  // drain the SSE stream; remember the terminal event
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: { scanId?: number; score?: number | null; error?: string } = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type: string; scanId?: number; score?: number | null; message?: string };
        if (event.type === "scan_complete") outcome = { scanId: event.scanId, score: event.score };
        if (event.type === "scan_error") outcome = { error: event.message };
      } catch {
        /* partial line — next chunk completes it */
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }

  const durationMs = Date.now() - started;
  if (outcome.error) {
    console.log(`cron scan ${ticker}: failed after ${durationMs}ms because ${outcome.error}`);
    return Response.json({ ticker, ok: false, error: outcome.error, durationMs }, { status: 500 });
  }
  console.log(`cron scan ${ticker}: complete in ${durationMs}ms — scan ${outcome.scanId}, score ${outcome.score}`);
  return Response.json({ ticker, ok: true, scanId: outcome.scanId, score: outcome.score, durationMs });
}
