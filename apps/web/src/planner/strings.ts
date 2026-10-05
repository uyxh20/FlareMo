import { useMemo } from "react";
import { type Locale, useI18n } from "@/i18n";

// The cockpit's own copy, English and Simplified Chinese (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5).
//
// It lives here and not in the upstream catalogs on purpose: `i18n/messages`
// carries eight languages under a parity test, and a fork add-on that adds keys
// there would make every upstream merge a conflict. So only zh-CN gets its own
// wording; every other app language reads the English, which is also the
// fallback for anything missing. Text that upstream already translated (Cancel,
// Retry, Undo, priority names, the edit dialog) is reused through `t()` at the
// call site instead of being copied here.
//
// Plain data plus small template functions: no formatting library, so a string
// can be tested and read without rendering anything.

/** Relative words for plans, in one casing (see `PlannerStrings.plan`). */
export type PlannerPlanWords = {
  today: string;
  tomorrow: string;
  yesterday: string;
  thisWeek: string;
  nextWeek: string;
  lastWeek: string;
  /** `date` is a short month and day, e.g. "Oct 19". */
  weekOf: (date: string) => string;
};

export type PlannerStrings = {
  /** The Intl locale dates and relative times are formatted in. */
  intlLocale: string;
  /** The sidebar link. */
  nav: string;
  title: string;

  column: {
    backlog: string;
    todo: string;
    doing: string;
    done: string;
    other: string;
    dropped: string;
  };
  /** What an empty column says, with the next step. */
  columnHint: {
    backlog: string;
    todo: string;
    doing: string;
    done: string;
    other: string;
  };

  quickAdd: {
    label: string;
    placeholder: string;
    add: string;
    planFor: string;
  };
  /** The plan choices of quick add, and the names of the filter chips. */
  horizon: { backlog: string; day: string; week: string; month: string };
  filter: { label: string; all: string };
  showDropped: string;

  notice: {
    historyPausedTitle: string;
    historyPausedBody: string;
    truncated: string;
  };
  empty: { title: string; body: string; action: string };

  /**
   * Where a task is planned. `chip` is the short title-case form on a card
   * ("This week"); `phrase` reads inside a sentence ("Planned for this week").
   * Days and months read the same either way.
   */
  plan: {
    chip: PlannerPlanWords;
    phrase: PlannerPlanWords;
    /** "Wed 8": `weekday` is a short weekday name, `day` the day of month. */
    dayChip: (weekday: string, day: number) => string;
  };

  card: {
    carried: (count: number) => string;
    carriedTitle: (count: number) => string;
    due: (date: string) => string;
    overdue: string;
    dropped: (when: string) => string;
    actions: string;
  };
  menu: {
    moveTo: string;
    plan: string;
    setDue: string;
    changeDue: string;
    clearDue: string;
    edit: string;
    history: string;
    drop: string;
    undrop: string;
  };
  planOption: {
    today: string;
    tomorrow: string;
    thisWeek: string;
    nextWeek: string;
    thisMonth: string;
    nextMonth: string;
    pickDay: string;
    clear: string;
  };
  dayDialog: {
    planTitle: string;
    planDescription: string;
    planConfirm: string;
    dueTitle: string;
    dueDescription: string;
    dueConfirm: string;
    dayLabel: string;
  };
  dropDialog: { title: string; body: string; confirm: string };

  toast: {
    carried: (count: number) => string;
    added: { backlog: string; day: string; week: string; month: string };
    addFailed: string;
    moved: (column: string) => string;
    moveFailed: string;
    planned: (label: string) => string;
    planCleared: string;
    planFailed: string;
    dueSet: (date: string) => string;
    dueCleared: string;
    dueFailed: string;
    dropped: string;
    dropFailed: string;
    undropped: string;
    undropFailed: string;
    rateLimited: string;
    planNotSaved: string;
    retryPlan: string;
  };

  priority: { none: string; low: string; medium: string; high: string };

  history: {
    title: string;
    description: string;
    empty: string;
    loadFailed: string;
    you: string;
    agent: string;
    agentNamed: (name: string) => string;
    created: string;
    planned: (target: string) => string;
    replanned: (target: string) => string;
    unplanned: string;
    carriedOver: (target: string) => string;
    movedTo: (column: string) => string;
    completed: string;
    reopened: string;
    dropped: string;
    droppedClearedDue: string;
    undropped: string;
    deleted: string;
    restored: string;
    purged: string;
    edited: string;
    statusChanged: (status: string) => string;
    unknown: (type: string) => string;
    detail: {
      was: (label: string) => string;
      wasDue: (date: string) => string;
      renamed: (title: string) => string;
      due: (date: string) => string;
      dueCleared: string;
      priority: (label: string) => string;
      project: string;
      projectCleared: string;
      notes: string;
      nowIn: (column: string) => string;
    };
  };
};

