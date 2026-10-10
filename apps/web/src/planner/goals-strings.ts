import type {
  PlannerGoalResult,
  PlannerGoalStatus,
  PlannerPillar,
  PlannerVerdictKind,
} from "@flaremo/contracts";
import { useMemo } from "react";
import { type Locale, useI18n } from "@/i18n";
import {
  plannerGoalsNavLabelEn,
  plannerGoalsNavLabelZhCN,
  plannerReviewNavLabelEn,
  plannerReviewNavLabelZhCN,
} from "./nav-label";

// The copy of the goal cards, the Goals page and the weekly review, English and
// Simplified Chinese (fork-owned add-on, docs/planning-cockpit-goals-review.md).
// It follows strings.ts: only zh-CN has its own wording and every other app
// language reads the English. The seven reflection prompts and the scoring rubric
// are the owner's own method, word for word, so they stay in English and come
// from @flaremo/contracts instead of from here; so does the summary memo, which
// sits next to the owner's past summaries.

/** A day of the year as two numbers: `month` 0 to 11, `day` 1 to 31. */
export type PlannerMonthDay = { month: number; day: number };

export type PlannerGoalsStrings = {
  intlLocale: string;

  /** The four objectives: the full name, and a short one for narrow places. */
  pillar: Record<PlannerPillar, string>;
  pillarShort: Record<PlannerPillar, string>;
  /** A goal with no objective. */
  noPillar: string;
  /** Short month names, January first. */
  months: readonly string[];
  /** Full month names, January first. */
  monthsLong: readonly string[];
  /** "5 – 11 Oct", or "28 Sep – 4 Oct" across two months. */
  range: (from: PlannerMonthDay, to: PlannerMonthDay) => string;
  /** "Week 41". */
  week: (number: number) => string;
  /** "W41", the short form. */
  weekCode: (number: number) => string;
  result: Record<PlannerGoalResult, string>;
  status: Record<PlannerGoalStatus, string>;
  verdict: Record<PlannerVerdictKind, string>;

  cockpit: {
    /** The row of goal cards. */
    goals: string;
    noGoal: string;
    noTasks: string;
    /** "Work · weekly goal" on a linked task; the word after the objective. */
    weeklyGoal: string;
    /** Above the goal cards: "Week 42 · 12 – 18 Oct". */
    weekLine: (week: string, range: string) => string;
  };

  goals: {
    title: string;
    year: (year: number) => string;
    quarter: (quarter: number) => string;
    breadcrumb: string;
    northStar: string;
    noNorthStar: string;
    authenticity: string;
    achievement: string;
    gap: string;
    weeksOnTarget: string;
    /** "floor 4.0" next to an average. */
    floor: (value: string) => string;
    weeks: string;
    months: string;
    yearGoals: string;
    quarterGoals: string;
    monthGoals: string;
    weeklyGoals: string;
    legend: string;
    onTarget: string;
    below: string;
    notScored: string;
    notYet: string;
    thisWeek: string;
    /** "Auth 4.0 · Ach 3.5". */
    scores: (auth: string, ach: string) => string;
    goalCount: (count: number) => string;
    noGoalsSet: string;
    noGoal: string;
    summary: string;
    loadFailed: string;
  };

  editor: {
    newTitle: string;
    editTitle: string;
    add: string;
    edit: (name: string) => string;
    titleLabel: string;
    titlePlaceholder: string;
    lines: string;
    addLine: string;
    lineText: string;
    lineNote: string;
    struck: string;
    removeLine: string;
    objective: string;
    statusLabel: string;
    resultLabel: string;
    noResult: string;
    note: string;
    notePlaceholder: string;
    save: string;
    delete: string;
    deleteConfirm: string;
    saved: string;
    deleted: string;
    saveFailed: string;
    needsText: string;
  };

  review: {
    title: string;
    lookBack: string;
    lookForward: string;
    parts: string;
    toDo: string;
    inProgress: string;
    done: string;
    saved: string;
    stepOf: (step: number, total: number) => string;
    loadFailed: string;

    start: string;
    drafting: string;
    scoring: string;
    thinking: string;
    answer: string;
    answerPlaceholder: string;
    send: string;
    next: string;
    skip: string;
    lastQuestion: string;
    lastGoals: string;
    /** "3 / 7" above a prompt. */
    promptOf: (index: number, total: number) => string;
    scoresTitle: string;
    keepScores: string;
    lower: (name: string) => string;
    raise: (name: string) => string;
    trajectory: string;
    pattern: string;
    risk: string;
    opportunity: string;
    nextQuestion: string;
    verdictTitle: string;
    summaryTitle: string;
    writeSummary: string;
    openSummary: string;
    toLookForward: string;
    noModel: string;
    modelDown: string;
    modelLimited: string;
    noReply: string;

    panelChecklist: string;
    /** "Scores · W23 – W41". */
    chartsTitle: (from: string, to: string) => string;
    chartLabel: (
      name: string,
      from: string,
      to: string,
      floor: string,
    ) => string;
    lastQuestionItem: string;
    lastGoalsItem: string;
    scoresItem: string;
    nextQuestionItem: string;
    verdictItem: string;

    memo: {
      title: (week: string) => string;
      template: string;
      stopped: string;
      stop: string;
      writeAgain: string;
      copy: string;
      copied: string;
      copyBlocked: string;
      close: string;
      writing: string;
      diary: (range: string) => string;
      stoppedToast: string;
      templateToast: string;
      stoppedTemplateToast: string;
      saving: string;
      savedToast: string;
      saveFailed: string;
      retry: string;
      label: (week: string) => string;
    };

    forward: {
      steps: readonly [string, string, string, string];
      open: (count: number) => string;
      settled: string;
      clash: string;
      noClashes: string;
      kept: string;
      rewritten: string;
      rewrite: string;
      keep: string;
      undo: string;
      now: string;
      save: string;
      cancel: string;
      fromSummary: (week: string) => string;
      addGoal: string;
      removeGoal: string;
      goalFor: (pillar: string) => string;
      goalPlaceholder: string;
      todo: string;
      inTodo: string;
      toBacklog: string;
      newTask: string;
      newTaskFor: (pillar: string) => string;
      add: string;
      fromBoard: string;
      fromBoardFor: (pillar: string) => string;
      backlog: string;
      noTasks: string;
      noGoals: string;
      removeTask: string;
      source: {
        new: string;
        todo: string;
        backlog: string;
        doing: string;
        done: string;
      };
      check: string;
      checking: string;
      noFlags: string;
      noCheck: string;
      checkFailed: string;
      model: string;
      saveWeek: string;
      saving: string;
      savedToast: (week: string) => string;
      saveFailed: string;
      backTo: (step: string) => string;
      nextTo: (step: string) => string;
      lookBack: string;
    };
  };
};

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const EN_MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const en: PlannerGoalsStrings = {
  intlLocale: "en-US",
  pillar: {
    of: "Objective Function",
    work: "Work",
    ai: "AI Chops",
    health: "Health",
  },
  pillarShort: {
    of: "Objective",
    work: "Work",
    ai: "AI Chops",
    health: "Health",
  },
  noPillar: "Other",
  months: EN_MONTHS,
  monthsLong: EN_MONTHS_LONG,
  range: (from, to) =>
    from.month === to.month
      ? `${from.day} – ${to.day} ${EN_MONTHS[to.month]}`
      : `${from.day} ${EN_MONTHS[from.month]} – ${to.day} ${EN_MONTHS[to.month]}`,
  week: (number) => `Week ${number}`,
  weekCode: (number) => `W${number}`,
  result: { met: "Met", partial: "Partly", missed: "Missed" },
  status: {
    active: "Active",
    draft: "Draft",
    contested: "Contested",
    closed: "Closed",
  },
  verdict: { continue: "Continue", pivot: "Pivot", pause: "Pause" },

  cockpit: {
    goals: "Weekly goals",
    noGoal: "No goal this week",
    noTasks: "No tasks",
    weeklyGoal: "weekly goal",
    weekLine: (week, range) => `${week} · ${range}`,
  },

  goals: {
    title: plannerGoalsNavLabelEn,
    year: (year) => String(year),
    quarter: (quarter) => `Q${quarter}`,
    breadcrumb: "Breadcrumb",
    northStar: "North star",
    noNorthStar: "No north star yet",
    authenticity: "Authenticity",
    achievement: "Achievement",
    gap: "Gap",
    weeksOnTarget: "Weeks on target",
    floor: (value) => `floor ${value}`,
    weeks: "Weeks",
    months: "Months",
    yearGoals: "Year goals",
    quarterGoals: "Quarter goals",
    monthGoals: "Month goals",
    weeklyGoals: "Weekly goals",
    legend: "Legend",
    onTarget: "On target",
    below: "Below",
    notScored: "Not scored",
    notYet: "Not yet",
    thisWeek: "This week",
    scores: (auth, ach) => `Auth ${auth} · Ach ${ach}`,
    goalCount: (count) => (count === 1 ? "1 goal" : `${count} goals`),
    noGoalsSet: "No goals set",
    noGoal: "No goal",
    summary: "Summary",
    loadFailed: "Couldn't load the goals.",
  },

  editor: {
    newTitle: "New goal",
    editTitle: "Edit goal",
    add: "Add",
    edit: (name) => `Edit ${name}`,
    titleLabel: "Goal",
    titlePlaceholder: "What this goal is",
    lines: "Points",
    addLine: "Add a point",
    lineText: "Point",
    lineNote: "Short note",
    struck: "Struck through",
    removeLine: "Remove this point",
    objective: "Objective",
    statusLabel: "Status",
    resultLabel: "Result",
    noResult: "Not recorded",
    note: "Note",
    notePlaceholder: "Why it is contested, or the evidence for its result",
    save: "Save",
    delete: "Delete",
    deleteConfirm: "Delete this goal?",
    saved: "Goal saved",
    deleted: "Goal deleted",
    saveFailed: "Couldn't save the goal",
    needsText: "Write the goal or at least one point.",
  },

  review: {
    title: plannerReviewNavLabelEn,
    lookBack: "Look back",
    lookForward: "Look forward",
    parts: "Review parts",
    toDo: "To do",
    inProgress: "In progress",
    done: "Done",
    saved: "Saved",
    stepOf: (step, total) => `Step ${step} of ${total}`,
    loadFailed: "Couldn't load the review.",

    start: "Start Look back",
    drafting: "Drafting from your week",
    scoring: "Scoring your week",
    thinking: "Thinking",
    answer: "Your answer",
    answerPlaceholder: "Write your answer",
    send: "Send",
    next: "Next ›",
    skip: "Skip ›",
    lastQuestion: "Last week's question",
    lastGoals: "Last week's goals",
    promptOf: (index, total) => `${index} / ${total}`,
    scoresTitle: "Scores",
    keepScores: "Keep scores",
    lower: (name) => `Lower ${name}`,
    raise: (name) => `Raise ${name}`,
    trajectory: "Trajectory",
    pattern: "Pattern",
    risk: "Risk",
    opportunity: "Opportunity",
    nextQuestion: "Question for next Sunday",
    verdictTitle: "Verdict",
    summaryTitle: "Summary",
    writeSummary: "Write summary",
    openSummary: "Open summary",
    toLookForward: "Look forward →",
    noModel: "No model connected",
    modelDown: "Model unavailable · page drafts",
    modelLimited: "The model hit a limit",
    noReply: "No reply from the model",

    panelChecklist: "Review",
    chartsTitle: (from, to) => `Scores · ${from} – ${to}`,
    chartLabel: (name, from, to, floor) =>
      `${name} by week, ${from} to ${to}, floor ${floor}`,
    lastQuestionItem: "Last week's question",
    lastGoalsItem: "Last week's goals",
    scoresItem: "Scores",
    nextQuestionItem: "Next Sunday's question",
    verdictItem: "Verdict",

    memo: {
      title: (week) => `${week} summary`,
      template: "template",
      stopped: "stopped",
      stop: "Stop",
      writeAgain: "Write again",
      copy: "Copy markdown",
      copied: "Copied",
      copyBlocked: "Copy is blocked here",
      close: "Close",
      writing: "Writing",
      diary: (range) => `Diary entries · ${range}`,
      stoppedToast: "Stopped",
      templateToast: "The model didn't finish · template used",
      stoppedTemplateToast: "Stopped · template used",
      saving: "Saving the summary",
      savedToast: "Summary saved to your memos",
      saveFailed: "Couldn't save the summary",
      retry: "Try again",
      label: (week) => `${week} summary memo`,
    },

    forward: {
      steps: ["Check goals", "Choose the week", "Plan tasks", "Commit"],
      open: (count) => `${count} open`,
      settled: "Settled",
      clash: "Clash",
      noClashes: "No open clashes",
      kept: "Kept for now",
      rewritten: "Rewritten",
      rewrite: "Rewrite",
      keep: "Keep for now",
      undo: "Undo",
      now: "Now",
      save: "Save",
      cancel: "Cancel",
      fromSummary: (week) => `From ${week} summary`,
      addGoal: "+ Add a goal",
      removeGoal: "Remove this goal",
      goalFor: (pillar) => `${pillar} goal`,
      goalPlaceholder: "One goal for the week",
      todo: "To Do",
      inTodo: "In To Do",
      toBacklog: "To Backlog",
      newTask: "New task",
      newTaskFor: (pillar) => `New task for ${pillar}`,
      add: "Add",
      fromBoard: "From the board…",
      fromBoardFor: (pillar) => `Add a task from the board for ${pillar}`,
      backlog: "Backlog",
      noTasks: "No tasks",
      noGoals: "No goals this week",
      removeTask: "Remove task",
      source: {
        new: "New",
        todo: "From To Do",
        backlog: "From Backlog",
        doing: "Doing",
        done: "Done",
      },
      check: "Conflict check",
      checking: "Checking",
      noFlags: "No clashes found",
      noCheck: "No model to check with",
      checkFailed: "The check didn't run",
      model: "Model",
      saveWeek: "Save week",
      saving: "Saving",
      savedToast: (week) => `${week} saved`,
      saveFailed: "Couldn't save the week",
      backTo: (step) => `← ${step}`,
      nextTo: (step) => `${step} →`,
      lookBack: "← Look back",
    },
  },
};

