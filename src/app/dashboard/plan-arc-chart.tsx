/**
 * PlanArcChart — compact SVG bar chart showing the full training plan arc.
 *
 * Handles plans with mileage ranges (uploaded plans): the bar is split into
 * a solid base (up to the minimum) and a lighter extension (min → max), so
 * the range is visible without needing a number label on every bar.
 *
 * - Past weeks: light gray
 * - Current week: dark fill + border outline
 * - Future weeks: medium gray
 * - Range extension: same color, 35% opacity
 * - Race weeks: small red dot + dashed stem above the bar
 */

export type ArcWeek = {
  week_number: number;
  mileage_target: number;        // midpoint (used for scale)
  mileage_target_min?: number;
  mileage_target_max?: number;
};

export function PlanArcChart({
  weeks,
  currentWeek,
  totalWeeks,
  raceWeekNums,
  useMetric,
}: {
  weeks: ArcWeek[];
  currentWeek: number;
  totalWeeks: number;
  raceWeekNums: number[];
  useMetric: boolean;
}) {
  if (weeks.length === 0) return null;

  const n = weeks.length;
  const FLAG_H = 18;
  const CHART_H = 60;
  const LABEL_H = 14;
  const SVG_H = FLAG_H + CHART_H + LABEL_H;
  // Narrower bars for longer plans so everything fits in the viewport
  const BAR_W = n <= 12 ? 16 : n <= 20 ? 14 : n <= 28 ? 12 : 10;
  const GAP = 2;
  const totalW = n * (BAR_W + GAP) - GAP;

  const hasAnyRange = weeks.some(
    w => w.mileage_target_min != null && w.mileage_target_max != null
      && (w.mileage_target_max - (w.mileage_target_min ?? 0)) > 0.5
  );

  // Scale to the tallest possible bar (use max value if ranges present)
  const maxMileage = Math.max(
    ...weeks.map(w => w.mileage_target_max ?? w.mileage_target),
    1
  );

  const raceSet = new Set(raceWeekNums);
  // Sparse label cadence so numbers don't collide
  const labelEvery = n <= 8 ? 1 : n <= 16 ? 2 : n <= 24 ? 4 : 5;

  const toH = (miles: number) => Math.max(2, (miles / maxMileage) * CHART_H);

  // Peak week for the summary line
  const peakWeek = weeks.reduce((best, w) =>
    (w.mileage_target_max ?? w.mileage_target) > (best.mileage_target_max ?? best.mileage_target)
      ? w : best
  , weeks[0]!);
  const peakMi = useMetric
    ? `${Math.round((peakWeek.mileage_target_max ?? peakWeek.mileage_target) * 1.60934)} km`
    : `${Math.round(peakWeek.mileage_target_max ?? peakWeek.mileage_target)} mi`;

  return (
    <div className="space-y-2">
      {/* Arc chart */}
      <div className="overflow-x-auto">
        <svg
          width={totalW}
          height={SVG_H}
          style={{ display: "block" }}
          aria-label="Training plan arc"
        >
          {/* Baseline */}
          <line
            x1={0} y1={FLAG_H + CHART_H}
            x2={totalW} y2={FLAG_H + CHART_H}
            stroke="#e5e7eb" strokeWidth={1}
          />

          {weeks.map((week, i) => {
            const x = i * (BAR_W + GAP);
            const isCurrent = week.week_number === currentWeek;
            const isPast = week.week_number < currentWeek;
            const isRace = raceSet.has(week.week_number);
            const baseY = FLAG_H + CHART_H;

            const hasRange =
              week.mileage_target_min != null && week.mileage_target_max != null
              && (week.mileage_target_max - (week.mileage_target_min ?? 0)) > 0.5;

            const midH = toH(week.mileage_target);
            const minH = hasRange ? toH(week.mileage_target_min!) : midH;
            const maxH = hasRange ? toH(week.mileage_target_max!) : midH;
            const tallH = Math.max(midH, maxH);

            const fill = isPast ? "#d1d5db" : isCurrent ? "#111827" : "#818cf8";
            const rangeFill = isPast ? "#e5e7eb" : isCurrent ? "#374151" : "#c7d2fe";
            const rangeOpacity = 0.35;

            const showLabel =
              week.week_number === 1
              || week.week_number % labelEvery === 0
              || week.week_number === n;

            return (
              <g key={week.week_number}>
                {/* Range extension (min → max), lighter */}
                {hasRange && (
                  <rect
                    x={x} y={baseY - maxH}
                    width={BAR_W} height={maxH - minH}
                    fill={rangeFill} opacity={rangeOpacity} rx={1}
                  />
                )}

                {/* Solid base bar (0 → min, or full bar if no range) */}
                <rect
                  x={x} y={baseY - (hasRange ? minH : midH)}
                  width={BAR_W} height={hasRange ? minH : midH}
                  fill={fill} rx={1}
                />

                {/* Current week border outline */}
                {isCurrent && (
                  <rect
                    x={x - 0.5} y={baseY - tallH - 0.5}
                    width={BAR_W + 1} height={tallH + 1}
                    fill="none" stroke="#111827" strokeWidth={1.5} rx={1}
                  />
                )}

                {/* Race marker: dashed stem + red dot */}
                {isRace && (
                  <g>
                    <line
                      x1={x + BAR_W / 2} y1={5}
                      x2={x + BAR_W / 2} y2={baseY - tallH - 2}
                      stroke="#ef4444" strokeWidth={1} strokeDasharray="2,2"
                    />
                    <circle cx={x + BAR_W / 2} cy={9} r={5} fill="#ef4444" />
                    <text
                      x={x + BAR_W / 2} y={12.5}
                      textAnchor="middle" fontSize={6}
                      fill="white" fontFamily="system-ui,sans-serif" fontWeight="700"
                    >
                      R
                    </text>
                  </g>
                )}

                {/* Week number label (sparse) */}
                {showLabel && (
                  <text
                    x={x + BAR_W / 2} y={SVG_H - 1}
                    textAnchor="middle" fontSize={7}
                    fill="#9ca3af" fontFamily="system-ui,sans-serif"
                  >
                    {week.week_number}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend — only shown when plan has ranges or races */}
      {(hasAnyRange || raceWeekNums.length > 0) && (
        <div className="flex items-center gap-4 flex-wrap">
          {hasAnyRange && (
            <>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-3 rounded-sm bg-gray-700" />
                <span className="text-[10px] text-gray-400">min</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-3 rounded-sm bg-gray-400" style={{ opacity: 0.35 }} />
                <span className="text-[10px] text-gray-400">range</span>
              </div>
            </>
          )}
          {raceWeekNums.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-red-500" />
              <span className="text-[10px] text-gray-400">race</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
