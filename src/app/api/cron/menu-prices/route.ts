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
  // two fixed stores per run keeps the whole job under the function ceiling
  const stores = pricing.stores.slice(0, 2);
  console.log(`cron menu-prices ${ticker}: reading ${stores.length} stores (${stores.join(" · ")})`);

  const results = await Promise.all(
    stores.map((store) => readStoreBasket({ orderingUrl: pricing.orderingUrl, store, basket: pricing.basket })),
  );
  const baskets = [];
  for (const [i, r] of results.entries()) {
    if (r.ok) {
      baskets.push(r.basket);
      console.log(`cron menu-prices ${ticker}: ${stores[i]} — ${r.basket.items.length} priced items in ${Math.round(r.durationMs / 1000)}s`);
    } else {
      console.log(`cron menu-prices ${ticker}: ${stores[i]} failed because ${r.error}`);
    }
  }
  if (baskets.length === 0) {
    return Response.json({ ticker, ok: false, error: "no store returned a valid basket" }, { status: 502 });
  }

  // per-store per-item prices as counted evidence; median as the tracked metric
  await sql`delete from footprint_counts where scan_id = ${scan.id} and dimension = 'menu_price_cents'`;
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
