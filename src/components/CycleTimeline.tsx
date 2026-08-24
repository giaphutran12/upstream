"use client";

import { useRef, useState } from "react";

export type CycleTimelineData = {
  filings: { px: number; label: string; isKey: boolean; expected: boolean; anchorEnd: boolean; labelY: number }[];
  dots: { px: number; py: number; fresh: boolean; on: string; quote: string; sourceLabel: string; family: string }[];
  months: { label: string; px: number }[];
  todayX: number;
  expectedX: number | null;
  cycleShade: { x0: number; x1: number } | null;
};

type Tip = { x: number; y: number; dot: CycleTimelineData["dots"][number] };

/**
 * The reporting-cycle timeline, client-side only so every evidence dot is
 * hoverable: the tooltip shows the exact signal — source, date, verbatim
 * quote — that the dot stands for. Layout is computed on the server and
 * passed in; this component adds nothing but the hover layer.
 */
export function CycleTimeline({ timeline, ariaLabel, bracketLabel }: { timeline: CycleTimelineData; ariaLabel: string; bracketLabel: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const showTip = (e: React.MouseEvent, dot: CycleTimelineData["dots"][number]) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({
      x: Math.min(Math.max(e.clientX - rect.left + 14, 8), rect.width - 348),
      y: e.clientY - rect.top + 16,
      dot,
    });
  };

  return (
    <div ref={wrap} className="relative">
      <svg viewBox="0 0 1240 280" className="block w-full" role="img" aria-label={ariaLabel}>
        {timeline.cycleShade && (
          <rect x={timeline.cycleShade.x0} y={30} width={timeline.cycleShade.x1 - timeline.cycleShade.x0} height={90} fill="var(--color-rust)" opacity={0.05} />
        )}
        <line x1={60} y1={120} x2={1180} y2={120} stroke="var(--color-ink)" strokeWidth={1.5} />
        {timeline.months.map((m) => (
          <text key={m.label + m.px} x={m.px} y={138} fontSize={10.5} fill="var(--color-muted)">{m.label}</text>
        ))}
        {timeline.dots.map((dot, i) => (
          <g key={i}>
            <circle cx={dot.px} cy={dot.py} r={3.2}
              fill={dot.fresh ? "var(--color-rust)" : "var(--color-hairline)"}
              stroke={dot.fresh ? "none" : "var(--color-muted)"} strokeWidth={dot.fresh ? 0 : 0.5} />
            {/* oversized invisible hit target: 3.2px dots are unhoverable on their own */}
            <circle cx={dot.px} cy={dot.py} r={9} fill="transparent" style={{ cursor: "pointer" }}
              onMouseEnter={(e) => showTip(e, dot)} onMouseMove={(e) => showTip(e, dot)} onMouseLeave={() => setTip(null)} />
          </g>
        ))}
        {timeline.filings.map((mark, i) => (
          <g key={i}>
            {mark.expected ? (
              <rect x={mark.px - 4} y={116} width={8} height={8} fill="none" stroke="var(--color-rust)" strokeWidth={1.5} />
            ) : (
              <rect x={mark.px - 4} y={116} width={8} height={8} fill={mark.isKey ? "var(--color-rust)" : "var(--color-ink)"} />
            )}
            <line x1={mark.px} y1={124} x2={mark.px} y2={mark.labelY - 10} stroke={mark.isKey || mark.expected ? "var(--color-rust)" : "var(--color-muted)"} strokeWidth={1} opacity={mark.expected ? 0.7 : 1} />
          </g>
        ))}
        {/* all labels after all leaders; the paper halo keeps glyphs clean
            even on the fallback path where a leader may still cross */}
        {timeline.filings.map((mark, i) => (
          <text key={`label-${i}`} x={mark.anchorEnd ? mark.px - 6 : mark.px + 6} y={mark.labelY}
            textAnchor={mark.anchorEnd ? "end" : "start"} fontSize={11.5}
            fontWeight={mark.isKey || mark.expected ? 600 : 400}
            fill={mark.expected ? "var(--color-rust)" : mark.isKey ? "var(--color-ink)" : "var(--color-muted)"}
            paintOrder="stroke" stroke="var(--color-paper)" strokeWidth={3.5} strokeLinejoin="round">
            {mark.label}
          </text>
        ))}
        <line x1={timeline.todayX} y1={34} x2={timeline.todayX} y2={120} stroke="var(--color-ink)" strokeWidth={1} strokeDasharray="2 4" />
        {timeline.cycleShade && bracketLabel && (
          (() => {
            const { x0, x1 } = timeline.cycleShade;
            const wide = x1 - x0 >= 250;
            return (
              <g>
                <line x1={x0} y1={30} x2={x1} y2={30} stroke="var(--color-rust)" strokeWidth={1.5} />
                <line x1={x0} y1={24} x2={x0} y2={36} stroke="var(--color-rust)" strokeWidth={1.5} />
                <line x1={x1} y1={24} x2={x1} y2={36} stroke="var(--color-rust)" strokeWidth={1.5} />
                <text x={wide ? (x0 + x1) / 2 : x0 - 10} y={wide ? 21 : 33}
                  textAnchor={wide ? "middle" : "end"} fontSize={10.5} fontWeight={600} letterSpacing={1.5}
                  fill="var(--color-rust)">
                  {bracketLabel}
                </text>
              </g>
            );
          })()
        )}
        {timeline.expectedX != null && (
          <line x1={timeline.expectedX} y1={52} x2={timeline.expectedX} y2={116} stroke="var(--color-rust)" strokeWidth={1} strokeDasharray="2 4" opacity={0.6} />
        )}
      </svg>
      {tip && (
        <div
          className="absolute z-10 border px-3.5 py-2.5"
          style={{
            left: tip.x,
            top: tip.y,
            width: 340,
            background: "var(--color-panel)",
            borderColor: tip.dot.fresh ? "var(--color-rust)" : "var(--color-hairline)",
            pointerEvents: "none",
          }}
        >
          <div className="flex items-baseline gap-2 text-[11.5px] font-semibold tnum">
            <span style={{ color: tip.dot.fresh ? "var(--color-rust)" : "var(--color-ink)" }}>{tip.dot.sourceLabel}</span>
            <span className="text-muted">{tip.dot.on}</span>
            <span className="ml-auto text-muted" style={{ textTransform: "capitalize" }}>
              {tip.dot.family}{tip.dot.fresh ? " · this cycle" : ""}
            </span>
          </div>
          <div className="quote mt-1.5 text-[12.5px] leading-snug">
            “{tip.dot.quote.length > 180 ? `${tip.dot.quote.slice(0, 179)}…` : tip.dot.quote}”
          </div>
        </div>
      )}
    </div>
  );
}
