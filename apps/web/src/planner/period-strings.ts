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
  dueNow: string;
  notClosing: string;
  lookBackFirst: string;
  openWeekly: string;
  thenLookForward: string;
  done: string;
  savedOn: (day: string) => string;
  startOver: string;
  startOverTitle: string;
  startOverBody: string;
  startOverFailed: string;
  loadFailed: string;
  stepOf: (step: number, total: number) => string;
  from: string;
  yourWords: string;
  yourWordsHint: string;
  add: string;
  askReader: string;
  askReaderHint: string;
  reader: string;
  readerOff: string;
  readerBusy: string;
  stop: string;
  send: string;
  previous: string;
  next: string;
  runChecks: string;
  runningChecks: string;
  checksEmpty: string;
  claims: string;
  leftOut: string;
  holds: string;
  unsupported: string;
  verified: string;
  unsourced: string;
  readTwice: string;
  readingTwice: string;
  agreement: (percent: number) => string;
  bothReaders: string;
  oneReader: string;
  receipts: string;
  receiptsHint: string;
  claim: string;
  quote: string;
  addReceipt: string;
  removeReceipt: string;
  useAsReceipt: string;
  goalsTitle: string;
  childGoals: { quarter: string; year: string };
  noGoals: string;
  tasksLinked: (done: number, linked: number) => string;
  result: { met: string; partial: string; missed: string };
  decision: { keep: string; rephrase: string; kill: string };
  note: string;
  gradeAbove: string;
  questions: string;
  noQuestion: string;
  scoresTitle: string;
  authenticity: string;
  achievement: string;
  mean: string;
  spread: string;
  belowFloor: (count: number) => string;
  notScored: string;
  calendar: string;
  mark: { repeat: string; never: string };
  noEntries: string;
  beliefs: string;
  created: (count: number) => string;
  revised: (count: number) => string;
  verdictTitle: string;
  verdictKinds: { continue: string; pivot: string; pause: string };
  verdictText: string;
  forecastTitle: string;
  forecastHint: string;
  previousForecast: string;
  noPreviousForecast: string;
  grade: { held: string; partly: string; missed: string };
  memoTitle: string;
  writeMemo: string;
  writing: string;
  writeAgain: string;
  memoHint: string;
  rewriteRate: (percent: number) => string;
  save: string;
  saving: string;
  saved: string;
  saveFailed: string;
  savedToast: string;
  modelUnavailable: string;
  modelFailed: string;
  limited: string;
  weeksTable: string;
  week: string;
  entries: string;
  health: string;
  tasks: string;
  goals: string;
  summary: string;
  noSummary: string;
  rungs: string;
  rungsHint: string;
  memories: string;
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
  dueNow: "Closes with this week's review",
  notClosing: "Not closing this week: you can still review it.",
  lookBackFirst: "Do the weekly Look back first: this review reads its result.",
  openWeekly: "Open the weekly review",
  thenLookForward: "Then Look forward, against the new goals",
  done: "Done",
  savedOn: (day) => `Saved ${day}`,
  startOver: "Start over",
  startOverTitle: "Start this review over?",
  startOverBody:
    "Your answers, chats and drafts are cleared and the review starts again. What was saved stays: the memo, the goal results and the receipts. Saving again updates them.",
  startOverFailed: "Could not start over.",
  loadFailed: "The review could not be loaded.",
  stepOf: (step, total) => `Step ${step} of ${total}`,
  from: "Answered from",
  yourWords: "Your words",
  yourWordsHint: "One line per point. These go into the memo as written.",
  add: "Add",
  askReader: "Ask the reader",
  askReaderHint:
    "The reader quotes the rows. It never writes your goals, verdicts or marks.",
  reader: "Reader",
  readerOff: "No model is set up: the reader is off. Your words still go in.",
  readerBusy: "Reading…",
  stop: "Stop",
  send: "Send",
  previous: "Previous",
  next: "Next",
  runChecks: "Check the summaries against the diary",
  runningChecks: "Checking…",
  checksEmpty: "No summaries to check, or nothing came back.",
  claims: "Claims the summaries make",
  leftOut: "What the diary records that no summary mentions",
  holds: "holds",
  unsupported: "unsupported",
  verified: "verified",
  unsourced: "unsourced",
  readTwice: "Read the quarter twice",
  readingTwice: "Two readers reading…",
  agreement: (percent) => `${percent}% agreement`,
  bothReaders: "both readers",
  oneReader: "one reader",
  receipts: "Receipts",
  receiptsHint:
    "A claim and the words it rests on. On save each quote is checked word for word against the entries, health rows and tasks; a quote that is not found is kept as unsourced.",
  claim: "Claim",
  quote: "Quote, word for word",
  addReceipt: "Add receipt",
  removeReceipt: "Remove",
  useAsReceipt: "Use as receipt",
  goalsTitle: "Goals of the period",
  childGoals: {
    quarter: "Month goals in the quarter",
    year: "Quarter goals in the year",
  },
  noGoals: "No goals written for this period.",
  tasksLinked: (done, linked) => `${done} of ${linked} linked tasks done`,
  result: { met: "Met", partial: "Partial", missed: "Missed" },
  decision: { keep: "Keep", rephrase: "Rephrase", kill: "Kill" },
  note: "Note or receipt",
  gradeAbove: "Grade above receipts",
  questions: "The weeks' key questions",
  noQuestion: "no question set",
  scoresTitle: "Scores, week by week",
  authenticity: "Authenticity",
  achievement: "Achievement",
  mean: "Mean",
  spread: "Spread",
  belowFloor: (count) => `${count} under the floor`,
  notScored: "not scored",
  calendar: "The weeks",
  mark: { repeat: "Repeat", never: "Never again" },
  noEntries: "no entries",
  beliefs: "Belief ledger",
  created: (count) => `${count} created`,
  revised: (count) => `${count} revised`,
  verdictTitle: "Verdict",
  verdictKinds: { continue: "Continue", pivot: "Pivot", pause: "Pause" },
  verdictText: "In your words",
  forecastTitle: "Forecast",
  forecastHint:
    "One sentence about the next period. The next review grades it.",
  previousForecast: "Last period's forecast",
  noPreviousForecast: "No forecast was written last period.",
  grade: { held: "Held", partly: "Partly", missed: "Missed" },
  memoTitle: "The memo",
  writeMemo: "Write the memo",
  writing: "Writing…",
  writeAgain: "Write again",
  memoHint:
    "Drafted from your words and the rows. Edit it: what you save is what is kept, and the share you rewrote is recorded.",
  rewriteRate: (percent) => `${percent}% rewritten`,
  save: "Save the review",
  saving: "Saving…",
  saved: "Saved",
  saveFailed: "The review could not be saved.",
  savedToast: "Review saved.",
  modelUnavailable: "The model is not available right now.",
  modelFailed: "The model did not answer.",
  limited: "Too many requests. Try again in a moment.",
  weeksTable: "Weeks",
  week: "Week",
  entries: "Entries",
  health: "Health",
  tasks: "Done",
  goals: "Goals",
  summary: "Summary",
  noSummary: "no summary",
  rungs: "Raw rows this review reads",
  rungsHint:
    "Entries, health rows, tasks done and week records are evidence. Summaries and memories are claims to test.",
  memories: "Memories",
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
  dueNow: "随本周复盘一起结束",
  notClosing: "本周未结束：仍可复盘。",
  lookBackFirst: "先完成每周回顾：本复盘读取它的结果。",
  openWeekly: "打开每周复盘",
  thenLookForward: "然后展望，对照新的目标",
  done: "已完成",
  savedOn: (day) => `已保存 ${day}`,
  startOver: "重新开始",
  startOverTitle: "重新开始这次复盘？",
  startOverBody:
    "你的回答、对话和草稿会被清空。已保存的内容会保留：笔记、目标结果和凭据。再次保存会更新它们。",
  startOverFailed: "无法重新开始。",
  loadFailed: "复盘加载失败。",
  stepOf: (step, total) => `第 ${step} 步，共 ${total} 步`,
  from: "依据",
  yourWords: "你的话",
  yourWordsHint: "每行一点。原样写入笔记。",
  add: "添加",
  askReader: "问读者",
  askReaderHint: "读者引用原始记录，从不替你写目标、结论或标记。",
  reader: "读者",
  readerOff: "未配置模型：读者关闭。你的话仍会写入。",
  readerBusy: "阅读中…",
  stop: "停止",
  send: "发送",
  previous: "上一步",
  next: "下一步",
  runChecks: "用日记核对总结",
  runningChecks: "核对中…",
  checksEmpty: "没有可核对的总结，或没有返回。",
  claims: "总结中的说法",
  leftOut: "日记记录了而总结没提到的",
  holds: "成立",
  unsupported: "无依据",
  verified: "已核实",
  unsourced: "无来源",
  readTwice: "读两遍这个季度",
  readingTwice: "两位读者阅读中…",
  agreement: (percent) => `一致率 ${percent}%`,
  bothReaders: "两位读者",
  oneReader: "一位读者",
  receipts: "凭据",
  receiptsHint:
    "一个说法和它所依据的原话。保存时逐字核对日记、健康记录和任务；找不到的保留为无来源。",
  claim: "说法",
  quote: "原话，逐字",
  addReceipt: "添加凭据",
  removeReceipt: "移除",
  useAsReceipt: "用作凭据",
  goalsTitle: "本阶段目标",
  childGoals: { quarter: "季度内的月目标", year: "年内的季度目标" },
  noGoals: "本阶段没有写目标。",
  tasksLinked: (done, linked) => `关联任务 ${linked} 个，完成 ${done} 个`,
  result: { met: "达成", partial: "部分", missed: "未达成" },
  decision: { keep: "保留", rephrase: "改写", kill: "放弃" },
  note: "备注或凭据",
  gradeAbove: "评分高于凭据",
  questions: "各周的关键问题",
  noQuestion: "未设问题",
  scoresTitle: "逐周评分",
  authenticity: "真实",
  achievement: "成就",
  mean: "均值",
  spread: "波动",
  belowFloor: (count) => `${count} 周低于底线`,
  notScored: "未评分",
  calendar: "各周",
  mark: { repeat: "重复", never: "不再" },
  noEntries: "无记录",
  beliefs: "信念账",
  created: (count) => `新建 ${count}`,
  revised: (count) => `修订 ${count}`,
  verdictTitle: "结论",
  verdictKinds: { continue: "继续", pivot: "转向", pause: "暂停" },
  verdictText: "用你的话",
  forecastTitle: "预测",
  forecastHint: "关于下个阶段的一句话。下次复盘给它打分。",
  previousForecast: "上个阶段的预测",
  noPreviousForecast: "上个阶段没有写预测。",
  grade: { held: "成立", partly: "部分", missed: "落空" },
  memoTitle: "笔记",
  writeMemo: "写笔记",
  writing: "写作中…",
  writeAgain: "重写",
  memoHint:
    "根据你的话和原始记录起草。请编辑：保存的才算数，改写比例会被记录。",
  rewriteRate: (percent) => `改写 ${percent}%`,
  save: "保存复盘",
  saving: "保存中…",
  saved: "已保存",
  saveFailed: "复盘保存失败。",
  savedToast: "复盘已保存。",
  modelUnavailable: "模型暂不可用。",
  modelFailed: "模型没有回答。",
  limited: "请求过多，稍后再试。",
  weeksTable: "各周",
  week: "周",
  entries: "日记",
  health: "健康",
  tasks: "完成",
  goals: "目标",
  summary: "总结",
  noSummary: "无总结",
  rungs: "本复盘读取的原始记录",
  rungsHint:
    "日记、健康记录、完成的任务和周记录是证据。总结和记忆是待检验的说法。",
  memories: "记忆",
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