const zhCN: PlannerGoalsStrings = {
  intlLocale: "zh-CN",
  pillar: {
    of: "目标函数",
    work: "工作",
    ai: "AI 能力",
    health: "健康",
  },
  pillarShort: { of: "目标函数", work: "工作", ai: "AI", health: "健康" },
  noPillar: "其他",
  months: [
    "1月",
    "2月",
    "3月",
    "4月",
    "5月",
    "6月",
    "7月",
    "8月",
    "9月",
    "10月",
    "11月",
    "12月",
  ],
  monthsLong: [
    "一月",
    "二月",
    "三月",
    "四月",
    "五月",
    "六月",
    "七月",
    "八月",
    "九月",
    "十月",
    "十一月",
    "十二月",
  ],
  range: (from, to) =>
    from.month === to.month
      ? `${from.month + 1}月${from.day}日 – ${to.day}日`
      : `${from.month + 1}月${from.day}日 – ${to.month + 1}月${to.day}日`,
  week: (number) => `第 ${number} 周`,
  weekCode: (number) => `W${number}`,
  result: { met: "达成", partial: "部分达成", missed: "未达成" },
  status: {
    active: "进行中",
    draft: "草稿",
    contested: "有争议",
    closed: "已结束",
  },
  verdict: { continue: "继续", pivot: "转向", pause: "暂停" },

  cockpit: {
    goals: "本周目标",
    noGoal: "本周没有目标",
    noTasks: "没有任务",
    weeklyGoal: "本周目标",
    weekLine: (week, range) => `${week} · ${range}`,
  },

  goals: {
    title: plannerGoalsNavLabelZhCN,
    year: (year) => `${year} 年`,
    quarter: (quarter) => `Q${quarter}`,
    breadcrumb: "导航路径",
    northStar: "北极星",
    noNorthStar: "还没有北极星",
    authenticity: "真实度",
    achievement: "达成度",
    gap: "差距",
    weeksOnTarget: "达标周数",
    floor: (value) => `底线 ${value}`,
    weeks: "各周",
    months: "各月",
    yearGoals: "年度目标",
    quarterGoals: "季度目标",
    monthGoals: "月度目标",
    weeklyGoals: "本周目标",
    legend: "图例",
    onTarget: "达标",
    below: "未达标",
    notScored: "未打分",
    notYet: "未到",
    thisWeek: "本周",
    scores: (auth, ach) => `真实 ${auth} · 达成 ${ach}`,
    goalCount: (count) => `${count} 个目标`,
    noGoalsSet: "没有设目标",
    noGoal: "没有目标",
    summary: "总结",
    loadFailed: "目标加载失败。",
  },

  editor: {
    newTitle: "新目标",
    editTitle: "编辑目标",
    add: "添加",
    edit: (name) => `编辑${name}`,
    titleLabel: "目标",
    titlePlaceholder: "这个目标是什么",
    lines: "要点",
    addLine: "添加要点",
    lineText: "要点",
    lineNote: "简短备注",
    struck: "划掉",
    removeLine: "删除这个要点",
    objective: "方向",
    statusLabel: "状态",
    resultLabel: "结果",
    noResult: "未记录",
    note: "备注",
    notePlaceholder: "为什么有争议，或结果的依据",
    save: "保存",
    delete: "删除",
    deleteConfirm: "删除这个目标？",
    saved: "目标已保存",
    deleted: "目标已删除",
    saveFailed: "目标保存失败",
    needsText: "写下目标或至少一个要点。",
  },

  review: {
    title: plannerReviewNavLabelZhCN,
    lookBack: "回顾",
    lookForward: "展望",
    parts: "复盘的两部分",
    toDo: "待做",
    inProgress: "进行中",
    done: "已完成",
    saved: "已保存",
    stepOf: (step, total) => `第 ${step} 步，共 ${total} 步`,
    loadFailed: "复盘加载失败。",

    start: "开始回顾",
    drafting: "正在根据你的一周起草",
    scoring: "正在为你的一周打分",
    thinking: "思考中",
    answer: "你的回答",
    answerPlaceholder: "写下你的回答",
    send: "发送",
    next: "下一个 ›",
    skip: "跳过 ›",
    lastQuestion: "上周的问题",
    lastGoals: "上周的目标",
    promptOf: (index, total) => `${index} / ${total}`,
    scoresTitle: "分数",
    keepScores: "保留分数",
    lower: (name) => `降低${name}`,
    raise: (name) => `提高${name}`,
    trajectory: "走向",
    pattern: "规律",
    risk: "风险",
    opportunity: "机会",
    nextQuestion: "下周日的问题",
    verdictTitle: "结论",
    summaryTitle: "总结",
    writeSummary: "写总结",
    openSummary: "打开总结",
    toLookForward: "展望 →",
    noModel: "没有连接模型",
    modelDown: "模型不可用 · 使用页面草稿",
    modelLimited: "模型达到了调用上限",
    noReply: "模型没有回复",

    panelChecklist: "复盘",
    chartsTitle: (from, to) => `分数 · ${from} – ${to}`,
    chartLabel: (name, from, to, floor) =>
      `${name}按周变化，${from} 到 ${to}，底线 ${floor}`,
    lastQuestionItem: "上周的问题",
    lastGoalsItem: "上周的目标",
    scoresItem: "分数",
    nextQuestionItem: "下周日的问题",
    verdictItem: "结论",

    memo: {
      title: (week) => `${week} 总结`,
      template: "模板",
      stopped: "已停止",
      stop: "停止",
      writeAgain: "重写",
      copy: "复制 Markdown",
      copied: "已复制",
      copyBlocked: "这里无法复制",
      close: "关闭",
      writing: "写作中",
      diary: (range) => `日记 · ${range}`,
      stoppedToast: "已停止",
      templateToast: "模型没有写完 · 已使用模板",
      stoppedTemplateToast: "已停止 · 已使用模板",
      saving: "正在保存总结",
      savedToast: "总结已存入你的笔记",
      saveFailed: "总结保存失败",
      retry: "重试",
      label: (week) => `${week} 总结笔记`,
    },

    forward: {
      steps: ["检查目标", "选定本周", "安排任务", "确认"],
      open: (count) => `${count} 个待处理`,
      settled: "已处理",
      clash: "冲突",
      noClashes: "没有待处理的冲突",
      kept: "暂时保留",
      rewritten: "已改写",
      rewrite: "改写",
      keep: "暂时保留",
      undo: "撤销",
      now: "现在",
      save: "保存",
      cancel: "取消",
      fromSummary: (week) => `来自 ${week} 总结`,
      addGoal: "+ 添加目标",
      removeGoal: "删除这个目标",
      goalFor: (pillar) => `${pillar}目标`,
      goalPlaceholder: "这周的一个目标",
      todo: "待办",
      inTodo: "待办中",
      toBacklog: "移回待规划",
      newTask: "新任务",
      newTaskFor: (pillar) => `${pillar}的新任务`,
      add: "添加",
      fromBoard: "从看板选择…",
      fromBoardFor: (pillar) => `从看板为${pillar}添加任务`,
      backlog: "待规划",
      noTasks: "没有任务",
      noGoals: "本周没有目标",
      removeTask: "移除任务",
      source: {
        new: "新建",
        todo: "来自待办",
        backlog: "来自待规划",
        doing: "进行中",
        done: "已完成",
      },
      check: "冲突检查",
      checking: "检查中",
      noFlags: "没有发现冲突",
      noCheck: "没有模型可以检查",
      checkFailed: "检查没有运行",
      model: "模型",
      saveWeek: "保存本周",
      saving: "保存中",
      savedToast: (week) => `${week} 已保存`,
      saveFailed: "本周保存失败",
      backTo: (step) => `← ${step}`,
      nextTo: (step) => `${step} →`,
      lookBack: "← 回顾",
    },
  },
};

/** The copy for an app language: Chinese for zh-CN, English otherwise. */
export function plannerGoalsStringsFor(
  locale: Locale | string,
): PlannerGoalsStrings {
  return locale === "zh-CN" ? zhCN : en;
}

/** `plannerGoalsStringsFor` for the app's current language. */
export function usePlannerGoalsStrings(): PlannerGoalsStrings {
  const { locale } = useI18n();
  return useMemo(() => plannerGoalsStringsFor(locale), [locale]);
}
