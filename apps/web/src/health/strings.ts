// The health tracker's copy (fork-owned add-on, docs/fork-health-tracker.md).
//
// Kept here, in English, and not in the eight upstream catalogs on purpose: a
// fork add-on that adds keys there would make every upstream merge a conflict
// (the same reason planner/strings.ts exists). Plain data plus small template
// functions, so a string can be read and tested without rendering anything.

export const healthStrings = {
  nav: "Health",
  title: "Health",
  loading: "Loading health",

  kind: {
    training: "Training",
    breath: "Breath",
    night_out: "Out",
  },

  strip: {
    label: "Health, last 7 days",
    open: "Open the health page",
    needsCheck: "Home time needed",
    beforeMidnight: "Home before midnight, not counted",
  },

  variant: {
    gym: "Gym",
    crossfit: "CrossFit",
    push: "Push",
    pull: "Pull",
    back: "Back",
    chest: "Chest",
    legs: "Legs",
    upper: "Upper",
    cardio: "Cardio",
    wim_hof: "Wim Hof",
    meditation: "Meditation",
  } as Record<string, string>,

  chip: {
    nightOut: "Night out",
    homeWhen: "home when?",
    home: (time: string) => `home ${time}`,
    bender: "bender",
    minutes: (minutes: number) => `${minutes} min`,
    remove: (label: string) => `Remove label: ${label}`,
    failed: "Could not save that. Try again.",
  },

  trackers: {
    title: "Trackers",
    hint: "The words each one looks for in your diary.",
    unknown: "Tracker",
    add: "New tracker",
    newName: "New tracker",
    builtin: "built-in",
    name: "Name",
    color: "Colour",
    colorName: (color: string) => `Colour: ${color}`,
    counts: "Counts",
    measures: {
      days: "days",
      minutes: "days + minutes",
      hours: "days + hours",
    } as Record<string, string>,
    words: "Counts when an entry says",
    fixedWords: "Already read",
    fixedHint: "built in, always on",
    blocked: "Never counts",
    addWord: "Add a word or #tag",
    addBlocked: "Add a word",
    addButton: "Add",
    removeWord: (word: string) => `Remove ${word}`,
    goal: "Feeds goal",
    noGoal: "No goal",
    goalHint: "The target is set on the goal.",
    test: "Test a sentence",
    testPlaceholder: "Type a sentence as you'd write it",
    testReason: {
      counted: "Counted",
      no_word: "None of the words is in it.",
      blocked: "It has a blocked word.",
      plan: "Reads as a plan, not something done.",
      negated: "Says it didn't happen.",
      long: "A long entry needs a #tag or a done word.",
    } as Record<string, string>,
    testDay: (offset: number) => (offset < 0 ? "the day before" : "that day"),
    preview: "Preview changes",
    previewing: "Reading the diary…",
    previewTitle: (memos: number) => `Checked all ${memos} diary entries`,
    previewAdded: (count: number) =>
      `${count} more ${count === 1 ? "entry counts" : "entries count"}`,
    previewRemoved: (count: number) =>
      `${count} ${count === 1 ? "entry no longer counts" : "entries no longer count"}`,
    previewKept: (count: number) =>
      `${count} kept as you fixed ${count === 1 ? "it" : "them"}`,
    previewNone: "Nothing in the diary changes.",
    apply: "Apply",
    applying: "Saving…",
    back: "Back",
    cancel: "Cancel",
    archive: "Remove tracker",
    archiveConfirm: "Remove it? Its days are hidden, never deleted.",
    archiveYes: "Remove",
    saved: (created: number, removed: number) =>
      `Saved. ${created} new, ${removed} removed.`,
    failed: "Could not save that. Try again.",
    needsWord: "Add at least one word.",
    needsName: "Give it a name.",
    hours: (minutes: number) => {
      const hours = Math.round((minutes / 60) * 10) / 10;
      return `${hours} h`;
    },
    weekNote: (days: number) => `${days} ${days === 1 ? "day" : "days"}`,
    weekHours: (minutes: number) =>
      `${Math.round((minutes / 60) * 10) / 10} h in total`,
    weekMinutes: (minutes: number) => `${minutes} min in total`,
  },

  answers: [
    { label: "Before 00:00", homeAt: "23:30" },
    { label: "00–03", homeAt: "01:30" },
    { label: "03–06", homeAt: "04:30" },
    { label: "Morning", homeAt: "08:00" },
  ] as ReadonlyArray<{ label: string; homeAt: string }>,

  page: {
    thisWeek: "Last 7 days",
    weekRange: (from: string, to: string) => `${from} to ${to}`,
    trainingTile: "Training",
    trainingNote: (sessions: number, target: number) =>
      `${sessions} of ${target} sessions`,
    breathTile: "Breath work",
    breathNote: (days: number, target: number) => `${days} of ${target} days`,
    outTile: "Nights out",
    outNote: (units: string) => `${units} in the last 7 days`,
    budgetTitle: (year: number) => `Night-out budget ${year}`,
    budgetOf: (target: number) => `of ${target} units used`,
    pace: (pace: string) => `At this rate the year ends at ${pace}.`,
    paceOver: "That is over the budget.",
    paceUnder: "That is within the budget.",
    nightsLine: (nights: number, benders: number) =>
      benders > 0
        ? `${nights} ${nights === 1 ? "night" : "nights"}, ${benders} ${benders === 1 ? "bender" : "benders"}`
        : `${nights} ${nights === 1 ? "night" : "nights"}`,
    needsTitle: "Home time needed",
    needsHint: "These nights were written without a time.",
    yearTitle: (year: number) => `${year}, week by week`,
    yearHint: "Each column is a week, Monday to Sunday.",
    gridLabel: (kind: string) => `${kind} per week`,
    cell: (kind: string, week: string, value: string) =>
      `${kind}, week of ${week}: ${value}`,
    sessions: (count: number) =>
      `${count} ${count === 1 ? "session" : "sessions"}`,
    days: (count: number) => `${count} ${count === 1 ? "day" : "days"}`,
    units: (units: string) => `${units} ${units === "1" ? "unit" : "units"}`,
    reread: "Re-read diary",
    rereading: "Reading the diary…",
    rereadHint:
      "Reads every note again. Labels you removed or fixed by hand stay as they are.",
    rereadDone: (
      memos: number,
      created: number,
      updated: number,
      removed: number,
    ) =>
      `Read ${memos} notes: ${created} new, ${updated} changed, ${removed} removed.`,
    rereadFailed: "Could not read the diary. Try again.",
    empty:
      "Nothing logged yet. Write it in your notes, like “#gym back day done” or “wim hof 10”, and it shows up here.",
    error: "Could not load health.",
    retry: "Retry",
  },
} as const;

export type HealthStrings = typeof healthStrings;
