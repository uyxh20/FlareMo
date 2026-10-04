export const PHASES = [
  "idea",
  "planned",
  "active",
  "paused",
  "completed",
  "cancelled",
];
export const PHASE_LABELS = {
  idea: "想法",
  planned: "待启动",
  active: "进行中",
  paused: "暂停",
  completed: "已完成",
  cancelled: "已取消",
};
export const CATEGORIES = {
  progress: "进展",
  meeting: "会议结论",
  material: "资料",
};
function blocksIn(content) {
  const lines = content.match(/.*(?:\r?\n|$)/g) || [];
  let offset = 0,
    outer = null,
    target = null;
  const blocks = [];
  let openings = 0;
  for (const line of lines) {
    if (!line) continue;
    const plain = line.replace(/\r?\n$/, "");
    const fence = plain.match(/^([`~]{3,})(?:([\w-]+))?[ \t]*$/);
    if (fence && new Set(fence[1]).size === 1) {
      const marker = fence[1],
        language = fence[2] || "";
      if (target) {
        if (
          marker[0] === target.marker[0] &&
          marker.length >= target.marker.length &&
          !language
        ) {
          blocks.push({
            start: target.start,
            end: offset + line.length,
            json: content.slice(target.bodyStart, offset).trim(),
          });
          target = null;
        }
      } else if (outer) {
        if (
          marker[0] === outer[0] &&
          marker.length >= outer.length &&
          !language
        )
          outer = null;
      } else if (language === "kosx-pm" && marker[0] === "`") {
        openings++;
        target = { marker, start: offset, bodyStart: offset + line.length };
      } else outer = marker;
    }
    offset += line.length;
  }
  return { blocks, openings };
}
const ID = /^memos\/[A-Za-z0-9_-]+$/;
export const todayShanghai = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
// A follow-up date is a calendar date in the viewer's local zone in FlareMo.
// Keep todayShanghai for existing protocol fixtures and historical exports.
export const todayLocal = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}
export function validIso(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return false;
  const day = value.slice(0, 10),
    hh = Number(value.slice(11, 13)),
    mm = Number(value.slice(14, 16)),
    ss = Number(value.slice(17, 19));
  const zone = value.endsWith("Z") ? "Z" : value.slice(-6);
  return (
    validDate(day) &&
    hh <= 23 &&
    mm <= 59 &&
    ss <= 59 &&
    (zone === "Z" ||
      (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)) &&
    !Number.isNaN(Date.parse(value))
  );
}
export function validUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
}
function issue(issues, field, value, check, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) issues.push({ field, kind: "missing" });
    return;
  }
  if (!check(value)) issues.push({ field, kind: "invalid" });
}
export function parseMemo(memo) {
  if (
    !memo ||
    !ID.test(memo.name) ||
    memo.visibility !== "protected" ||
    memo.state !== "normal"
  )
    return { type: "ignored" };
  const content = typeof memo.content === "string" ? memo.content : "";
  const { openings, blocks } = blocksIn(content);
  if (!openings) return { type: "ignored" };
  if (openings !== 1) return { type: "error", memo, reason: "重复元数据块" };
  if (blocks.length !== 1)
    return { type: "error", memo, reason: "元数据块未闭合" };
  let data;
  try {
    data = JSON.parse(blocks[0].json);
  } catch {
    return { type: "error", memo, reason: "JSON 格式错误" };
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.schema !== "kosx.pm/1" ||
    !["project", "update"].includes(data.kind)
  )
    return { type: "error", memo, reason: "未知协议或记录类型" };
  if (data.kind === "project" && !PHASES.includes(data.phase))
    return { type: "error", memo, reason: "项目阶段缺失或非法" };
  const issues = [];
  issue(
    issues,
    "client_submission_id",
    data.client_submission_id,
    (v) => typeof v === "string" && v.trim().length > 0,
  );
  if (data.kind === "project") {
    issue(
      issues,
      "name",
      data.name,
      (v) => typeof v === "string" && !!v.trim(),
      true,
    );
    const active = data.phase === "active";
    for (const field of ["goal", "current_summary", "next_action"])
      issue(
        issues,
        field,
        data[field],
        (v) => typeof v === "string" && !!v.trim(),
        active,
      );
    issue(
      issues,
      "owner",
      data.owner,
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.name === "string" &&
        !!v.name.trim() &&
        (v.user_id === undefined ||
          v.user_id === null ||
          (typeof v.user_id === "string" &&
            /^users\/[A-Za-z0-9_-]+$/.test(v.user_id))),
      active,
    );
    issue(issues, "next_check_on", data.next_check_on, validDate, active);
    for (const field of ["target_due_on", "idea_review_on"])
      issue(issues, field, data[field], validDate);
    issue(issues, "blocker", data.blocker, (v) => typeof v === "string");
    issue(issues, "confirmed_at", data.confirmed_at, validIso);
    issue(issues, "phase_history", data.phase_history, (v) => Array.isArray(v));
    if (Array.isArray(data.phase_history)) {
      let previous = null;
      data.phase_history.forEach((h, index) => {
        const valid =
          h &&
          typeof h === "object" &&
          !Array.isArray(h) &&
          (h.from === null || PHASES.includes(h.from)) &&
          PHASES.includes(h.to) &&
          typeof h.reason === "string" &&
          validIso(h.recorded_at) &&
          (!["paused", "completed", "cancelled"].includes(h.to) ||
            !!h.reason.trim()) &&
          !(previous && h.from !== previous) &&
          (!["completed", "cancelled"].includes(h.from) || !!h.reason.trim());
        if (!valid)
          issues.push({ field: `phase_history[${index}]`, kind: "invalid" });
        if (h && PHASES.includes(h.to)) previous = h.to;
      });
      if (
        ["paused", "completed", "cancelled"].includes(data.phase) &&
        data.phase_history.at(-1)?.to !== data.phase
      )
        issues.push({ field: "phase_history", kind: "missing" });
    }
    if (
      ["paused", "completed", "cancelled"].includes(data.phase) &&
      !Array.isArray(data.phase_history)
    )
      issues.push({ field: "phase_history", kind: "missing" });
  } else {
    issue(
      issues,
      "project_ref",
      data.project_ref,
      (v) => typeof v === "string" && ID.test(v),
      true,
    );
    issue(issues, "category", data.category, (v) =>
      Object.hasOwn(CATEGORIES, v),
    );
    issue(issues, "occurred_on", data.occurred_on, validDate);
    issue(
      issues,
      "references",
      data.references,
      (v) => Array.isArray(v) && v.every(validUrl),
    );
  }
  return {
    type: data.kind,
    memo,
    data,
    body: (
      content.slice(0, blocks[0].start) + content.slice(blocks[0].end)
    ).trim(),
    issues,
  };
}
export function readCorpus(memos) {
  const records = memos.map(parseMemo),
    projects = records.filter((r) => r.type === "project"),
    projectById = new Map(projects.map((p) => [p.memo.name, p]));
  const updates = records.filter((r) => r.type === "update");
  return {
    projects,
    updates,
    errors: records.filter((r) => r.type === "error"),
    orphans: updates.filter((u) => !projectById.has(u.data.project_ref)),
    projectById,
  };
}
export function followupStatus(project, today = todayLocal()) {
  if (project.data.phase !== "active" || !validDate(project.data.next_check_on))
    return null;
  if (project.data.next_check_on > today) return null;
  return project.data.next_check_on === today ? "今天跟进" : "跟进日期已过";
}
export function displayName(project) {
  return typeof project.data.name === "string" && project.data.name.trim()
    ? project.data.name.trim()
    : `未命名项目 ${project.memo.name}`;
}
export function metadataText(data, body = "") {
  return `${body.trim()}${body.trim() ? "\n\n" : ""}\`\`\`kosx-pm\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}
export function replaceMetadata(original, data) {
  const blocks = blocksIn(original).blocks;
  if (blocks.length !== 1)
    throw new Error("原记录格式已变化，请在原记录修复后再保存");
  return (
    original.slice(0, blocks[0].start) +
    `\`\`\`kosx-pm\n${JSON.stringify(data, null, 2)}\n\`\`\`` +
    original.slice(blocks[0].end)
  );
}
export function replaceBody(original, body) {
  const blocks = blocksIn(original).blocks;
  if (blocks.length !== 1) throw new Error("原记录格式已变化");
  return `${body.trim()}\n\n${original.slice(blocks[0].start)}`;
}
export function newProject(input) {
  const base = {
    schema: "kosx.pm/1",
    kind: "project",
    name: input.name.trim(),
    phase: input.phase,
    phase_history: [],
    client_submission_id: crypto.randomUUID(),
  };
  if (input.phase === "active")
    Object.assign(base, {
      goal: input.goal.trim(),
      owner: input.owner,
      current_summary: input.current_summary.trim(),
      next_action: input.next_action.trim(),
      next_check_on: input.next_check_on,
    });
  if (input.phase === "idea" && input.idea_review_on)
    base.idea_review_on = input.idea_review_on;
  for (const field of ["goal", "current_summary", "next_action", "blocker"])
    if (typeof input[field] === "string" && input[field].trim())
      base[field] = input[field].trim();
  if (input.owner?.name) base.owner = input.owner;
  for (const field of ["next_check_on", "target_due_on", "idea_review_on"])
    if (validDate(input[field])) base[field] = input[field];
  return base;
}
export function validateActive(data) {
  const p = parseMemo({
    name: "memos/validation",
    content: metadataText(data),
    visibility: "protected",
    state: "normal",
  });
  return p.type === "project"
    ? p.issues.filter((x) =>
        [
          "name",
          "goal",
          "owner",
          "current_summary",
          "next_action",
          "next_check_on",
        ].includes(x.field),
      )
    : [{ field: "phase", kind: "invalid" }];
}
