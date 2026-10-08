import { useMemo } from "react";
import { type Locale, useI18n } from "@/i18n";
import { plannerNavLabelEn, plannerNavLabelZhCN } from "./nav-label";

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
  droppedEmpty: string;
  /** What a screen reader hears while a card is dragged. */
  drag: {
    picked: (title: string) => string;
    over: (title: string, column: string) => string;
    dropped: (title: string, column: string) => string;
    cancelled: (title: string) => string;
  };

  quickAdd: {
    label: string;
    placeholder: string;
    add: string;
  };
  /** The "+" in a column's header and the composer card it opens. */
  columnAdd: {
    /** The button's name and tooltip: "Add to Doing". */
    add: (column: string) => string;
    /** The composer's input name: "New task in Doing". */
    label: (column: string) => string;
    placeholder: string;
    hint: string;
  };
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
    starts: (date: string) => string;
    due: (date: string) => string;
    overdue: string;
    dropped: (when: string) => string;
    actions: string;
  };
  menu: {
    moveTo: string;
    setDue: string;
    changeDue: string;
    clearDue: string;
    edit: string;
    history: string;
    drop: string;
    undrop: string;
  };
  dayDialog: {
    dueTitle: string;
    dueDescription: string;
    dueConfirm: string;
    dayLabel: string;
  };
  dropDialog: { title: string; body: string; confirm: string };

  toast: {
    /** A task added from a column's "+": "Added to Doing". */
    addedTo: (column: string) => string;
    addFailed: string;
    /** The edit dialog could not fetch the task it opens with. */
    openFailed: string;
    moved: (column: string) => string;
    moveFailed: string;
    planned: (label: string) => string;
    planCleared: string;
    planFailed: string;
    dueSet: (date: string) => string;
    dueCleared: string;
    dueFailed: string;
    startFailed: string;
    dropped: string;
    dropFailed: string;
    undropped: string;
    undropFailed: string;
    rateLimited: string;
    planNotSaved: string;
    retryPlan: string;
    /** The task panel's edits that nothing else on the page confirms. */
    titleFailed: string;
    priorityFailed: string;
    goalFailed: string;
    effortFailed: string;
    notesFailed: string;
    commentAddFailed: string;
    commentEditFailed: string;
    commentDeleteFailed: string;
  };

  priority: { none: string; low: string; medium: string; high: string };

  /** The task panel: a card opened into its properties, notes, comments and history. */
  panel: {
    /** The dialog's name for a screen reader. */
    label: string;
    loading: string;
    /** The task is gone (deleted, or a stale link). */
    notFound: string;
    titleLabel: string;
    titlePlaceholder: string;
    /** What a property with no value shows, as Notion does. */
    empty: string;
    none: string;
    property: {
      status: string;
      start: string;
      due: string;
      priority: string;
      goal: string;
      effort: string;
      quarter: string;
      created: string;
    };
    quarterHint: string;
    /** The start date's clear button. */
    clearStart: string;
    effortInvalid: string;
    noGoals: string;
    notes: {
      title: string;
      placeholder: string;
      saving: string;
      saved: string;
      failed: string;
      retry: string;
    };
    comments: {
      title: string;
      empty: string;
      placeholder: string;
      /** The new-comment box's name. */
      label: string;
      send: string;
      sending: string;
      hint: string;
      edit: string;
      remove: string;
      save: string;
      edited: string;
      you: string;
      deleteTitle: string;
      deleteBody: string;
      deleteConfirm: string;
    };
    footer: {
      created: (when: string) => string;
      updated: (when: string) => string;
    };
  };

  history: {
    title: string;
    description: string;
    empty: string;
    loadFailed: string;
    you: string;
    agent: string;
    agentNamed: (name: string) => string;
    /** Who a carry-over is credited to: nobody chose it, the rollover did. */
    automatic: string;
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
    /** The panel's effort estimate: "Effort set to 3". */
    effortSet: (value: string) => string;
    effortCleared: string;
    startDateSet: (date: string) => string;
    startDateCleared: string;
    commented: string;
    commentEdited: string;
    commentDeleted: string;
    statusChanged: (status: string) => string;
    unknown: (type: string) => string;
    detail: {
      was: (label: string) => string;
      wasDue: (date: string) => string;
      wasEffort: (value: string) => string;
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
  nav: plannerNavLabelEn,
  title: plannerNavLabelEn,

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
    todo: "Tasks you have decided to do next.",
    doing: "Drag a card here when you start it.",
    done: "Finished tasks stay here for two weeks.",
    other: "Tasks with a status the cockpit does not know.",
  },
  droppedEmpty: "Nothing has been dropped.",
  drag: {
    picked: (title) => `Picked up ${title}.`,
    over: (title, column) => `${title} is over ${column}.`,
    dropped: (title, column) => `${title} was dropped in ${column}.`,
    cancelled: (title) => `Moving ${title} was cancelled.`,
  },

  quickAdd: {
    label: "New task",
    placeholder: "Add a task…",
    add: "Add",
  },
  columnAdd: {
    add: (column) => `Add to ${column}`,
    label: (column) => `New task in ${column}`,
    placeholder: "Add a task…",
    hint: "Enter to add, Esc to cancel",
  },
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
    body: "Add your first task above, then move it to To Do when you are ready.",
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
    starts: (date) => `Starts ${date}`,
    due: (date) => `Due ${date}`,
    overdue: "Overdue",
    dropped: (when) => `Dropped ${when}`,
    actions: "Task actions",
  },
  menu: {
    moveTo: "Move to",
    setDue: "Set due date…",
    changeDue: "Change due date…",
    clearDue: "Clear due date",
    edit: "Edit details",
    history: "History",
    drop: "Drop",
    undrop: "Undrop",
  },
  dayDialog: {
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
    addedTo: (column) => `Added to ${column}`,
    addFailed: "Couldn't add the task",
    openFailed: "Couldn't open the task",
    moved: (column) => `Moved to ${column}`,
    moveFailed: "Couldn't move the task",
    planned: (label) => `Planned for ${label}`,
    planCleared: "Plan cleared",
    planFailed: "Couldn't update the plan",
    dueSet: (date) => `Due date set to ${date}`,
    dueCleared: "Due date cleared",
    dueFailed: "Couldn't update the due date",
    startFailed: "Couldn't set the start date",
    dropped: "Task dropped",
    dropFailed: "Couldn't drop the task",
    undropped: "Task undropped",
    undropFailed: "Couldn't undrop the task",
    rateLimited:
      "Too many changes at once. Your edit was undone; try again in a moment.",
    planNotSaved: "Task added, but its plan wasn't saved.",
    retryPlan: "Retry plan",
    titleFailed: "Couldn't rename the task",
    priorityFailed: "Couldn't change the priority",
    goalFailed: "Couldn't change the goal",
    effortFailed: "Couldn't save the effort",
    notesFailed: "Couldn't save the notes",
    commentAddFailed: "Couldn't add the comment",
    commentEditFailed: "Couldn't save the comment",
    commentDeleteFailed: "Couldn't delete the comment",
  },

  priority: { none: "No priority", low: "Low", medium: "Medium", high: "High" },

  panel: {
    label: "Task details",
    loading: "Loading the task",
    notFound:
      "This task isn't available any more. It may have been deleted. Close this panel to go back to the board.",
    titleLabel: "Task title",
    titlePlaceholder: "Untitled",
    empty: "Empty",
    none: "None",
    property: {
      status: "Status",
      start: "Start date",
      due: "Due date",
      priority: "Priority",
      goal: "Goal",
      effort: "Effort",
      quarter: "Quarter",
      created: "Created",
    },
    quarterHint: "from start or due date",
    clearStart: "Clear start date",
    effortInvalid: "Use a number from 0 to 999, with one decimal at most.",
    noGoals: "No projects yet. Create one under Projects.",
    notes: {
      title: "Notes",
      placeholder: "Add notes…",
      saving: "Saving…",
      saved: "Saved",
      failed: "Couldn't save",
      retry: "Retry",
    },
    comments: {
      title: "Comments",
      empty: "No comments yet.",
      placeholder: "Add a comment…",
      label: "Write a comment",
      send: "Send",
      sending: "Sending…",
      hint: "Enter to send, Shift+Enter for a new line",
      edit: "Edit comment",
      remove: "Delete comment",
      save: "Save",
      edited: "edited",
      you: "You",
      deleteTitle: "Delete this comment?",
      deleteBody: "It is removed from this task. This can't be undone.",
      deleteConfirm: "Delete",
    },
    footer: {
      created: (when) => `Created ${when}`,
      updated: (when) => `Updated ${when}`,
    },
  },

  history: {
    title: "History",
    description: "Everything that happened to this task.",
    empty: "No history yet.",
    loadFailed: "Couldn't load the history.",
    you: "You",
    agent: "Agent",
    agentNamed: (name) => `Agent · ${name}`,
    automatic: "Automatic",
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
    effortSet: (value) => `Effort set to ${value}`,
    effortCleared: "Effort cleared",
    startDateSet: (date) => `Start date set to ${date}`,
    startDateCleared: "Start date cleared",
    commented: "Comment added",
    commentEdited: "Comment edited",
    commentDeleted: "Comment deleted",
    statusChanged: (status) => `Status changed to ${status}`,
    unknown: (type) => type,
    detail: {
      was: (label) => `Was ${label}`,
      wasDue: (date) => `Was due ${date}`,
      wasEffort: (value) => `Was ${value}`,
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
  nav: plannerNavLabelZhCN,
  title: plannerNavLabelZhCN,

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
    todo: "已决定接下来要做的任务。",
    doing: "开始做某件事时，把卡片拖到这里。",
    done: "完成的任务会在这里保留两周。",
    other: "状态未知的任务会出现在这里。",
  },
  droppedEmpty: "还没有放弃过任务。",
  drag: {
    picked: (title) => `已拿起“${title}”。`,
    over: (title, column) => `“${title}”在${column}上方。`,
    dropped: (title, column) => `“${title}”已放入${column}。`,
    cancelled: (title) => `已取消移动“${title}”。`,
  },

  quickAdd: {
    label: "新任务",
    placeholder: "添加任务…",
    add: "添加",
  },
  columnAdd: {
    add: (column) => `添加到${column}`,
    label: (column) => `在${column}中新建任务`,
    placeholder: "添加任务…",
    hint: "回车添加，Esc 取消",
  },
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
    starts: (date) => `${date} 开始`,
    due: (date) => `截止 ${date}`,
    overdue: "已逾期",
    dropped: (when) => `${when}放弃`,
    actions: "任务操作",
  },
  menu: {
    moveTo: "移动到",
    setDue: "设置截止日期…",
    changeDue: "修改截止日期…",
    clearDue: "清除截止日期",
    edit: "编辑详情",
    history: "历史记录",
    drop: "放弃",
    undrop: "撤销放弃",
  },
  dayDialog: {
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
    addedTo: (column) => `已添加到${column}`,
    addFailed: "添加任务失败",
    openFailed: "无法打开任务",
    moved: (column) => `已移到${column}`,
    moveFailed: "移动任务失败",
    planned: (label) => `已安排到${label}`,
    planCleared: "已清除计划",
    planFailed: "更新计划失败",
    dueSet: (date) => `截止日期已设为 ${date}`,
    dueCleared: "已清除截止日期",
    dueFailed: "更新截止日期失败",
    startFailed: "设置开始日期失败",
    dropped: "已放弃任务",
    dropFailed: "放弃任务失败",
    undropped: "已撤销放弃",
    undropFailed: "撤销放弃失败",
    rateLimited: "改动太频繁，刚才的操作已撤回，请稍后再试。",
    planNotSaved: "任务已添加，但计划没有保存成功。",
    retryPlan: "重试计划",
    titleFailed: "重命名任务失败",
    priorityFailed: "修改优先级失败",
    goalFailed: "修改目标失败",
    effortFailed: "保存工作量失败",
    notesFailed: "保存备注失败",
    commentAddFailed: "添加评论失败",
    commentEditFailed: "保存评论失败",
    commentDeleteFailed: "删除评论失败",
  },

  priority: { none: "无优先级", low: "低", medium: "中", high: "高" },

  panel: {
    label: "任务详情",
    loading: "正在加载任务",
    notFound: "这项任务已不存在，可能已被删除。关闭此面板即可回到看板。",
    titleLabel: "任务标题",
    titlePlaceholder: "无标题",
    empty: "空",
    none: "无",
    property: {
      status: "状态",
      start: "开始日期",
      due: "截止日期",
      priority: "优先级",
      goal: "目标",
      effort: "工作量",
      quarter: "季度",
      created: "创建时间",
    },
    quarterHint: "由开始或截止日期得出",
    clearStart: "清除开始日期",
    effortInvalid: "请输入 0 到 999 的数字，最多一位小数。",
    noGoals: "还没有项目，请先在“项目”里创建。",
    notes: {
      title: "备注",
      placeholder: "添加备注…",
      saving: "正在保存…",
      saved: "已保存",
      failed: "保存失败",
      retry: "重试",
    },
    comments: {
      title: "评论",
      empty: "还没有评论。",
      placeholder: "添加评论…",
      label: "写评论",
      send: "发送",
      sending: "正在发送…",
      hint: "回车发送，Shift+回车换行",
      edit: "编辑评论",
      remove: "删除评论",
      save: "保存",
      edited: "已编辑",
      you: "你",
      deleteTitle: "删除这条评论？",
      deleteBody: "评论会从这项任务中移除，无法撤销。",
      deleteConfirm: "删除",
    },
    footer: {
      created: (when) => `创建于 ${when}`,
      updated: (when) => `更新于 ${when}`,
    },
  },

  history: {
    title: "历史记录",
    description: "这项任务发生过的一切。",
    empty: "还没有历史记录。",
    loadFailed: "历史记录加载失败。",
    you: "你",
    agent: "Agent",
    agentNamed: (name) => `Agent · ${name}`,
    automatic: "自动",
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
    effortSet: (value) => `工作量设为 ${value}`,
    effortCleared: "已清除工作量",
    startDateSet: (date) => `开始日期设为 ${date}`,
    startDateCleared: "已清除开始日期",
    commented: "添加了评论",
    commentEdited: "编辑了评论",
    commentDeleted: "删除了评论",
    statusChanged: (status) => `状态改为 ${status}`,
    unknown: (type) => type,
    detail: {
      was: (label) => `原为 ${label}`,
      wasDue: (date) => `原截止 ${date}`,
      wasEffort: (value) => `原为 ${value}`,
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
