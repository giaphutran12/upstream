import Image from "next/image";
import Link from "next/link";
import { CompanySearch } from "./CompanySearch";

export function TopBar({ active, ticker, now }: { active: "scan" | "company" | "lead"; ticker?: string; now?: string }) {
  // no fallback ticker: with no company in play the company tabs lead to the
  // directory of completed reads — always somewhere honest, never a guess
  const TABS = [
    { href: "/", label: "Live scan", key: "scan" },
    { href: ticker ? `/company/${ticker}` : "/company", label: "Company read", key: "company" },
    { href: ticker ? `/company/${ticker}/lead-time` : "/company", label: "Lead time", key: "lead" },
  ] as const;
  const stamp =
    now ??
    new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  return (
    <div className="flex items-center gap-5 px-12 py-[18px] rule-ink">
      <div className="font-serif text-2xl font-semibold tracking-tight">Upstream</div>
      <a
        href="https://tinyfish.ai"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 pt-[3px]"
        style={{ textDecoration: "none" }}
      >
        <Image src="/tinyfish.png" alt="TinyFish" width={17} height={17} />
        <span className="eyebrow text-muted" style={{ fontSize: 10, letterSpacing: "0.18em" }}>
          by TinyFish · Primary-source research
        </span>
      </a>
      <div className="ml-auto">
        <CompanySearch section={active === "lead" ? "lead" : "company"} />
      </div>
      <nav className="flex gap-7">
        {TABS.map((tab) => (
          <Link key={tab.key} href={tab.href} className={tab.key === active ? "nav-link nav-link--active" : "nav-link"}>
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="ml-5 flex items-center gap-2 text-xs text-muted tnum">
        <span className="pulse-dot" aria-hidden />
        LIVE · {stamp} ET
      </div>
    </div>
  );
}
