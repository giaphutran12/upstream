export type CycleCallRow = {
  position: string;
  early_signals: string;
  direction: "down" | "up" | "mixed";
  call: string;
};

const DIRECTION_LABEL = {
  down: "▼ Downward pressure",
  up: "▲ Upward pressure",
  mixed: "◆ Mixed",
} as const;

/** This cycle: where the company sits between reports, and which way it's leaning. */
export function CycleStrip({ cycle }: { cycle: CycleCallRow }) {
  const rust = cycle.direction === "down";
  return (
    <div className="card" style={{ borderLeft: `3px solid ${rust ? "var(--color-rust)" : "var(--color-ink)"}` }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div className="eyebrow" style={{ color: "var(--color-rust)", letterSpacing: "0.16em" }}>
          This cycle
        </div>
        <div className="text-[12px] text-muted tnum">{cycle.position}</div>
        <div
          className="ml-auto text-[13px] font-semibold"
          style={{ color: rust ? "var(--color-rust)" : "var(--color-ink)" }}
        >
          {DIRECTION_LABEL[cycle.direction]}
        </div>
      </div>
      <div className="mt-2.5 font-serif text-[18px] leading-[1.35]">{cycle.call}</div>
      <div className="mt-2 text-[12.5px] leading-relaxed text-muted">
        <span className="eyebrow" style={{ fontSize: 10, letterSpacing: "0.12em" }}>Early signals&nbsp;&nbsp;</span>
        {cycle.early_signals}
      </div>
    </div>
  );
}
