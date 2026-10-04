const MEMO_ID = /^[a-zA-Z0-9_-]+$/;
export const APP_BASE = "/team-projects";
export const lastListKey = "flaremo.team-projects.last-list";
export const appPath = (path = "/") => {
  if (path === "/ideas/new") return `${APP_BASE}?new=idea`;
  if (path === "/projects/new") return `${APP_BASE}?new=active`;
  return APP_BASE;
};
// TanStack serializes JSON-shaped search values (for example the string "123")
// with quotes. Read both those URLs and older plain query-string links.
function value(params, key) {
  const raw = params.get(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    )
      return String(parsed);
  } catch {
    /* unquoted text */
  }
  return raw;
}
export function readRoute(
  _path = window.location.pathname,
  search = window.location.search,
) {
  const params = new URLSearchParams(search);
  const id = value(params, "project") || "";
  if (id && MEMO_ID.test(id)) {
    return {
      kind: ["1", "true"].includes(value(params, "edit")) ? "edit" : "detail",
      id: `memos/${id}`,
    };
  }
  const phase = value(params, "new");
  if (phase === "active" || phase === "idea") return { kind: "create", phase };
  return { kind: "list" };
}
export function projectUrl(name) {
  return `${APP_BASE}?project=${encodeURIComponent(name.replace(/^memos\//, ""))}`;
}
export function projectEditUrl(name) {
  return `${projectUrl(name)}&edit=1`;
}
export function filterUrl({ view, member, phase, query, owner, group }) {
  const p = new URLSearchParams();
  if (view !== "current") p.set("view", view);
  if (member !== "all") p.set("member", member);
  if (phase) p.set("phase", phase);
  if (query) p.set("q", query);
  if (owner) p.set("owner", owner);
  if (group) p.set("group", "owner");
  return `${APP_BASE}${p.size ? `?${p}` : ""}`;
}
export function validListUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    const url = new URL(value, "https://app.invalid");
    return url.origin === "https://app.invalid" &&
      url.pathname === APP_BASE &&
      !url.hash &&
      !url.searchParams.has("project") &&
      !url.searchParams.has("new")
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
export function readFilters(search = window.location.search) {
  const query = new URLSearchParams(search);
  const view = value(query, "view") || "current";
  return {
    view: [
      "current",
      "all",
      "followup",
      "ideas",
      "revisit",
      "maintain",
      "issues",
      "unlinked",
      "paused",
      "ended",
    ].includes(view)
      ? view
      : "current",
    member: value(query, "member") || "all",
    phase: value(query, "phase") || "",
    query: value(query, "q") || "",
    owner: value(query, "owner") || "",
    group: value(query, "group") === "owner",
  };
}
