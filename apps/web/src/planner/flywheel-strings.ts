import type { PlannerFlywheelMetric } from "@flaremo/contracts";
import { useMemo } from "react";
import { type Locale, useI18n } from "@/i18n";

// The copy of the weekly review's scorecard card (fork-owned add-on,
// docs/fork-flywheel.md), English and Simplified Chinese, like
// goals-strings.ts: only zh-CN has its own wording.

export type PlannerFlywheelStrings = {
  title: string;
  /** A metric's name on the card. */
  metric: Record<PlannerFlywheelMetric, string>;
  /** Under a share with fewer than ten cases. */
  tooFew: (count: number) => string;
  /** "8 of 13". */
  outOf: (num: number, den: number) => string;
  /** "+8 vs last week". */
  delta: (points: number) => string;
  noNumbers: string;
  question: string;
  notePlaceholder: string;
  save: string;
  skip: string;
  edit: string;
  skipped: string;
  proposalTitle: string;
  /** "Aims at: Kept 7 days". */
  aimsAt: (metric: string) => string;
  accept: string;
  dismiss: string;
  verdictTitle: (version: number) => string;
  before: string;
  after: string;
  keep: string;
  rollBack: string;
  suggest: string;
  suggesting: string;
  suggestFailed: string;
  paused: string;
  /** "The agent follows version 3". */
  current: (version: number) => string;
  noCurrent: string;
  failed: string;
};

const en: PlannerFlywheelStrings = {
  title: "The agent this week",
  metric: {
    proposals_seen: "Proposals you saw",
    proposals_accepted: "Accepted",
    kept_7d: "Kept a week",
    proposals_edited: "Edited on the card",
    entries_edited_7d: "Entries edited",
    entry_edit_chars: "Edit size",
    tasks_done_by_due: "Done on time",
    tasks_carried: "Carried over",
    goals_met: "Goals met",
    goals_rewritten: "Goal rewrites",
    memo_rewrite_rate: "Summary rewritten",
    cost_per_kept: "Cost per kept",
  },
  tooFew: (count) => (count === 0 ? "none yet" : `too few (${count})`),
  outOf: (num, den) => `${num} of ${den}`,
  delta: (points) =>
    points === 0
      ? "same as last week"
      : `${points > 0 ? "+" : "−"}${Math.abs(points)} vs last week`,
  noNumbers: "No agent proposals to count yet.",
  question: "What should the agent do differently?",
  notePlaceholder: "One line is enough",
  save: "Save",
  skip: "Skip",
  edit: "Edit",
  skipped: "Skipped this week.",
  proposalTitle: "Proposed change to the agent",
  aimsAt: (metric) => `Aims at: ${metric}`,
  accept: "Accept",
  dismiss: "Dismiss",
  verdictTitle: (version) => `Version ${version}, four weeks on`,
  before: "Before",
  after: "After",
  keep: "Keep",
  rollBack: "Roll back",
  suggest: "Suggest a change to the agent",
  suggesting: "Writing a suggestion…",
  suggestFailed: "No suggestion this time. Try again later.",
  paused:
    "The agent's proposals are paused: you saw almost none of them lately.",
  current: (version) => `The agent follows version ${version}`,
  noCurrent: "No standing instructions yet",
  failed: "That did not save. Try again.",
};

const zhCN: PlannerFlywheelStrings = {
  title: "本周的助手",
  metric: {
    proposals_seen: "看过的提议",
    proposals_accepted: "已接受",
    kept_7d: "保留一周",
    proposals_edited: "在卡片上改过",
    entries_edited_7d: "改过的日记",
    entry_edit_chars: "改动大小",
    tasks_done_by_due: "按时完成",
    tasks_carried: "顺延",
    goals_met: "达成的目标",
    goals_rewritten: "目标重写",
    memo_rewrite_rate: "总结改写",
    cost_per_kept: "每条保留的花费",
  },
  tooFew: (count) => (count === 0 ? "还没有" : `太少（${count}）`),
  outOf: (num, den) => `${den} 中 ${num}`,
  delta: (points) =>
    points === 0
      ? "与上周相同"
      : `比上周${points > 0 ? "+" : "−"}${Math.abs(points)}`,
  noNumbers: "还没有可统计的助手提议。",
  question: "助手应该改变什么做法？",
  notePlaceholder: "一句话就够",
  save: "保存",
  skip: "跳过",
  edit: "编辑",
  skipped: "本周已跳过。",
  proposalTitle: "对助手的修改建议",
  aimsAt: (metric) => `目标指标：${metric}`,
  accept: "接受",
  dismiss: "忽略",
  verdictTitle: (version) => `第 ${version} 版，四周之后`,
  before: "之前",
  after: "之后",
  keep: "保留",
  rollBack: "回退",
  suggest: "建议修改助手",
  suggesting: "正在写建议…",
  suggestFailed: "这次没有建议，请稍后再试。",
  paused: "助手的提议已暂停：最近你几乎没有看到它们。",
  current: (version) => `助手正在使用第 ${version} 版`,
  noCurrent: "还没有长期指示",
  failed: "没有保存成功，请重试。",
};

/** The copy for an app language: Chinese for zh-CN, English otherwise. */
export function plannerFlywheelStringsFor(
  locale: Locale | string,
): PlannerFlywheelStrings {
  return locale === "zh-CN" ? zhCN : en;
}

export function usePlannerFlywheelStrings(): PlannerFlywheelStrings {
  const { locale } = useI18n();
  return useMemo(() => plannerFlywheelStringsFor(locale), [locale]);
}
