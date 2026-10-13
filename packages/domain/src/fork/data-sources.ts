// Every place the app keeps data, and every place that data is meant to reach
// (fork-owned; docs/fork-data-sources.md).
//
// Why this file exists: each time a table or a kind of structured data is added
// (goals, week records, soon health activity), nothing used to ask "does the
// weekly review see it? is it in my export? in search? in the backup?". This
// registry makes that a decision someone writes down, and the tests next to it
// hold the code to it:
//
// - data-sources.test.ts fails when a table exists in the database that is not
//   listed here, when the backup manifest disagrees with `backup`, when the
//   search index disagrees with `search`, when the memory layer reads a table
//   not marked for `memory`, and when docs/fork-data-sources.md is out of date.
// - data-reach.test.ts writes a marker into each content source and checks the
//   marker reaches exactly the consumers marked `yes` here (weekly review look
//   back and look forward, personal export), and never another user's.
//
// Nothing imports this file at runtime: it is documentation the tests enforce.

/** The parts of the app, as the owner thinks of them. */
export const forkModules = {
  diary: "Diary (memos, tags, attachments)",
  memory: "Memory (AI-extracted memories, dreaming)",
  search: "Search (keyword and semantic index)",
  cockpit: "Planning cockpit (tasks, board, history)",
  goals: "Goals and weekly review",
  health: "Health tracker (training, breathwork, nights out)",
  account: "Account, sign-in and settings",
  integrations: "Webhooks, notifications, push",
  ops: "Background jobs",
  articles: "Articles (hidden in the sidebar)",
} as const;
export type ForkModule = keyof typeof forkModules;

/** The places that use data as context or carry it elsewhere. */
export const forkConsumers = {
  lookBack:
    "Weekly review, look back: the recap, the coach, the close and the summary memo",
  lookForward: "Weekly review, look forward: the goal check",
  search: "Search: keyword (FTS) and semantic (Vectorize) index",
  memory: "Memory layer: extraction from entries and the nightly dreaming",
  mcp: "AI agents through the MCP server",
  userExport: "Personal export (the JSON bundle from Settings)",
  backup:
    "D1 backup, restore drill and dev clone (scripts/persistence-manifest.mjs)",
} as const;
export type ForkConsumer = keyof typeof forkConsumers;

/**
 * How one data source relates to one consumer. Every answer carries a sentence:
 * `yes` says what is read, `no` says why it is deliberately left out, and `gap`
 * marks something left out that probably should not be (an open follow-up).
 */
export type ForkUse = { yes: string } | { no: string } | { gap: string };

/**
 * - content: words or numbers the owner wrote or that describe them. Each one
 *   needs a probe in data-reach.test.ts.
 * - history: an append-only trail of changes to content.
 * - structure: links and placement between content rows.
 * - bookkeeping: state the app keeps to do its job.
 * - derived: rebuilt from other tables; never the source of truth.
 * - system: accounts, sessions, keys and settings.
 */
export type ForkDataKind =
  | "content"
  | "history"
  | "structure"
  | "bookkeeping"
  | "derived"
  | "system";

export type ForkDataSource = {
  /** Unique. The table name, or `table.column` / `table:variant` for a slice of one. */
  id: string;
  table: string;
  module: ForkModule;
  kind: ForkDataKind;
  owner: "upstream" | "fork";
  /** One line in plain words: what this holds. */
  holds: string;
  uses: Record<ForkConsumer, ForkUse>;
};

const yes = (why: string): ForkUse => ({ yes: why });
const no = (why: string): ForkUse => ({ no: why });
const gap = (why: string): ForkUse => ({ gap: why });

const IN_BACKUP = yes("restored verbatim");
const NOT_CONTENT = no("not owner content");
const REVIEW_SKIPS = no("not something a weekly review reflects on");

/** All `no`, for tables that hold no owner content (accounts, jobs, plumbing). */
function plumbing(
  why: string,
  backup: ForkUse = IN_BACKUP,
): Record<ForkConsumer, ForkUse> {
  return {
    lookBack: no(why),
    lookForward: no(why),
    search: no(why),
    memory: no(why),
    mcp: no(why),
    userExport: no(why),
    backup,
  };
}