const en: PlannerStrings = {
  intlLocale: "en-US",
  nav: "Cockpit",
  title: "Cockpit",

  column: {
    backlog: "Backlog",
    todo: "To Do",
    doing: "Doing",
    done: "Done",
    other: "Other",
    dropped: "Dropped",
  },
  columnHint: {
    backlog: "Tasks you have not planned yet wait here.",
    todo: "Plan a task for today, this week or this month.",
    doing: "Drag a card here when you start it.",
    done: "Finished tasks stay here for two weeks.",
    other: "Tasks with a status the cockpit does not know.",
  },

  quickAdd: {
    label: "New task",
    placeholder: "Add a task…",
    add: "Add",
    planFor: "Plan for",
  },
  horizon: {
    backlog: "Backlog",
    day: "Today",
    week: "This week",
    month: "This month",
  },
  filter: { label: "Filter To Do by plan", all: "All" },
  showDropped: "Show dropped",

  notice: {
    historyPausedTitle: "History paused",
    historyPausedBody:
      "Your changes still save, but the history is not updating right now.",
    truncated:
      "Showing the most recent cards. Older Backlog and Done tasks are hidden.",
  },
  empty: {
    title: "Nothing here yet",
    body: "Add your first task above, then plan it for today, this week or this month.",
    action: "Add a task",
  },

  plan: {
    chip: {
      today: "Today",
      tomorrow: "Tomorrow",
      yesterday: "Yesterday",
      thisWeek: "This week",
      nextWeek: "Next week",
      lastWeek: "Last week",
      weekOf: (date) => `Week of ${date}`,
    },
    phrase: {
      today: "today",
      tomorrow: "tomorrow",
      yesterday: "yesterday",
      thisWeek: "this week",
      nextWeek: "next week",
      lastWeek: "last week",
      weekOf: (date) => `the week of ${date}`,
    },
    dayChip: (weekday, day) => `${weekday} ${day}`,
  },

  card: {
    carried: (count) => `Carried ×${count}`,
    carriedTitle: (count) =>
      count === 1
        ? "Carried over once, because it was not finished"
        : `Carried over ${count} times, because it was not finished`,
    due: (date) => `Due ${date}`,
    overdue: "Overdue",
    dropped: (when) => `Dropped ${when}`,
    actions: "Task actions",
  },
  menu: {
    moveTo: "Move to",
    plan: "Plan",
    setDue: "Set due date…",
    changeDue: "Change due date…",
    clearDue: "Clear due date",
    edit: "Edit details",
    history: "History",
    drop: "Drop",
    undrop: "Undrop",
  },
  planOption: {
    today: "Today",
    tomorrow: "Tomorrow",
    thisWeek: "This week",
    nextWeek: "Next week",
    thisMonth: "This month",
    nextMonth: "Next month",
    pickDay: "Pick a day…",
    clear: "Clear plan",
  },
  dayDialog: {
    planTitle: "Plan for a day",
    planDescription: "Choose the day this task should get done.",
    planConfirm: "Plan",
    dueTitle: "Due date",
    dueDescription:
      "The due date is separate from the plan. Overdue reminders follow it.",
    dueConfirm: "Save",
    dayLabel: "Day",
  },
  dropDialog: {
    title: "Drop this task?",
    body: "It leaves the board and its due date is cleared, so it stops sending overdue reminders. You can undrop it later from Show dropped.",
    confirm: "Drop",
  },

  toast: {
    carried: (count) =>
      count === 1
        ? "1 unfinished task carried forward"
        : `${count} unfinished tasks carried forward`,
    added: {
      backlog: "Added to Backlog",
      day: "Added for today",
      week: "Added for this week",
      month: "Added for this month",
    },
    addFailed: "Couldn't add the task",
    moved: (column) => `Moved to ${column}`,
    moveFailed: "Couldn't move the task",
    planned: (label) => `Planned for ${label}`,
    planCleared: "Plan cleared",
    planFailed: "Couldn't update the plan",
    dueSet: (date) => `Due date set to ${date}`,
    dueCleared: "Due date cleared",
    dueFailed: "Couldn't update the due date",
    dropped: "Task dropped",
    dropFailed: "Couldn't drop the task",
    undropped: "Task undropped",
    undropFailed: "Couldn't undrop the task",
    rateLimited:
      "Too many changes at once. Your edit was undone; try again in a moment.",
    planNotSaved: "Task added, but its plan wasn't saved.",
    retryPlan: "Retry plan",
  },

  priority: { none: "No priority", low: "Low", medium: "Medium", high: "High" },

  history: {
    title: "History",
    description: "Everything that happened to this task.",
    empty: "No history yet.",
    loadFailed: "Couldn't load the history.",
    you: "You",
    agent: "Agent",
    agentNamed: (name) => `Agent · ${name}`,
    created: "Created",
    planned: (target) => `Planned for ${target}`,
    replanned: (target) => `Re-planned to ${target}`,
    unplanned: "Unplanned",
    carriedOver: (target) => `Carried over to ${target}`,
    movedTo: (column) => `Moved to ${column}`,
    completed: "Completed",
    reopened: "Reopened",
    dropped: "Dropped",
    droppedClearedDue: "Dropped (due date cleared)",
    undropped: "Undropped",
    deleted: "Deleted",
    restored: "Restored",
    purged: "Purged",
    edited: "Edited",
    statusChanged: (status) => `Status changed to ${status}`,
    unknown: (type) => type,
    detail: {
      was: (label) => `Was ${label}`,
      wasDue: (date) => `Was due ${date}`,
      renamed: (title) => `Renamed to “${title}”`,
      due: (date) => `Due ${date}`,
      dueCleared: "Due date cleared",
      priority: (label) => `Priority ${label.toLowerCase()}`,
      project: "Project changed",
      projectCleared: "Removed from its project",
      notes: "Notes edited",
      nowIn: (column) => `Now in ${column}`,
    },
  },
};

