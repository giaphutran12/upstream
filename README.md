# Upstream — equity research on first-hand signal

Every research tool summarizes published coverage; by the time it's published, it's priced in. Upstream sends live TinyFish agents to the primary sources — Reddit, Trustpilot, app stores, careers pages, SEC EDGAR, Downdetector — and turns what customers and employees are doing *right now* into a directional read on a public company, with every claim citing a verbatim, timestamped source.

**The signature:** the lead-time timeline. Cracker Barrel's complaint velocity turned on May 4, 2026; the CEO-departure 8-K reached EDGAR on July 27 — a measured **84-day lead**. Measured, not modeled.

## Screens

- **Live scan** — type any US-listed ticker; agents fan out (waves of 5), results stream in over SSE, the Direction Score assembles as each source lands. When the scan completes, **The read** appears: three synthesized takeaways.
- **Company read** — leads with conclusions, not quotes:
  1. **The read** — three takeaways (what we found · why it matters · what it changes), synthesized only from this scan's measured numbers and verbatim-gated evidence.
  2. **What moved since the last scan** — the delta is the product: every metric's prior → current move, with the evidence behind it. Scans accumulate; the first run sets the baseline.
  3. **Counted at scale** — locations by state enumerated live from the company's own sitemap (CBRL: ~655 store pages), open roles by department from the public ATS API. Counted in code — no model in the loop. Per-key deltas surface closures and hiring shifts.
  4. Signal tiles and the verbatim evidence table move below, as supporting evidence.
- **Lead-time timeline** — the leading signal plotted against official filings on one axis.

## How it uses TinyFish

Escalation ladder per source: **fetch → stealth agent**. Plain fetch first (free); when a site blocks it (Reddit, Trustpilot 403 non-browser clients), the same source escalates to a stealth-profile agent with a US proxy:

```ts
// src/lib/tinyfish.ts
const stream = await tf().agent.stream({
  url: opts.url,
  goal: opts.goal, // JSON shape embedded in the goal, cookbook-style
  browser_profile: opts.stealth ? BrowserProfile.STEALTH : BrowserProfile.LITE,
  proxy_config: { enabled: true, country_code: "US" },
});
for await (const event of stream) {
  if (event.type === "STREAMING_URL") opts.onStreamingUrl?.(event.streaming_url, event.run_id);
  else if (event.type === "PROGRESS") opts.onProgress?.(event.purpose);
  else if (event.type === "COMPLETE") { complete = event; break; }
}
// COMPLETED only means the browser ran without crashing — validate content:
const result = normalizeResult(complete.result);
if (result != null) return { ok: true, ... };
```

Layoff intel uses **search → fetch** (targeted, ~10s) instead of browsing tracker UIs. SEC EDGAR is parsed deterministically in code — no LLM near structured data.

**Counting, not reading:** the store footprint walks robots.txt → the location sitemap → every store detail page URL, and counts by state in code (`src/lib/footprint.ts`). ATS boards (Greenhouse/Lever) are public JSON, counted by department and market the same way. These counts feed `footprint_counts` per scan, so the next scan shows exactly which states lost stores and which departments stopped hiring.

**Synthesis** (`src/lib/synthesize.ts`) runs once per scan, after every source lands: the model receives only numbers computed in code and quotes that survived the verbatim gate, and must produce exactly three takeaways citing them. Deltas (`src/lib/movers.ts`) are computed in SQL/code — the model never does arithmetic.

## Anti-hallucination

- Extracted quotes must appear **verbatim** in the fetched text (substring gate in code) or they're discarded.
- Every source carries a `metricHint`; the normalizer must return `null` rather than substitute a different number.
- Per-family scoring rubrics ("a layoff in the last 90 days never scores above 50") keep the read defensible.
- Provenance (source URL, scraped-at) is stamped server-side, never trusted from the model.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in keys
node scripts/apply-schema.mjs   # idempotent; needs DATABASE_URL loaded
node scripts/seed.mjs           # demo companies + CBRL lead-time backtest
npm run dev
```

Postgres is raw (`postgres` driver over the Supabase session pooler) — no ORM, no supabase-js. Env vars are listed in `.env.example`. Design system: `docs/DESIGN.md` (locked from a Claude Design handoff in `docs/design-handoff/`).
