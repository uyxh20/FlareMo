// The planning cockpit's domain layer: a fork-owned add-on
// (docs/planning-cockpit-implementation-plan.md).
//
// The Worker deep-imports this barrel, `@flaremo/domain/src/planner`; it is
// deliberately NOT re-exported from `packages/domain/src/index.ts`, so the
// planner stays out of the startup graph and upstream's barrel stays untouched.
// Every export is prefixed planner/Planner (M8).
//
// Task rows change only through upstream's domain services (M1); this layer
// writes planner tables only, and reads `tasks`, `task_activity` and `projects`.

export * from "./board";
export * from "./board-rank";
export * from "./columns";
export * from "./comments";
export * from "./history-read";
export * from "./history-sync";
export * from "./plans";
export * from "./rollover";
export type {
  PlannerActor,
  PlannerBatchResult,
  PlannerEventType,
  PlannerHistoryStatus,
} from "./shared";
export * from "./task-detail";
export * from "./tree";