const zhCN: PlannerStrings = {
  intlLocale: "zh-CN",
  nav: "驾驶舱",
  title: "驾驶舱",

  column: {
    backlog: "待规划",
    todo: "待办",
    doing: "进行中",
    done: "已完成",
    other: "其他",
    dropped: "已放弃",
  },
  columnHint: {
    backlog: "还没安排的任务先放在这里。",
    todo: "把任务安排到今天、本周或本月。",
    doing: "开始做某件事时，把卡片拖到这里。",
    done: "完成的任务会在这里保留两周。",
    other: "状态未知的任务会出现在这里。",
  },

  quickAdd: {
    label: "新任务",
    placeholder: "添加任务…",
    add: "添加",
    planFor: "安排到",
  },
  horizon: { backlog: "待规划", day: "今天", week: "本周", month: "本月" },
  filter: { label: "按计划筛选待办", all: "全部" },
  showDropped: "显示已放弃",

  notice: {
    historyPausedTitle: "历史记录已暂停",
    historyPausedBody: "任务改动照常保存，但历史记录暂时不再更新。",
    truncated: "仅显示最近的卡片，更早的待规划和已完成任务已隐藏。",
  },
  empty: {
    title: "这里还没有任务",
    body: "在上方添加第一条任务，再把它安排到今天、本周或本月。",
    action: "添加任务",
  },

  plan: {
    chip: {
      today: "今天",
      tomorrow: "明天",
      yesterday: "昨天",
      thisWeek: "本周",
      nextWeek: "下周",
      lastWeek: "上周",
      weekOf: (date) => `${date}起的一周`,
    },
    phrase: {
      today: "今天",
      tomorrow: "明天",
      yesterday: "昨天",
      thisWeek: "本周",
      nextWeek: "下周",
      lastWeek: "上周",
      weekOf: (date) => `${date}起的一周`,
    },
    dayChip: (weekday, day) => `${weekday} ${day}日`,
  },

  card: {
    carried: (count) => `顺延 ×${count}`,
    carriedTitle: (count) => `因未完成已顺延 ${count} 次`,
    due: (date) => `截止 ${date}`,
    overdue: "已逾期",
    dropped: (when) => `${when}放弃`,
    actions: "任务操作",
  },
  menu: {
    moveTo: "移动到",
    plan: "安排计划",
    setDue: "设置截止日期…",
    changeDue: "修改截止日期…",
    clearDue: "清除截止日期",
    edit: "编辑详情",
    history: "历史记录",
    drop: "放弃",
    undrop: "撤销放弃",
  },
  planOption: {
    today: "今天",
    tomorrow: "明天",
    thisWeek: "本周",
    nextWeek: "下周",
    thisMonth: "本月",
    nextMonth: "下月",
    pickDay: "选择日期…",
    clear: "清除计划",
  },
  dayDialog: {
    planTitle: "安排到某一天",
    planDescription: "选择这项任务要完成的日期。",
    planConfirm: "安排",
    dueTitle: "截止日期",
    dueDescription: "截止日期和计划是两回事，逾期提醒按截止日期发送。",
    dueConfirm: "保存",
    dayLabel: "日期",
  },
  dropDialog: {
    title: "放弃这项任务？",
    body: "任务会从看板移走，并清除截止日期，不再发送逾期提醒。之后可以在“显示已放弃”里撤销。",
    confirm: "放弃",
  },

  toast: {
    carried: (count) => `${count} 项未完成任务已顺延`,
    added: {
      backlog: "已添加到待规划",
      day: "已安排到今天",
      week: "已安排到本周",
      month: "已安排到本月",
    },
    addFailed: "添加任务失败",
    moved: (column) => `已移到${column}`,
    moveFailed: "移动任务失败",
    planned: (label) => `已安排到${label}`,
    planCleared: "已清除计划",
    planFailed: "更新计划失败",
    dueSet: (date) => `截止日期已设为 ${date}`,
    dueCleared: "已清除截止日期",
    dueFailed: "更新截止日期失败",
    dropped: "已放弃任务",
    dropFailed: "放弃任务失败",
    undropped: "已撤销放弃",
    undropFailed: "撤销放弃失败",
    rateLimited: "改动太频繁，刚才的操作已撤回，请稍后再试。",
    planNotSaved: "任务已添加，但计划没有保存成功。",
    retryPlan: "重试计划",
  },

  priority: { none: "无优先级", low: "低", medium: "中", high: "高" },

  history: {
    title: "历史记录",
    description: "这项任务发生过的一切。",
    empty: "还没有历史记录。",
    loadFailed: "历史记录加载失败。",
    you: "你",
    agent: "Agent",
    agentNamed: (name) => `Agent · ${name}`,
    created: "创建",
    planned: (target) => `安排到${target}`,
    replanned: (target) => `改期到${target}`,
    unplanned: "取消计划",
    carriedOver: (target) => `顺延到${target}`,
    movedTo: (column) => `移到${column}`,
    completed: "完成",
    reopened: "重新打开",
    dropped: "放弃",
    droppedClearedDue: "放弃（已清除截止日期）",
    undropped: "撤销放弃",
    deleted: "删除",
    restored: "恢复",
    purged: "彻底删除",
    edited: "编辑",
    statusChanged: (status) => `状态改为 ${status}`,
    unknown: (type) => type,
    detail: {
      was: (label) => `原为 ${label}`,
      wasDue: (date) => `原截止 ${date}`,
      renamed: (title) => `改名为“${title}”`,
      due: (date) => `截止 ${date}`,
      dueCleared: "已清除截止日期",
      priority: (label) => `优先级 ${label}`,
      project: "项目已更改",
      projectCleared: "已移出项目",
      notes: "备注已编辑",
      nowIn: (column) => `现在在${column}`,
    },
  },
};

/** The cockpit's copy for an app language: Chinese for zh-CN, English otherwise. */
export function plannerStringsFor(locale: Locale | string): PlannerStrings {
  return locale === "zh-CN" ? zhCN : en;
}

/** `plannerStringsFor` for the app's current language. */
export function usePlannerStrings(): PlannerStrings {
  const { locale } = useI18n();
  return useMemo(() => plannerStringsFor(locale), [locale]);
}
