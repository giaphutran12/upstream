import Link from "next/link";
import { db } from "@/lib/db";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

/**
 * The company directory: where "Company read" leads when no company is in
 * play yet. Every company with a completed read, freshest first — no dead
 * tabs, no guessed tickers.
 */
export default async function CompanyDirectoryPage() {
  const sql = db();
  const rows = await sql`
    select distinct on (companies.id)
      companies.ticker, companies.name, companies.sector,
      scans.direction_score, scans.completed_at
    from companies
    join scans on scans.company_id = companies.id and scans.status = 'complete'
    order by companies.id, scans.completed_at desc`;
  rows.sort((a, b) => new Date(String(b.completed_at)).getTime() - new Date(String(a.completed_at)).getTime());
  console.log(`company directory: ${rows.length} companies with completed reads`);

  return (
    <main className="min-h-screen">
      <TopBar active="company" />
      <div className="max-w-[1100px] px-12 pb-16 pt-12">
        <div className="eyebrow mb-3.5" style={{ color: "var(--color-rust)", letterSpacing: "0.16em" }}>
          Company reads
        </div>
        <h1 className="font-serif text-[46px] font-medium leading-[1.05] tracking-tight">Every company on file.</h1>
        <div className="mt-4 max-w-[760px] text-[15px] leading-relaxed text-muted">
          Each read below was built by agents against primary sources. Pick one, or scan a new company from{" "}
          <Link href="/">Live scan</Link> — first reads take about two minutes.
        </div>

        {rows.length === 0 ? (
          <div className="card card--queued mt-10 py-10 text-center text-[13px] text-muted">
            No completed reads yet — <Link href="/">run the first scan</Link>.
          </div>
        ) : (
          <div className="mt-10">
            <div className="rule-ink flex items-baseline gap-4 pb-2 text-[11px] text-muted" style={{ letterSpacing: "0.1em" }}>
              <span className="w-20">TICKER</span>
              <span className="flex-1">COMPANY</span>
              <span className="w-24 text-right">DIRECTION</span>
              <span className="w-28 text-right">LAST SCAN</span>
              <span className="w-24 text-right" />
            </div>
            {rows.map((row) => (
              <div key={String(row.ticker)} className="rule-hairline flex items-baseline gap-4 py-3.5">
                <Link href={`/company/${row.ticker}`} className="w-20 text-[14px] font-semibold tnum">
                  {String(row.ticker)}
                </Link>
                <span className="flex-1 text-[13.5px]">
                  {String(row.name)}
                  {row.sector ? <span className="text-muted"> · {String(row.sector)}</span> : null}
                </span>
                <span className="w-24 text-right text-[14px] font-semibold tnum">
                  {row.direction_score != null ? Number(row.direction_score) : "—"}
                </span>
                <span className="w-28 text-right text-[12px] text-muted tnum">{timeAgo(String(row.completed_at))}</span>
                <span className="w-24 text-right">
                  <Link href={`/company/${row.ticker}/lead-time`} className="text-[12px]">
                    lead time →
                  </Link>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function timeAgo(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
