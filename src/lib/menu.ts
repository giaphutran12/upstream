import { runAgent, withBrowserSlot } from "./tinyfish";

// Menu prices by location: the numbers live inside an ordering SPA that plain
// fetch cannot see, so a real browser agent reads a fixed basket at a fixed
// store sample. One store takes ~6-10 minutes, which is why this runs as its
// own daily cron and not inside the scan.

export type StoreBasket = {
  store: string;
  items: { name: string; priceUsd: number }[];
};

const PRICE_MIN = 1;
const PRICE_MAX = 60;

/** Read the basket at one store. Validates content, not status. */
export async function readStoreBasket(opts: {
  orderingUrl: string;
  store: string;
  basket: string[];
}): Promise<{ ok: true; basket: StoreBasket; durationMs: number } | { ok: false; error: string; durationMs: number }> {
  const goal = `Select the store at "${opts.store}" for pickup (choose In-Store Pickup if asked). Open its menu and report the exact listed prices of these items: ${opts.basket.join(
    ", ",
  )}. Skip any item the menu does not list. Return STRICT JSON only: {"store":"city, state","items":[{"name":"...","price_usd":0.00}]} with prices exactly as displayed.`;
  const outcome = await withBrowserSlot(() =>
    runAgent({ url: opts.orderingUrl, goal, stealth: true, proxyUS: true, timeoutMs: 700_000 }),
  );
  if (!outcome.ok) return { ok: false, error: outcome.error ?? "agent failed", durationMs: outcome.durationMs };

  const raw = outcome.result as { store?: string; items?: { name?: string; price_usd?: unknown }[] } | undefined;
  const items = (raw?.items ?? [])
    .map((i) => ({ name: String(i.name ?? "").trim(), priceUsd: Number(i.price_usd) }))
    .filter((i) => i.name.length > 1 && Number.isFinite(i.priceUsd) && i.priceUsd >= PRICE_MIN && i.priceUsd <= PRICE_MAX);
  // fewer than 3 plausible prices means the agent wandered — reject the run
  if (items.length < 3) {
    return {
      ok: false,
      error: `agent returned ${items.length} plausible prices (need ≥3) — content rejected`,
      durationMs: outcome.durationMs,
    };
  }
  return { ok: true, basket: { store: String(raw?.store ?? opts.store), items }, durationMs: outcome.durationMs };
}

export function medianCents(baskets: StoreBasket[]): number | null {
  const cents = baskets.flatMap((b) => b.items.map((i) => Math.round(i.priceUsd * 100))).sort((a, b) => a - b);
  if (cents.length === 0) return null;
  return cents[Math.floor(cents.length / 2)];
}
