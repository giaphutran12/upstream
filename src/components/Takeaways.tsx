export type TakeawayRow = {
  finding: string;
  why_it_matters: string;
  what_it_changes: string;
  sources: string[];
};

/** The read: three conclusions, stated for the reader — the page's lead, not its footnote. */
export function Takeaways({ items, generatedAgo }: { items: TakeawayRow[]; generatedAgo?: string }) {
  return (
    <div>
      <div className="rule-ink mb-1 flex items-baseline gap-4 pb-2">
        <div className="eyebrow" style={{ color: "var(--color-rust)", letterSpacing: "0.16em" }}>
          The read
        </div>
        <div className="text-[11px] text-muted">
          What we found, why it matters, what it changes — synthesized from this scan only
          {generatedAgo ? ` · ${generatedAgo}` : ""}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-8 pt-4 max-md:grid-cols-1">
        {items.map((item, i) => (
          <div key={i} className="flex gap-3.5">
            <div className="font-serif text-[28px] font-medium leading-none tnum" style={{ color: "var(--color-rust)" }}>
              {i + 1}
            </div>
            <div>
              <div className="font-serif text-[19px] font-medium leading-[1.3]">{item.finding}</div>
              <div className="mt-2.5 text-[12.5px] leading-relaxed">
                <span className="eyebrow" style={{ fontSize: 10, letterSpacing: "0.12em" }}>Why it matters&nbsp;&nbsp;</span>
                {item.why_it_matters}
              </div>
              <div className="mt-1.5 text-[12.5px] leading-relaxed">
                <span className="eyebrow" style={{ fontSize: 10, letterSpacing: "0.12em" }}>What it changes&nbsp;&nbsp;</span>
                {item.what_it_changes}
              </div>
              {item.sources.length > 0 && (
                <div className="mt-2 text-[11px] text-muted">{item.sources.join(" · ")}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
