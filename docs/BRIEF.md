# Upstream — Equity Research on First-Hand Signal

> Working name: **Upstream** (signal before it's priced in). Angle brief, 2026-08-21. Grounded in `docs/research/`.

## The one-liner

An analyst picks a company. Upstream sends live web agents to the primary sources — customer complaints, app reviews, careers pages, exec announcements — and returns a **directional read with receipts**: a decomposed score, week-over-week velocity, and a timeline proving the signal led the filing.

**The thesis on screen:** every other tool summarizes coverage; by the time it's published, it's priced in. Upstream watches the sources that *precede* coverage. The filing is the lagging indicator — we plot it as one.

## What it is NOT (anti-generic guardrails)

- Not a report generator. No prose walls. If a screen could have come out of Gemini deep research, it's wrong.
- No number without a baseline. Every metric carries "vs. its own trailing history" — velocity over level, always.
- No opaque score. The composite is always decomposed into its named inputs in the same view (Quiver DC-Insider pattern).
- No claim without a receipt. Every evidence row links to the dated, scraped source — verbatim quote, timestamp, URL, scraped-at.
- Honest about exclusions: LinkedIn is listed as "known, excluded (ToS)" — an engineering call shown in the UI, not a silent gap.

## The three screens

### 1. Live Scan (the TinyFish moment)
User enters a ticker → source-resolution step (TinyFish **search**: find the subreddit, Trustpilot domain, app-store IDs, ATS job board, EDGAR CIK, newsroom URL) → fan-out of **fetch/agent** runs, one per source, streamed to the UI as a rail of source cards flipping from "agent browsing…" (with live `streaming_url` browser view available) → evidence rows land as each completes. The audience literally watches agents walk Reddit, Trustpilot, and a careers page. This screen is the demo's opening 60 seconds.

### 2. Company Read (the spine — Quiver-style entity page)
- Header: company, ticker, price context, **Direction Score** (0–100 with ▲/▼ trend) decomposed inline into its four families:
  - **Customer Sentiment 40%** — Reddit post/comment sentiment + velocity, Trustpilot rating trend + review velocity, app-store rating deltas, BBB complaint velocity
  - **Workforce 30%** — job-posting count by department (ATS API), posting velocity, layoffs.fyi/WARN events
  - **Leadership 20%** — exec departures/appointments from newsroom + 8-K 5.02, tenure churn
  - **Product/Ops 10%** — Downdetector incident volume, status-page incidents, pricing-page diffs (Wayback baseline)
- Signal tiles: headline delta ("+38% complaint velocity, 7d") + sparkline + baseline note, one tile per family metric.
- **"What changed this week"** module: ranked biggest movers across all signals — the analyst's first click.
- Evidence tables per family: verbatim quotes/excerpts, dated, sourced, one hop from every number.

### 3. Lead-Time Timeline (the killer visual, Bloomberg-ALTD pattern)
One timeline: our leading signals (sentiment velocity, hiring velocity) plotted **against** official disclosure events (8-K filings, press releases) and price. The gap between "signal moved" and "filing landed" is the product, made visually self-evident. Pre-seeded calibration case: **Cracker Barrel** — complaint/sentiment collapse predating the 2026-07-27 CEO-departure 8-K by months. The pitch line: "here's the lead time on a known case; now run it live on any company."

## Demo script (Glean GO)

1. Open on Cracker Barrel's Lead-Time Timeline — the backtest. 30 seconds of "this is what leading actually means."
2. Live scan on **Etsy** (or Starbucks — both have live 2026 stories): agents fan out on stage, score assembles piece by piece.
3. Drill one evidence row from score → verbatim seller complaint, dated last week, linked to source.
4. Closer: "What changed this week" across the tracked watchlist.

Reliability plan: every scan persists; the stage demo can replay the latest stored scan instantly while a genuinely live scan streams in parallel. Conference wifi never gets to kill the demo.

## Sources per scan (escalation ladder: search → fetch → agent)

| Source | Primitive | Reliability |
|---|---|---|
| Reddit `.json` listings | fetch | High |
| Trustpilot (`__NEXT_DATA__`) | fetch | High |
| Apple/Google app store pages | fetch | High |
| Greenhouse/Lever ATS APIs | fetch | Very high |
| layoffs.fyi | fetch | High |
| SEC EDGAR full-text (8-K 5.02) | fetch | Very high |
| Company newsroom | agent (lite) | High |
| Downdetector | agent (stealth) | Medium — cached fallback |
| BBB complaints | agent (stealth) | Medium |
| Pricing page + Wayback diff | fetch | Medium |
| Glassdoor | excluded live; cached snapshot only | Low |
| LinkedIn | excluded, stated in UI | — |

Concurrency: waves of 5 agent runs (plan limits). Every run validated on content, not status.

## Scoring (stated, not hidden)

Per family: evidence normalized by LLM (GPT-5 for classification/sentiment; Fireworks open-source for bulk labeling) → family score = trend direction × velocity (magnitude × recency) vs own trailing baseline → composite = 40/30/20/10 weighted. Weights shown in the UI with a methodology popover: "starting weights, backtested against Cracker Barrel." Sub-scores always visible next to the composite.

## Architecture

- Next.js (App Router, TS, Tailwind + shadcn), deployed on Vercel.
- TinyFish via `@tiny-fish/sdk`, server-side SSE routes (`runtime nodejs`, `maxDuration 800`), district-rent-shark pattern.
- **Raw Postgres** (`postgres` driver, Supabase session pooler via `DATABASE_URL`) — no supabase-js.
- Tables: `companies` (resolved source profile), `scans`, `source_runs` (per-source raw result + status + streaming url), `evidence` (normalized rows: quote, sentiment, date, url, family), `signal_scores` (per scan per family), `official_events` (8-Ks, press releases — the lagging track for the timeline).
- Deltas computed between scans; Wayback + first-scan backfill seeds baselines for new companies.
- Logging: every scan/source run logs id, source, duration, result size, reason on failure — success and failure both.

## v1 cut (Friday EOD)

- Live scan + Company Read + Lead-Time Timeline for a curated six: CBRL (pre-seeded backtest), ETSY, SBUX, TSLA, Z, UNH. Arbitrary-ticker entry works via source resolution but the six are guaranteed-good.
- Score + evidence + "what changed" module. Watchlist page if time allows, else cut.
- Not in v1: alerts, auth, sector-peer baselines (self-baseline only), Bluesky.

## Iteration 2 (2026-08-24, from GTM feedback)

Feedback: v1 read generic — "aggregates what anyone could pull from Google." Three changes shipped:

1. **Conclusions first.** Company Read now opens with **The read** — three synthesized takeaways (finding · why it matters · what it changes), generated once per scan from that scan's own measured numbers and verbatim-gated quotes only (`src/lib/synthesize.ts`). Quotes moved below as supporting evidence.
2. **The delta is the product.** **What moved since the last scan** — every metric's prior → current move with the evidence behind it, computed in code (`src/lib/movers.ts`). First scan sets the baseline; every scan accumulates history.
3. **Counting, not reading.** **Counted at scale** — store locations enumerated live from the company's own location sitemap (robots.txt → sitemap → every store URL, counted by state in code; CBRL: 655 in ~8s), open roles counted by department/market from public ATS JSON (`src/lib/footprint.ts`). Per-key deltas surface closures and hiring shifts scan-over-scan. New table: `footprint_counts`.

Also: TinyFish logo in the top bar; DASH seeded (live Greenhouse board) — ETSY's board moved to Workday, so its careers source uses the agent path.

## Iteration 3 (2026-08-24 PM, from Edward's review)

1. **Search everywhere.** Fuzzy company search moved into the top bar on every page — Company Read and Lead Time were dead ends without it.
2. **The cycle read, for any company.** 10-Q/10-K filings ingest as cycle anchors; evidence dated after the anchor is this cycle's early signal. Synthesis adds a direction call (up/down/mixed pressure into the next report) calibrated against how the last cycle resolved — CBRL's measured 84-day lead, or "similar complaints last cycle didn't dent the record" for the Apple case. Lead-time page shows a this-cycle timeline (filings ■, dated evidence ●, today, expected next report □) for any ticker.
3. **Depth planner (agentic, not API wrappers).** An LLM planner decides what "deeper" means per company and dispatches search+fetch probes — browsers only on escalation. AAPL first run: developer-forum failure reports, repair community, NLRB records, EU DMA enforcement (3/4 yielded). Probe yield persists in source_runs as the planner's playbook: repeat what worked, drop dead ends.
4. **Framework call:** researched Mastra (subagent report) — young 1.0, Vercel serverless friction, would be a multi-day rewrite for problems we don't have; staying hand-rolled, revisit after the conference. Next step there: multi-round planner loop (plan → probe → assess family coverage → deepen, capped rounds) + a source_playbook table.
