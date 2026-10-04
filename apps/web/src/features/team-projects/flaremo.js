const API = "/api/app";
/** @typedef {{ id: string, role?: "owner" | "admin" | "member" | "reader", team: null | { id: string, name: string } }} TeamIdentity */
/** @typedef {{ id: string, name: string }} DirectoryMember */
/** @typedef {{ name: string, content: string, visibility: string, state: string, create_time?: string, update_time?: string, creator?: string, creator_name?: string, can_manage?: boolean, can_govern?: boolean, payload?: { client_id?: string } }} TeamMemo */
/** @typedef {{ name: string, filename?: string, state?: string, preview_url?: string }} TeamAttachment */
/** @typedef {{ memo: TeamMemo, attachments: TeamAttachment[], can_manage: boolean, can_govern?: boolean }} TeamMemoContext */
export class ApiFailure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
/** @param {string} path
 * @param {{ signal?: AbortSignal, method?: string, body?: unknown, form?: boolean, legacyWire?: boolean }} options
 */
export async function request(
  path,
  { signal, method = "GET", body, form = false, legacyWire = false } = {},
) {
  const response = await fetch(path, {
    method,
    body:
      body === undefined
        ? undefined
        : form && body instanceof FormData
          ? body
          : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      ...(legacyWire ? { "x-flaremo-wire": "legacy" } : {}),
      ...(!form && body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiFailure(
      data?.error?.message || data?.message || `连接失败（${response.status}）`,
      response.status,
    );
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ApiFailure("服务器返回的数据格式不完整，结果待确认");
  return data;
}
export const unknownWriteResult = (error) =>
  error?.status === undefined || error.status >= 500;
/** @param {AbortSignal=} signal @returns {Promise<TeamIdentity>} */
export async function currentUser(signal) {
  const user = await request(`${API}/me`, { signal });
  if (
    typeof user.id !== "string" ||
    !(
      user.role === undefined ||
      ["owner", "admin", "member", "reader"].includes(user.role)
    ) ||
    !("team" in user)
  )
    throw new ApiFailure("身份响应缺少必要字段");
  return user;
}
/** @param {AbortSignal=} signal @returns {Promise<DirectoryMember[]>} */
export async function activeUsers(signal) {
  const data = await request("/api/v1/users", { signal });
  if (
    !Array.isArray(data.users) ||
    data.users.some(
      (user) =>
        typeof user.name !== "string" ||
        !user.name.startsWith("users/") ||
        typeof user.displayName !== "string" ||
        user.state !== "NORMAL",
    )
  )
    throw new ApiFailure("成员名册响应不完整");
  return data.users.map((user) => ({ id: user.name, name: user.displayName }));
}
/** @param {string} name @param {AbortSignal=} signal @returns {Promise<TeamMemoContext>} */
export async function getContext(name, signal) {
  const data = await request(
    `${API}/memos/${encodeURIComponent(name.replace(/^memos\//, ""))}`,
    { signal },
  );
  if (
    typeof data.memo?.name !== "string" ||
    typeof data.memo.content !== "string" ||
    !Array.isArray(data.attachments)
  )
    throw new ApiFailure("详情响应缺少必要字段");
  return data;
}
/** @param {string} name @param {AbortSignal=} signal @returns {Promise<{ revisions: TeamMemo[] }>} */
export async function revisions(name, signal) {
  const data = await request(
    `/api/v1/memos/${encodeURIComponent(name.replace(/^memos\//, ""))}/revisions`,
    { signal, legacyWire: true },
  );
  if (!Array.isArray(data.revisions)) throw new ApiFailure("修订响应缺少列表");
  return data;
}
/** @param {string} content @param {string} clientId @param {AbortSignal=} signal @returns {Promise<TeamMemo>} */
export async function createMemo(content, clientId, signal) {
  const data = await request(`${API}/memos`, {
    method: "POST",
    body: {
      content,
      visibility: "protected",
      source: "kosx-pm",
      payload: { client_id: clientId },
    },
    signal,
  });
  if (typeof data.name !== "string" || !data.name.startsWith("memos/"))
    throw new ApiFailure("写入回执缺少记录 ID，结果待确认");
  return data;
}
/** @param {string} name @param {string} content @param {AbortSignal=} signal @returns {Promise<TeamMemo>} */
export async function updateMemo(name, content, signal) {
  const data = await request(
    `${API}/memos/${encodeURIComponent(name.replace(/^memos\//, ""))}`,
    {
      method: "PATCH",
      body: { content },
      signal,
    },
  );
  if (data.name !== name || typeof data.content !== "string")
    throw new ApiFailure("修改回执不完整，结果待确认");
  return data;
}
/** @param {string} name @param {File} file @param {string} clientId @param {AbortSignal=} signal @returns {Promise<TeamAttachment>} */
export async function uploadAttachment(name, file, clientId, signal) {
  const f = new FormData();
  f.set("memo", name);
  f.set("file", file);
  f.set("client_id", clientId);
  const data = await request("/api/v1/attachments", {
    method: "POST",
    body: f,
    form: true,
    legacyWire: true,
    signal,
  });
  if (typeof data.name !== "string" || !data.name.startsWith("attachments/"))
    throw new ApiFailure("附件回执不完整，结果待确认");
  return data;
}
/** @param {AbortSignal=} signal @returns {Promise<TeamMemo[]>} */
export async function listTeamMemos(signal) {
  const result = [],
    seen = new Set(),
    seenPages = new Set();
  let token;
  do {
    const q = new URLSearchParams({
      space: "team",
      state: "normal",
      page_size: "50",
      order_by: "created_at desc",
    });
    if (token) q.set("page_token", token);
    const page = await request(`${API}/memos?${q}`, { signal });
    if (
      !Array.isArray(page.memos) ||
      (page.next_page_token !== undefined &&
        typeof page.next_page_token !== "string")
    )
      throw new ApiFailure("列表响应缺少记录或分页字段");
    for (const memo of page.memos)
      if (typeof memo?.name !== "string" || typeof memo.content !== "string")
        throw new ApiFailure("团队记录响应缺少必要字段");
    for (const memo of page.memos)
      if (!seen.has(memo.name)) {
        seen.add(memo.name);
        result.push(memo);
      }
    token = page.next_page_token;
    if (token) {
      if (seenPages.has(token))
        throw new ApiFailure("分页标识重复，列表无法确认完整");
      seenPages.add(token);
    }
  } while (token);
  return result;
}
/** @param {{ attachment: TeamAttachment, memoName: string, signal?: AbortSignal }} input @returns {Promise<{ blob: Blob, cacheControl: string | null }>} */
export async function previewAttachment({ attachment, memoName, signal }) {
  const context = await getContext(memoName, signal);
  if (
    context.memo.visibility !== "protected" ||
    context.memo.state !== "normal" ||
    !context.attachments.some(
      (a) => a.name === attachment.name && a.state === "ready",
    )
  )
    throw new ApiFailure("附件访问权限待验证", 403);
  const url = attachment.preview_url;
  if (typeof url !== "string" || !url.startsWith("/api/v1/"))
    throw new ApiFailure("附件地址无效", 400);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
  if (!response.ok)
    throw new ApiFailure(`附件不可访问（${response.status}）`, response.status);
  return {
    blob: await response.blob(),
    cacheControl: response.headers.get("cache-control"),
  };
}
