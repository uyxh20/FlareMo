import { useMemo } from "react";
import { type Locale, useI18n } from "@/i18n";
import {
  plannerReviewNavLabelEn,
  plannerReviewNavLabelZhCN,
} from "./nav-label";

// The copy of the month, quarter and year reviews, English and Simplified
// Chinese (fork-owned add-on, docs/planning-cockpit-period-review.md). It
// follows goals-strings.ts: only zh-CN has its own wording. The steps, their
// questions and the memo are the owner's own method, word for word, so they
// stay in English and come from @flaremo/contracts.

export type PlannerPeriodStrings = {
  title: string;
  levels: { month: string; quarter: string; year: string };
  weeks: (count: number) => string;
  done: string;
  startOver: string;
  startOverTitle: string;
  startOverBody: string;
  startOverFailed: string;
  loadFailed: string;
  stepOf: (step: number, total: number) => string;
  from: string;
  add: string;
  reader: string;
  stop: string;
  send: string;
  previous: string;
  next: string;
  holds: string;
  receipts: string;
  claim: string;
  quote: string;
  noGoals: string;
  result: { met: string; partial: string; missed: string };
  decision: { keep: string; rephrase: string; kill: string };
  note: string;
  questions: string;
  scoresTitle: string;
  authenticity: string;
  achievement: string;
  mean: string;
  notScored: string;
  calendar: string;
  mark: { repeat: string; never: string };
  created: (count: number) => string;
  verdictTitle: string;
  grade: { held: string; partly: string; missed: string };
  memoTitle: string;
  writeMemo: string;
  writing: string;
  writeAgain: string;
  save: string;
  saving: string;
  saved: string;
  saveFailed: string;
  savedToast: string;
  limited: string;
  week: string;
  entries: string;
  health: string;
  tasks: string;
  goals: string;
  summary: string;
  /** The month and quarter chat (period-chat.tsx): the weekly chat's words for a period. */
  chat: {
    reads: string;
    entries: (count: number) => string;
    memos: (count: number) => string;
    healthRows: (count: number) => string;
    tasksDone: (count: number) => string;
    goals: (count: number) => string;
    happened: (label: string) => string;
    dropped: (count: number) => string;
    nothingBacked: string;
    sources: { memo: string; health: string; task_event: string; week: string };
    fallbackRecap: (goals: number, word: string) => string;
    start: (word: string) => string;
    drafting: (word: string) => string;
    draftingAgent: (word: string) => string;
    scoring: (word: string) => string;
    lastQuestion: (word: string) => string;
    goalsOf: (label: string) => string;
    goalsItem: (word: string) => string;
    nextQuestion: (word: string) => string;
    nextQuestionItem: (word: string) => string;
    summaryTitle: string;
    writeSummary: string;
    openSummary: string;
    toLookForward: string;
    memoTitle: (name: string) => string;
    memoLabel: (name: string) => string;
    savedToast: string;
  };
};

const en: PlannerPeriodStrings = {
  title: plannerReviewNavLabelEn,
  levels: { month: "Month", quarter: "Quarter", year: "Year" },
  weeks: (count) => `${count} weeks`,
  done: "Done",
  startOver: "Start over",
  startOverTitle: "Start this review over?",
  startOverBody:
    "Your answers, chats and drafts are cleared and the review starts again. What was saved stays: the memo, the goal results and the receipts. Saving again updates them.",
  startOverFailed: "Could not start over.",
  loadFailed: "The review could not be loaded.",
  stepOf: (step, total) => `Step ${step} of ${total}`,
  from: "Answered from",
  add: "Add",
  reader: "Reader",
  stop: "Stop",
  send: "Send",
  previous: "Previous",
  next: "Next",
  holds: "holds",
  receipts: "Receipts",
  claim: "Claim",
  quote: "Quote, word for word",
  noGoals: "No goals written for this period.",
  result: { met: "Met", partial: "Partial", missed: "Missed" },
  decision: { keep: "Keep", rephrase: "Rephrase", kill: "Kill" },
  note: "Note or receipt",
  questions: "The weeks' key questions",
  scoresTitle: "Scores, week by week",
  authenticity: "Authenticity",
  achievement: "Achievement",
  mean: "Mean",
  notScored: "not scored",
  calendar: "The weeks",
  mark: { repeat: "Repeat", never: "Never again" },
  created: (count) => `${count} created`,
  verdictTitle: "Verdict",
  grade: { held: "Held", partly: "Partly", missed: "Missed" },
  memoTitle: "The memo",
  writeMemo: "Write the memo",
  writing: "Writing…",
  writeAgain: "Write again",
  save: "Save the review",
  saving: "Saving…",
  saved: "Saved",
  saveFailed: "The review could not be saved.",
  savedToast: "Review saved.",
  limited: "Too many requests. Try again in a moment.",
  week: "Week",
  entries: "Entries",
  health: "Health",
  tasks: "Done",
  goals: "Goals",
  summary: "Summary",
  chat: {
    reads: "What this review reads",
    entries: (count) => `${count} diary ${count === 1 ? "entry" : "entries"}`,
    memos: (count) => `${count} weekly ${count === 1 ? "memo" : "memos"}`,
    healthRows: (count) => `${count} health ${count === 1 ? "row" : "rows"}`,
    tasksDone: (count) => `${count} ${count === 1 ? "task" : "tasks"} done`,
    goals: (count) => `${count} ${count === 1 ? "goal" : "goals"}`,
    happened: (label) => `What happened in ${label}`,
    dropped: (count) =>
      `Left out ${count} ${count === 1 ? "claim" : "claims"} it couldn't back with your own words.`,
    nothingBacked: "Nothing it said could be backed with your own words.",
    sources: {
      memo: "entry",
      health: "health log",
      task_event: "task",
      week: "week record",
    },
    fallbackRecap: (goals, word) =>
      goals === 0
        ? `No ${word} goals were set.`
        : `${goals} ${word} ${goals === 1 ? "goal" : "goals"} to look back on.`,
    start: (word) => `Start the ${word} review`,
    drafting: (word) => `Reading your ${word}`,
    draftingAgent: (word) =>
      `Reading your whole ${word} · this takes a few minutes`,
    scoring: (word) => `Scoring your ${word}`,
    lastQuestion: (word) => `Last ${word}'s question`,
    goalsOf: (label) => `${label} goals`,
    goalsItem: (word) => `The ${word}'s goals`,
    nextQuestion: (word) => `Question for next ${word}'s review`,
    nextQuestionItem: (word) => `Next ${word}'s question`,
    summaryTitle: "Review memo",
    writeSummary: "Write the review",
    openSummary: "Open the review",
    toLookForward: "Weekly Look forward →",
    memoTitle: (name) => `${name} review`,
    memoLabel: (name) => `${name} review memo`,
    savedToast: "Review saved to your memos",
  },
};

