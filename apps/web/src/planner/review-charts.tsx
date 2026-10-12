import {
  type PlannerReviewResponse,
  plannerScoreFloors,
} from "@flaremo/contracts";
import { useState } from "react";
import {
  plannerScoreText,
  plannerWeekNumber,
  plannerWeekRange,
} from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";

// The two score charts in the weekly review's side panel (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): Authenticity and Achievement over the
// 19 weeks that end with the week looked back on, each with its yearly floor as
// a dashed line. A filled point met its floor, a hollow one did not; a gap is a
// week that was not scored. Hovering a week shows its numbers.

const W = 328;
const H = 112;
const LEFT = 18;
const RIGHT = 28;
const TOP = 24;
const BOTTOM = 18;

type Weeks = PlannerReviewResponse["scores"];

export function PlannerScoreChart({
  kind,
  weeks,
  strings,
}: {
  kind: "auth" | "ach";
  weeks: Weeks;
  strings: PlannerGoalsStrings;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const name =
    kind === "auth" ? strings.goals.authenticity : strings.goals.achievement;
  const floor = plannerScoreFloors[kind];
  const values = weeks.map((week) => week[kind]);
  const scored = values.filter((value): value is number => value !== null);
  const low = Math.min(2, ...scored.map((value) => Math.floor(value)));
  const count = weeks.length;
  const step = count > 1 ? (W - LEFT - RIGHT) / (count - 1) : 0;
  const x = (index: number) => LEFT + index * step;
  const y = (value: number) =>
    TOP + ((5 - value) / (5 - low)) * (H - TOP - BOTTOM);

  let path = "";
  let pen = false;
  values.forEach((value, index) => {
    if (value === null) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    pen = true;
  });
  const lastIndex = values.findLastIndex((value) => value !== null);
  const lastValue = lastIndex >= 0 ? values[lastIndex] : null;
  const grid = Array.from({ length: 5 - low + 1 }, (_, index) => low + index);
  const code = (index: number) => {
    const week = weeks[index];
    return week ? strings.weekCode(plannerWeekNumber(week.week_start)) : "";
  };
  const floorText = plannerScoreText(floor);
  const hovered = hover !== null ? weeks[hover] : undefined;
  const hoveredValue = hover !== null ? values[hover] : null;

  return (
    <div className="relative">
      <svg
        aria-label={strings.review.chartLabel(
          name,
          code(0),
          code(count - 1),
          floorText,
        )}
        className="planner-mini block h-auto w-full overflow-visible"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setHover(null)}
      >
        <text className="planner-mini-title" x={0} y={11}>
          {name}
        </text>
        <text textAnchor="end" x={W} y={11}>
          {strings.goals.floor(floorText)}
        </text>
        {grid.map((value) => (
          <g key={value}>
            <line
              className="planner-mini-grid"
              x1={LEFT}
              x2={W - RIGHT}
              y1={y(value)}
              y2={y(value)}
            />
            <text textAnchor="end" x={LEFT - 6} y={y(value) + 4}>
              {value}
            </text>
          </g>
        ))}
        <line
          className="planner-mini-floor"
          x1={LEFT}
          x2={W - RIGHT}
          y1={y(floor)}
          y2={y(floor)}
        />
        {hover !== null && (
          <line
            className="planner-mini-grid"
            x1={x(hover)}
            x2={x(hover)}
            y1={TOP - 6}
            y2={H - BOTTOM + 4}
          />
        )}
        <path className="planner-mini-line" d={path} />
        {values.map((value, index) =>
          value === null ? null : (
            <circle
              className="planner-mini-point"
              cx={x(index)}
              cy={y(value)}
              data-on={value >= floor ? "" : undefined}
              // biome-ignore lint/suspicious/noArrayIndexKey: one point per week, in order
              key={index}
              r={hover === index ? 4.5 : 3.5}
            />
          ),
        )}
        {lastValue !== null && lastValue !== undefined && (
          <text
            className="planner-mini-last"
            x={x(lastIndex) + 7}
            y={y(lastValue) + 4}
          >
            {plannerScoreText(lastValue)}
          </text>
        )}
        <text x={LEFT} y={H - 2}>
          {code(0)}
        </text>
        <text textAnchor="end" x={W - RIGHT} y={H - 2}>
          {code(count - 1)}
        </text>
        {weeks.map((week, index) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: a hover target for the tooltip; the chart's label carries the data
          <rect
            className="planner-mini-hit"
            height={H - TOP - BOTTOM + 12}
            key={week.week_start}
            width={Math.max(step, 8)}
            x={x(index) - Math.max(step, 8) / 2}
            y={TOP - 6}
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2.5 py-1.5 text-xs whitespace-pre-line text-background shadow-md tabular-nums"
          role="status"
          style={{ left: `${(x(hover) / W) * 100}%` }}
        >
          {`${code(hover)} · ${plannerWeekRange(hovered.week_start, strings)}\n${
            hoveredValue === null || hoveredValue === undefined
              ? strings.goals.notScored
              : `${name} ${plannerScoreText(hoveredValue)}`
          }`}
        </div>
      )}
    </div>
  );
}
