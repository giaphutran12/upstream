import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { readStoreBasket, medianCents } from "@/lib/menu";
import type { SourceProfile } from "@/lib/sources";

// Daily per-location menu pricing. Each sampled store needs a real browser for
// ~6-10 minutes, so this runs as its own cron (not inside the scan) and writes
// its counts against the company's latest complete scan — the movers table
// then surfaces price changes between scans like any other counted signal.

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker query param required" }, { status: 400 });

  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    console.log(`cron menu-prices ${ticker}: rejected — bad or missing authorization`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sql = db();
  const [company] = await sql`select id, name, source_profile from companies where ticker = ${ticker}`;
  if (!company) return Response.json({ error: `unknown ticker ${ticker}` }, { status: 404 });
  const pricing = (company.source_profile as SourceProfile).menuPricing;
  if (!pricing?.orderingUrl || !pricing.stores?.length || !pricing.basket?.length) {
    console.log(`cron menu-prices ${ticker}: no menuPricing in profile — nothing to do`);
    return Response.json({ ticker, ok: false, error: "no menuPricing configured" }, { status: 422 });
  }
  const [scan] = await sql`
    select id from scans where company_id = ${company.id} and status = 'complete'
    order by started_at desc limit 1`;
  if (!scan) return Response.json({ ticker, ok: false, error: "no complete scan to attach prices to" }, { status: 422 });

  const started = Date.now();
  // ONE store per run: a store takes ~6-10 min of real browser, so two in
  // parallel get terminated by the platform and two in sequence blow the 800s
  // function ceiling. The run rotates through the fixed sample day by day —
  // every store still gets a comparable same-store delta every N days.
  const dayIndex = Math.floor(Date.now() / 86_400_000) % pricing.stores.length;
  const store = request.nextUrl.searchParams.get("store") ?? pricing.stores[dayIndex];
  console.log(`cron menu-prices ${ticker}: reading ${store} (rotation ${dayIndex + 1}/${pricing.stores.length})`);

  const result = await readStoreBasket({ orderingUrl: pricing.orderingUrl, store, basket: pricing.basket });
  if (!result.ok) {
    console.log(`cron menu-prices ${ticker}: ${store} failed because ${result.error}`);
    return Response.json({ ticker, ok: false, store, error: result.error }, { status: 502 });
  }
  const baskets = [result.basket];
  console.log(`cron menu-prices ${ticker}: ${store} — ${result.basket.items.length} priced items in ${Math.round(result.durationMs / 1000)}s`);

  // per-store per-item prices as counted evidence; median as the tracked metric.
  // only this store's rows are replaced — other stores' latest prices persist
  await sql`
    delete from footprint_counts where scan_id = ${scan.id} and dimension = 'menu_price_cents'
      and key like ${`${result.basket.store} ·%`}`;
  for (const basket of baskets) {
    for (const item of basket.items) {
      await sql`
        insert into footprint_counts (company_id, scan_id, dimension, key, count)
        values (${company.id}, ${scan.id}, 'menu_price_cents', ${`${basket.store} · ${item.name}`}, ${Math.round(item.priceUsd * 100)})`;
    }
  }
  const median = medianCents(baskets)!;
  await sql`delete from signal_metrics where scan_id = ${scan.id} and metric_key = 'menu_basket_median'`;
  await sql`
    insert into signal_metrics (company_id, scan_id, metric_key, family, value, unit, baseline_label, sources)
    values (${company.id}, ${scan.id}, 'menu_basket_median', 'ops', ${median}, 'cents, median basket item',
      ${`${baskets.length} sampled store(s), ${baskets.reduce((n, b) => n + b.items.length, 0)} priced items — read by browser agents`},
      'Ordering site, per store')`;

  const durationMs = Date.now() - started;
  console.log(`cron menu-prices ${ticker}: complete in ${durationMs}ms — median ${median}¢ across ${baskets.length} stores, attached to scan ${scan.id}`);
  return Response.json({ ticker, ok: true, scanId: Number(scan.id), stores: baskets.length, medianCents: median, durationMs });
}