const zhCN: PlannerPeriodStrings = {
  ...en,
  title: plannerReviewNavLabelZhCN,
  levels: { month: "月", quarter: "季度", year: "年" },
  weeks: (count) => `${count} 周`,
  done: "已完成",
  startOver: "重新开始",
  startOverTitle: "重新开始这次复盘？",
  startOverBody:
    "你的回答、对话和草稿会被清空。已保存的内容会保留：笔记、目标结果和凭据。再次保存会更新它们。",
  startOverFailed: "无法重新开始。",
  loadFailed: "复盘加载失败。",
  stepOf: (step, total) => `第 ${step} 步，共 ${total} 步`,
  from: "依据",
  add: "添加",
  reader: "读者",
  stop: "停止",
  send: "发送",
  previous: "上一步",
  next: "下一步",
  holds: "成立",
  receipts: "凭据",
  claim: "说法",
  quote: "原话，逐字",
  noGoals: "本阶段没有写目标。",
  result: { met: "达成", partial: "部分", missed: "未达成" },
  decision: { keep: "保留", rephrase: "改写", kill: "放弃" },
  note: "备注或凭据",
  questions: "各周的关键问题",
  scoresTitle: "逐周评分",
  authenticity: "真实",
  achievement: "成就",
  mean: "均值",
  notScored: "未评分",
  calendar: "各周",
  mark: { repeat: "重复", never: "不再" },
  created: (count) => `新建 ${count}`,
  verdictTitle: "结论",
  grade: { held: "成立", partly: "部分", missed: "落空" },
  memoTitle: "笔记",
  writeMemo: "写笔记",
  writing: "写作中…",
  writeAgain: "重写",
  save: "保存复盘",
  saving: "保存中…",
  saved: "已保存",
  saveFailed: "复盘保存失败。",
  savedToast: "复盘已保存。",
  limited: "请求过多，稍后再试。",
  week: "周",
  entries: "日记",
  health: "健康",
  tasks: "完成",
  goals: "目标",
  summary: "总结",
  chat: {
    ...en.chat,
    reads: "本复盘读取",
    entries: (count) => `${count} 篇日记`,
    memos: (count) => `${count} 份周总结`,
    healthRows: (count) => `${count} 条健康记录`,
    tasksDone: (count) => `完成 ${count} 项任务`,
    goals: (count) => `${count} 个目标`,
    happened: (label) => `${label}发生了什么`,
    dropped: (count) => `略去 ${count} 条无法用你自己的话佐证的说法。`,
    nothingBacked: "没有能用你自己的话佐证的说法。",
    sources: {
      memo: "日记",
      health: "健康记录",
      task_event: "任务",
      week: "周记录",
    },
    summaryTitle: "复盘备忘",
    writeSummary: "写复盘",
    openSummary: "打开复盘",
    toLookForward: "周复盘 · 展望 →",
    savedToast: "复盘已保存到备忘录",
  },
};

export function plannerPeriodStringsFor(locale: Locale): PlannerPeriodStrings {
  return locale === "zh-CN" ? zhCN : en;
}

export function usePlannerPeriodStrings(): PlannerPeriodStrings {
  const { locale } = useI18n();
  return useMemo(() => plannerPeriodStringsFor(locale), [locale]);
}
