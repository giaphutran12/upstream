"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type CompanyHit = { ticker: string; name: string };

/** Compact company typeahead for the top bar: name, partial, or typo → ticker page. */
export function CompanySearch({ section }: { section: "company" | "lead" }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/companies?q=${encodeURIComponent(q.trim())}`);
        const data = (await res.json()) as { results?: CompanyHit[] };
        setHits((data.results ?? []).slice(0, 6));
        setHighlight(0);
        setOpen((data.results ?? []).length > 0);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const go = (ticker: string) => {
    setOpen(false);
    setQ("");
    router.push(section === "lead" ? `/company/${ticker}/lead-time` : `/company/${ticker}`);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && hits.length) {
            e.preventDefault();
            setHighlight((h) => (h + 1) % hits.length);
          } else if (e.key === "ArrowUp" && hits.length) {
            e.preventDefault();
            setHighlight((h) => (h - 1 + hits.length) % hits.length);
          } else if (e.key === "Enter" && open && hits.length) {
            e.preventDefault();
            go(hits[highlight].ticker);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search any company…"
        aria-label="Search any listed company"
        autoComplete="off"
        className="w-[190px] border-b border-hairline bg-transparent pb-1 text-[12.5px] outline-none placeholder:text-muted focus:border-ink"
      />
      {open && hits.length > 0 && (
        <div
          className="absolute right-0 z-20 mt-1.5 w-[300px] border border-hairline"
          style={{ background: "var(--color-panel)" }}
          role="listbox"
        >
          {hits.map((hit, i) => (
            <button
              key={hit.ticker}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => go(hit.ticker)}
              className="flex w-full items-baseline gap-2.5 px-3 py-2 text-left rule-hairline"
              style={i === highlight ? { background: "var(--color-track)" } : undefined}
            >
              <span className="w-12 text-[12px] font-semibold tnum">{hit.ticker}</span>
              <span className="truncate text-[11.5px] text-muted">{hit.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