const UPSTREAM_SYSTEM = (
  table: string,
  module: ForkModule,
  holds: string,
): ForkDataSource => ({
  id: table,
  table,
  module,
  kind: "system",
  owner: "upstream",
  holds,
  uses: plumbing("account plumbing, not owner content"),
});

const FORK_EXPORT_GAP = gap(
  "fork tables are not in the personal export yet (only in the D1 backup)",
);

export const forkDataSources: readonly ForkDataSource[] = [
  // --- Diary --------------------------------------------------------------
  {
    id: "memos",
    table: "memos",
    module: "diary",
    kind: "content",
    owner: "upstream",
    holds: "Diary entries (memos), including comments and weekly summaries",
    uses: {
      lookBack: yes(
        "entries written in the reviewed week, up to 200, fitted to 12,000 or 40,000 characters",
      ),
      lookForward: no("the goal check reads goals only"),
      search: yes(
        "keyword index (memos_fts) and semantic index (resource memo)",
      ),
      memory: yes("extraction from entries and the nightly dreaming sweep"),
      mcp: yes("list, get, create, update, search"),
      userExport: yes("every entry, including archived and trashed"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "memos:earlier-week",
    table: "memos",
    module: "diary",
    kind: "content",
    owner: "upstream",
    holds: "Diary entries from weeks before the one reviewed",
    uses: {
      lookBack: gap(
        "only the reviewed week's entries and last week's summary are read; earlier weeks are not",
      ),
      lookForward: no("the goal check reads goals only"),
      search: yes("same index as every entry"),
      memory: yes("same as every entry"),
      mcp: yes("same as every entry"),
      userExport: yes("same as every entry"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "memos:weekly-summary",
    table: "memos",
    module: "goals",
    kind: "content",
    owner: "fork",
    holds:
      "Last week's summary memo (tag #vault-summary, or written by the review)",
    uses: {
      lookBack: yes(
        "the first 4,000 characters, its Next Steps and its key question",
      ),
      lookForward: no("the goal check reads goals only"),
      search: yes("same index as every entry"),
      memory: yes("same as every entry"),
      mcp: yes("same as every entry"),
      userExport: yes("same as every entry"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "memo_tags",
    table: "memo_tags",
    module: "diary",
    kind: "structure",
    owner: "upstream",
    holds: "Which #tags each entry has",
    uses: {
      lookBack: no(
        "tags reach the review as #words inside the entry text; the table only finds summaries",
      ),
      lookForward: no("the goal check reads goals only"),
      search: no("tags are searched as part of the entry text"),
      memory: no("tags are read as part of the entry text"),
      mcp: yes("returned with each memo"),
      userExport: no("rebuilt from the entry text on import"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "memo_revisions",
    table: "memo_revisions",
    module: "diary",
    kind: "history",
    owner: "upstream",
    holds: "Earlier versions of edited entries",
    uses: {
      ...plumbing("edit history, the current text is what counts"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "memo_relations",
    table: "memo_relations",
    module: "diary",
    kind: "structure",
    owner: "upstream",
    holds: "Links between entries (references, comments)",
    uses: {
      ...plumbing("links between entries, not text"),
      mcp: yes("list and set relations"),
      userExport: yes("relations between exported entries"),
    },
  },
  {
    id: "reactions",
    table: "reactions",
    module: "diary",
    kind: "structure",
    owner: "upstream",
    holds: "Emoji reactions on entries",
    uses: {
      ...plumbing("emoji on entries"),
      mcp: yes("list, add and remove reactions"),
    },
  },
  {
    id: "attachments",
    table: "attachments",
    module: "diary",
    kind: "content",
    owner: "upstream",
    holds:
      "Files and photos attached to entries (metadata; the bytes are in R2)",
    uses: {
      lookBack: gap(
        "the review is not told an entry had a photo or file, nor its name",
      ),
      lookForward: no("the goal check reads goals only"),
      search: no("files are not indexed"),
      memory: no("files are not read by the memory layer"),
      mcp: yes("list, get and delete attachments"),
      userExport: yes("metadata only; the files stay in R2"),
      backup: yes("metadata restored; the files themselves live in R2"),
    },
  },
  {
    id: "shares",
    table: "shares",
    module: "diary",
    kind: "bookkeeping",
    owner: "upstream",
    holds: "Public share links for entries",
    uses: { ...plumbing("share links"), userExport: yes("share link records") },
  },
  {
    id: "shortcuts",
    table: "shortcuts",
    module: "diary",
    kind: "system",
    owner: "upstream",
    holds: "Saved filters",
    uses: { ...plumbing("saved filters"), mcp: yes("CRUD on shortcuts") },
  },
  {
    id: "memos_sse_events",
    table: "memos_sse_events",
    module: "diary",
    kind: "bookkeeping",
    owner: "upstream",
    holds: "Live-update events for open browser tabs",
    uses: plumbing("live-update plumbing"),
  },
  {
    id: "memo_hourly_counts",
    table: "memo_hourly_counts",
    module: "diary",
    kind: "derived",
    owner: "upstream",
    holds: "Entries per hour, for the heatmap",
    uses: plumbing(
      "a counter rebuilt from memos",
      no("rebuilt from memos after a restore"),
    ),
  },

  // --- Memory --------------------------------------------------------------
  {
    id: "memory_items",
    table: "memory_items",
    module: "memory",
    kind: "content",
    owner: "upstream",
    holds:
      "Memories: facts, preferences and patterns extracted about the owner",
    uses: {
      lookBack: yes(
        "live memories created or updated in the reviewed week (local days), up to 25, most important first, unconfirmed ones marked",
      ),
      lookForward: gap(
        "the goal check does not read memories (preferences, constraints)",
      ),
      search: yes(
        "keyword index (memory_fts) and semantic index (resource memory)",
      ),
      memory: yes("the memory layer's own store"),
      mcp: yes("recall, remember, compile, forget"),
      userExport: yes("every memory"),
      backup: IN_BACKUP,
    },
  },
  ...(
    [
      ["memory_revisions", "history", "Earlier versions of each memory"],
      ["memory_relations", "structure", "Links between memories"],
      [
        "memory_resource_links",
        "structure",
        "Which entries each memory came from",
      ],
      ["memory_evidence", "structure", "Evidence behind each memory"],
      ["memory_events", "history", "What happened to each memory, and when"],
    ] as const
  ).map(
    ([table, kind, holds]): ForkDataSource => ({
      id: table,
      table,
      module: "memory",
      kind,
      owner: "upstream",
      holds,
      uses: {
        ...plumbing("supporting rows of a memory"),
        memory: yes("the memory layer's own store"),
        userExport: yes("exported with the memories"),
      },
    }),
  ),
  {
    id: "memory_rejections",
    table: "memory_rejections",
    module: "memory",
    kind: "bookkeeping",
    owner: "upstream",
    holds:
      "Memories the owner rejected, so dreaming does not propose them again",
    uses: {
      ...plumbing("rejected proposals"),
      memory: yes("dreaming skips what was rejected"),
    },
  },
  {
    id: "memory_compile_archives",
    table: "memory_compile_archives",
    module: "memory",
    kind: "bookkeeping",
    owner: "upstream",
    holds: "Compiled memory snapshots handed to agents",
    uses: {
      ...plumbing("snapshots of memories"),
      memory: yes("the memory layer's own store"),
    },
  },

  // --- Search --------------------------------------------------------------
  {
    id: "embedding_tasks",
    table: "embedding_tasks",
    module: "search",
    kind: "derived",
    owner: "upstream",
    holds: "Queue of entries and memories waiting to be (re)indexed",
    uses: plumbing(
      "indexing work",
      no("recreated from memos and memories after a restore"),
    ),
  },
  {
    id: "memos_fts",
    table: "memos_fts",
    module: "search",
    kind: "derived",
    owner: "upstream",
    holds: "Keyword index of entries",
    uses: plumbing(
      "an index kept by database triggers",
      no("rebuilt by triggers from memos"),
    ),
  },
  {
    id: "memory_fts",
    table: "memory_fts",
    module: "search",
    kind: "derived",
    owner: "upstream",
    holds: "Keyword index of memories",
    uses: plumbing(
      "an index kept by database triggers",
      no("rebuilt by triggers from memory_items"),
    ),
  },

  // --- Planning cockpit ----------------------------------------------------
  {
    id: "tasks",
    table: "tasks",
    module: "cockpit",
    kind: "content",
    owner: "upstream",
    holds: "Tasks on the board (title, status, priority, due date)",
    uses: {
      lookBack: yes(
        "titles only: done this week (40), Doing (30) and planned To Do (30)",
      ),
      lookForward: no(
        "the page sends next week's goals and their tasks; nothing is read from the database",
      ),
      search: gap("tasks are not in keyword or semantic search"),
      memory: no("the memory layer reads entries, not tasks"),
      mcp: gap("agents cannot read or change tasks over MCP"),
      userExport: yes("every task"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "tasks:backlog",
    table: "tasks",
    module: "cockpit",
    kind: "content",
    owner: "upstream",
    holds: "Backlog tasks (To Do with no week or month planned)",
    uses: {
      lookBack: no("only To Do tasks planned for a period are listed"),
      lookForward: no("the page sends next week's goals and their tasks"),
      search: gap("tasks are not in keyword or semantic search"),
      memory: no("the memory layer reads entries, not tasks"),
      mcp: gap("agents cannot read or change tasks over MCP"),
      userExport: yes("every task"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "tasks.notes",
    table: "tasks",
    module: "cockpit",
    kind: "content",
    owner: "upstream",
    holds: "A task's notes",
    uses: {
      lookBack: gap("the review sees task titles, not their notes"),
      lookForward: no("the page sends next week's goals and their tasks"),
      search: gap("tasks are not in keyword or semantic search"),
      memory: no("the memory layer reads entries, not tasks"),
      mcp: gap("agents cannot read or change tasks over MCP"),
      userExport: yes("exported with the task"),
      backup: IN_BACKUP,
    },
  },
  {
    id: "projects",
    table: "projects",
    module: "cockpit",
    kind: "structure",
    owner: "upstream",
    holds: "Projects tasks belong to",
    uses: {
      ...plumbing("task grouping; goals now carry the meaning"),
      userExport: yes("every project"),
    },
  },
  {
    id: "task_activity",
    table: "task_activity",
    module: "cockpit",
    kind: "history",
    owner: "upstream",
    holds: "Upstream's log of task changes (copied into planner_task_event)",
    uses: {
      ...plumbing("raw change log; planner_task_event is the durable copy"),
      userExport: yes("the task change log"),
    },
  },
  {
    id: "planner_task_event",
    table: "planner_task_event",
    module: "cockpit",
    kind: "history",
    owner: "fork",
    holds:
      "The permanent task history archive (the data flywheel), kept after a task is purged",
    uses: {
      lookBack: gap(
        "the review does not see how tasks moved (carried over, reopened, dropped)",
      ),
      lookForward: no("the goal check reads goals only"),
      search: no("history is not searchable"),
      memory: no("the memory layer reads entries, not tasks"),
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_task_comment",
    table: "planner_task_comment",
    module: "cockpit",
    kind: "content",
    owner: "fork",
    holds: "Comments on tasks",
    uses: {
      lookBack: gap("the review does not read task comments"),
      lookForward: no("the goal check reads goals only"),
      search: gap("task comments are not searchable"),
      memory: no("the memory layer reads entries, not tasks"),
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_task_plan",
    table: "planner_task_plan",
    module: "cockpit",
    kind: "structure",
    owner: "fork",
    holds:
      "A task's plan: week or month, start date, effort, board order, goal link",
    uses: {
      lookBack: yes(
        "decides which To Do tasks are planned (others are backlog)",
      ),
      lookForward: no("the page sends each goal's tasks itself"),
      search: NOT_CONTENT,
      memory: NOT_CONTENT,
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_project_node",
    table: "planner_project_node",
    module: "cockpit",
    kind: "structure",
    owner: "fork",
    holds: "The old project tree (level and period of each project)",
    uses: {
      ...plumbing("project tree; goals replaced it"),
      userExport: FORK_EXPORT_GAP,
    },
  },
  {
    id: "planner_task_seen",
    table: "planner_task_seen",
    module: "cockpit",
    kind: "bookkeeping",
    owner: "fork",
    holds:
      "Last known state of each task, so the history sync can spot changes",
    uses: plumbing("history sync bookkeeping"),
  },
  {
    id: "planner_sync_state",
    table: "planner_sync_state",
    module: "cockpit",
    kind: "bookkeeping",
    owner: "fork",
    holds: "Where the history sync got to",
    uses: plumbing("history sync bookkeeping"),
  },

  // --- Goals and weekly review ---------------------------------------------
  {
    id: "planner_goal",
    table: "planner_goal",
    module: "goals",
    kind: "content",
    owner: "fork",
    holds:
      "Goals: north star, year, quarter, month and week, with their lines and results",
    uses: {
      lookBack: yes(
        "the north star, this period's year, quarter and month goals, and the week's goals",
      ),
      lookForward: yes("the goal cascade the plan is checked against"),
      search: gap("goals are not searchable"),
      memory: no("the memory layer reads entries, not goals"),
      mcp: gap("agents cannot read goals over MCP"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_week",
    table: "planner_week",
    module: "goals",
    kind: "content",
    owner: "fork",
    holds: "Each reviewed week: scores, key question, verdict, summary link",
    uses: {
      lookBack: yes("eight weeks of scores and last week's key question"),
      lookForward: no("the goal check reads goals only"),
      search: NOT_CONTENT,
      memory: no("the memory layer reads entries, not weeks"),
      mcp: gap("agents cannot read week scores over MCP"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_review",
    table: "planner_review",
    module: "goals",
    kind: "content",
    owner: "fork",
    holds: "A review in progress: answers so far, what it committed",
    uses: {
      lookBack: no(
        "the page sends the answers with each request; the saved copy is for resuming",
      ),
      lookForward: no("the page sends the plan with each request"),
      search: REVIEW_SKIPS,
      memory: REVIEW_SKIPS,
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "planner_goal_flag",
    table: "planner_goal_flag",
    module: "goals",
    kind: "content",
    owner: "fork",
    holds: "Clashes the goal check found, and whether they were kept or fixed",
    uses: {
      lookBack: yes("open clashes"),
      lookForward: yes(
        "clashes kept in the last eight weeks, so they are not raised again",
      ),
      search: REVIEW_SKIPS,
      memory: REVIEW_SKIPS,
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },

  // --- Health tracker ------------------------------------------------------
  {
    id: "health_entry",
    table: "health_entry",
    module: "health",
    kind: "content",
    owner: "fork",
    holds:
      "Training sessions, breathwork and nights out, read from diary entries or fixed by hand",
    uses: {
      lookBack: yes(
        "the reviewed week's rows (day, kind, variant, minutes, home time, units, bender, feel) and the totals against the targets",
      ),
      lookForward: no("the goal check reads goals only"),
      search: no(
        "each row comes from a diary entry, and the entry is already searchable",
      ),
      memory: no(
        "the memory layer reads the diary entries the rows are read from",
      ),
      mcp: gap("agents cannot read health entries over MCP"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "health_entry_event",
    table: "health_entry_event",
    module: "health",
    kind: "history",
    owner: "fork",
    holds: "Every change to a health entry, append-only",
    uses: {
      lookBack: REVIEW_SKIPS,
      lookForward: REVIEW_SKIPS,
      search: NOT_CONTENT,
      memory: NOT_CONTENT,
      mcp: no("not exposed to agents"),
      userExport: FORK_EXPORT_GAP,
      backup: IN_BACKUP,
    },
  },
  {
    id: "health_target",
    table: "health_target",
    module: "health",
    kind: "bookkeeping",
    owner: "fork",
    holds: "The owner's health targets (sessions a week, nights out a year)",
    uses: plumbing("health tracker settings"),
  },
  {
    id: "health_sync_state",
    table: "health_sync_state",
    module: "health",
    kind: "bookkeeping",
    owner: "fork",
    holds: "When the diary was first read for health entries",
    uses: plumbing("health tracker bookkeeping"),
  },

  // --- Account, settings and plumbing --------------------------------------
  UPSTREAM_SYSTEM("users", "account", "The owner's profile"),
  UPSTREAM_SYSTEM("auth_users", "account", "Sign-in identities"),
  UPSTREAM_SYSTEM("auth_sessions", "account", "Signed-in sessions"),
  UPSTREAM_SYSTEM("auth_accounts", "account", "Password and OAuth accounts"),
  UPSTREAM_SYSTEM("auth_verifications", "account", "Email codes and resets"),
  UPSTREAM_SYSTEM("auth_apikeys", "account", "Personal access tokens"),
  UPSTREAM_SYSTEM("auth_user_links", "account", "Links sign-in to the profile"),
  UPSTREAM_SYSTEM("auth_bootstrap", "account", "First-run owner setup"),
  UPSTREAM_SYSTEM("auth_organizations", "account", "Teams"),
  UPSTREAM_SYSTEM("auth_members", "account", "Team members"),
  UPSTREAM_SYSTEM("auth_invitations", "account", "Team invitations"),
  UPSTREAM_SYSTEM("settings", "account", "App and user settings"),
  UPSTREAM_SYSTEM(
    "voice_service_config",
    "account",
    "Voice transcription setup",
  ),
  UPSTREAM_SYSTEM("integration_config", "account", "Integration setup"),
  UPSTREAM_SYSTEM("usage_counters", "account", "Quota counters"),
  UPSTREAM_SYSTEM("memos_webhooks", "integrations", "Webhook endpoints"),
  UPSTREAM_SYSTEM("memos_webhook_events", "integrations", "Webhook events"),
  UPSTREAM_SYSTEM(
    "memos_webhook_deliveries",
    "integrations",
    "Webhook deliveries",
  ),
  UPSTREAM_SYSTEM(
    "push_subscriptions",
    "integrations",
    "Browser push sign-ups",
  ),
  UPSTREAM_SYSTEM(
    "memos_notifications",
    "integrations",
    "In-app notifications",
  ),
  UPSTREAM_SYSTEM("data_tasks", "ops", "Export and import jobs"),
  UPSTREAM_SYSTEM("member_removal_jobs", "ops", "Team member removal jobs"),
  {
    id: "articles",
    table: "articles",
    module: "articles",
    kind: "content",
    owner: "upstream",
    holds: "Published articles (hidden in the sidebar; unused)",
    uses: {
      ...plumbing("the owner does not use articles"),
    },
  },
];

/** The table-level entry of each table (the one whose id is the table name). */
export function forkDataSourceTables(): string[] {
  return [...new Set(forkDataSources.map((source) => source.table))];
}

export function forkUseVerdict(use: ForkUse): "yes" | "no" | "gap" {
  return "yes" in use ? "yes" : "gap" in use ? "gap" : "no";
}

export function forkUseReason(use: ForkUse): string {
  return "yes" in use ? use.yes : "gap" in use ? use.gap : use.no;
}

const MARK = { yes: "yes", no: "–", gap: "**gap**" } as const;

/**
 * The matrix and the gap list in docs/fork-data-sources.md, between its
 * `data-sources:start` and `data-sources:end` markers. data-sources.test.ts
 * fails when the doc and this registry differ, and rewrites the doc when run
 * with FORK_DATA_SOURCES_WRITE=1.
 */
export function forkDataSourcesMarkdown(): string {
  const consumers = Object.keys(forkConsumers) as ForkConsumer[];
  const lines = [
    "| Data source | Part | Kind | " +
      consumers.map((consumer) => consumer).join(" | ") +
      " |",
    `|---|---|---|${consumers.map(() => "---").join("|")}|`,
  ];
  for (const source of forkDataSources) {
    if (source.kind === "system") continue;
    lines.push(
      `| \`${source.id}\` | ${source.module} | ${source.kind} | ${consumers
        .map((consumer) => MARK[forkUseVerdict(source.uses[consumer])])
        .join(" | ")} |`,
    );
  }
  const system = forkDataSources
    .filter((source) => source.kind === "system")
    .map((source) => `\`${source.id}\``);
  lines.push(
    "",
    `System tables, none of which reach a consumer except the backup: ${system.join(", ")}.`,
    "",
    "Gaps (left out, and probably should not be):",
    "",
  );
  for (const source of forkDataSources) {
    for (const consumer of consumers) {
      const use = source.uses[consumer];
      if ("gap" in use) {
        lines.push(`- \`${source.id}\` → ${consumer}: ${use.gap}.`);
      }
    }
  }
  return lines.join("\n");
}
