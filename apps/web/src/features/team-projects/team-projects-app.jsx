import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, UploadIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activeUsers,
  createMemo as createMemoApi,
  currentUser,
  getContext,
  listTeamMemos,
  previewAttachment,
  revisions,
  unknownWriteResult,
  updateMemo as updateMemoApi,
  uploadAttachment as uploadAttachmentApi,
} from "./flaremo.js";
import {
  CATEGORIES,
  displayName,
  followupStatus,
  metadataText,
  newProject,
  PHASE_LABELS,
  PHASES,
  parseMemo,
  readCorpus,
  replaceBody,
  replaceMetadata,
  todayLocal,
  validateActive,
  validDate,
  validIso,
  validUrl,
} from "./model.js";
import {
  appPath,
  filterUrl,
  lastListKey,
  projectEditUrl,
  projectUrl,
  readFilters,
  readRoute,
  validListUrl,
} from "./navigation.js";
import { SelectMenu } from "./select-menu.jsx";
import "./team-projects.css";
import { useI18n } from "@/i18n";
import { setTeamProjectsLocale, teamProjectsDateLocale, tr } from "./copy.js";

const SOURCE = window.location.origin;
const FIELDS = {
  name: "名称",
  goal: "目标",
  owner: "负责人",
  current_summary: "当前情况",
  next_action: "下一步动作",
  next_check_on: "下次跟进日期",
  phase_history: "阶段说明",
  references: "资料链接",
  project_ref: "关联项目",
};
const EMPTY = {
  name: "",
  phase: "active",
  goal: "",
  ownerName: "",
  ownerId: "",
  current_summary: "",
  next_action: "",
  next_check_on: "",
  target_due_on: "",
  idea_review_on: "",
  blocker: "",
  reason: "",
  confirmNow: false,
};
const UPDATE = {
  category: "progress",
  text: "",
  occurred_on: "",
  references: "",
};
const source = (name) =>
  `${SOURCE}/memo/${encodeURIComponent(name.replace(/^memos\//, ""))}`;
function UploadControl({
  name,
  disabled,
  busy,
  error,
  onStart,
  onChoose,
  onCancel,
}) {
  const input = useRef(null);
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.addEventListener("cancel", onCancel);
    return () => node.removeEventListener("cancel", onCancel);
  }, [onCancel]);
  return (
    <div className="pm-upload-control">
      <button
        type="button"
        className="pm-upload-button"
        aria-label={tr("为") + name + tr("上传资料")}
        disabled={disabled}
        onClick={() => {
          onStart();
          input.current?.click();
        }}
      >
        <UploadIcon size={16} aria-hidden="true" />
        {busy ? tr("上传中…") : tr("上传资料")}
      </button>
      <input
        ref={input}
        className="pm-file-input"
        type="file"
        tabIndex={-1}
        disabled={disabled}
        aria-hidden="true"
        onChange={onChoose}
      />
      {error && (
        <small role="alert" className="pm-upload-error">
          {error}
        </small>
      )}
    </div>
  );
}
const shortTime = (value) =>
  validIso(value)
    ? new Date(value).toLocaleString(teamProjectsDateLocale())
    : value
      ? tr("日期待修正")
      : tr("未登记");
const filled = (value) => (typeof value === "string" ? value.trim() : "");
const show = (value) =>
  typeof value === "string" && value.trim()
    ? value
    : typeof value === "number"
      ? String(value)
      : tr("待补充");
const projectTitle = (record) => filled(record.data.name) || tr("未命名项目");
const shortId = (name) => name.replace(/^memos\//, "").slice(0, 8);
function Issues({ items }) {
  return items?.length ? (
    <p className="pm-issues">
      {items
        .map(
          (x) =>
            tr(FIELDS[x.field] || x.field) +
            " " +
            (x.kind === "missing" ? tr("待补充") : tr("待修正")),
        )
        .join(" · ")}
    </p>
  ) : null;
}
function ownerFor(form, users, old) {
  const chosen = users.find((person) => person.id === form.ownerId);
  if (chosen) return { name: chosen.name, user_id: chosen.id };
  return !form.ownerId && old?.name === filled(form.ownerName) ? old : null;
}
function initialForm(record) {
  const d = record.data;
  return {
    name: typeof d.name === "string" ? d.name : "",
    phase: d.phase,
    goal: typeof d.goal === "string" ? d.goal : "",
    ownerName: typeof d.owner?.name === "string" ? d.owner.name : "",
    ownerId: typeof d.owner?.user_id === "string" ? d.owner.user_id : "",
    current_summary:
      typeof d.current_summary === "string" ? d.current_summary : "",
    next_action: typeof d.next_action === "string" ? d.next_action : "",
    next_check_on: validDate(d.next_check_on) ? d.next_check_on : "",
    target_due_on: validDate(d.target_due_on) ? d.target_due_on : "",
    idea_review_on: validDate(d.idea_review_on) ? d.idea_review_on : "",
    blocker: typeof d.blocker === "string" ? d.blocker : "",
    reason: "",
    confirmNow: false,
  };
}
function ownerStatus(project, user) {
  const owner = project.data.owner;
  if (!owner || typeof owner !== "object" || typeof owner.user_id !== "string")
    return tr("未关联账号");
  return owner.user_id === user?.id ? tr("已关联本账号") : tr("关联待核验");
}
const NEXT_PHASES = {
  idea: ["idea", "planned", "active", "cancelled"],
  planned: ["planned", "active", "cancelled"],
  active: ["active", "paused", "completed", "cancelled"],
  paused: ["paused", "active", "completed", "cancelled"],
  completed: ["completed", "active"],
  cancelled: ["cancelled", "active"],
};
const ACTIVE_REQUIRED = [
  "goal",
  "ownerName",
  "current_summary",
  "next_action",
  "next_check_on",
];
function activating(form, mode, base) {
  return (
    form.phase === "active" && (mode === "create" || form.phase !== base?.phase)
  );
}
function needsPhaseReason(form, mode, base) {
  return (
    mode === "edit" &&
    form.phase !== base?.phase &&
    (["paused", "completed", "cancelled"].includes(form.phase) ||
      ["paused", "completed", "cancelled"].includes(base?.phase))
  );
}
function projectFormErrors(form, mode, base) {
  const errors = {};
  const originalName = base?.initial?.name || "";
  if (
    !filled(form.name) &&
    (mode === "create" || Boolean(originalName) || form.name !== originalName)
  )
    errors.name = tr("请填写项目名称");
  if (mode === "edit" && !NEXT_PHASES[base?.phase]?.includes(form.phase))
    errors.phase = tr("这个阶段不能直接转换到所选阶段");
  if (activating(form, mode, base)) {
    for (const key of ACTIVE_REQUIRED) {
      if (
        key === "ownerName"
          ? !filled(form.ownerId)
          : key === "next_check_on"
            ? !validDate(form[key])
            : !filled(form[key])
      )
        errors[key] =
          tr(FIELDS[key === "ownerName" ? "owner" : key]) + tr("为进行中必填");
    }
  }
  for (const key of ["next_check_on", "target_due_on", "idea_review_on"])
    if (form[key] && !validDate(form[key])) errors[key] = tr("日期无效");
  if (needsPhaseReason(form, mode, base) && !filled(form.reason))
    errors.reason = tr("请填写阶段变化的原因或结果");
  return errors;
}
function requirement(key, form, mode, base) {
  if (key === "phase") return tr("必填");
  if (key === "name")
    return mode === "create" || filled(base?.initial?.name)
      ? tr("必填")
      : tr("待补充，可逐项维护");
  if (activating(form, mode, base) && ACTIVE_REQUIRED.includes(key))
    return tr("必填");
  if (
    mode === "edit" &&
    form.phase === "active" &&
    ACTIVE_REQUIRED.includes(key) &&
    !filled(form[key])
  )
    return tr("待补充，可逐项维护");
  return tr("可选");
}

export function DemoApp({ navigateTeam }) {
  const { locale } = useI18n();
  setTeamProjectsLocale(locale);
  const queryClient = useQueryClient();
  function invalidateHostMemos() {
    void queryClient.invalidateQueries({ queryKey: ["memos"] });
    void queryClient.invalidateQueries({ queryKey: ["memo-stats"] });
  }
  async function createMemo(content, clientId, signal) {
    const result = await createMemoApi(content, clientId, signal);
    invalidateHostMemos();
    return result;
  }
  async function updateMemo(name, content, signal) {
    const result = await updateMemoApi(name, content, signal);
    invalidateHostMemos();
    return result;
  }
  async function uploadAttachment(name, file, clientId, signal) {
    const result = await uploadAttachmentApi(name, file, clientId, signal);
    invalidateHostMemos();
    return result;
  }
  const location = useLocation();
  const initialFilters = useRef(readFilters());
  const [me, setMe] = useState(null),
    [users, setUsers] = useState([]),
    [usersError, setUsersError] = useState(false),
    [rows, setRows] = useState([]),
    [state, setState] = useState("loading"),
    [message, setMessage] = useState(""),
    [synced, setSynced] = useState(null);
  const [filter, setFilter] = useState(initialFilters.current.view),
    [memberFilter, setMemberFilter] = useState(initialFilters.current.member),
    [groupByOwner, setGroupByOwner] = useState(initialFilters.current.group),
    [phaseFilter, setPhaseFilter] = useState(initialFilters.current.phase),
    [query, setQuery] = useState(initialFilters.current.query),
    [ownerQuery, setOwnerQuery] = useState(initialFilters.current.owner),
    [route, setRoute] = useState(() => readRoute()),
    [selected, setSelected] = useState(() => readRoute().id || null),
    [detail, setDetail] = useState(null),
    [detailState, setDetailState] = useState("idle");
  const [form, setForm] = useState(EMPTY),
    [formError, setFormError] = useState(null),
    [mode, setMode] = useState(null),
    [progress, setProgress] = useState(UPDATE),
    [composerOpen, setComposerOpen] = useState(false),
    [quickEdit, setQuickEdit] = useState(null),
    [quickValue, setQuickValue] = useState(""),
    [quickReason, setQuickReason] = useState(""),
    [quickError, setQuickError] = useState(""),
    [uploadError, setUploadError] = useState(null),
    [saving, setSaving] = useState(false),
    [uncertain, setUncertain] = useState(null);
  const [history, setHistory] = useState(null),
    [historyName, setHistoryName] = useState(null),
    [historyState, setHistoryState] = useState("idle"),
    [preview, setPreview] = useState(null),
    [day, setDay] = useState(todayLocal());
  const identity = useRef(null),
    generation = useRef(0),
    requests = useRef(new Set()),
    objectUrl = useRef(null),
    selectedId = useRef(readRoute().id || null),
    lock = useRef(null),
    uncertainRef = useRef(null),
    inflightRef = useRef(null),
    previewSeq = useRef(0),
    previewWork = useRef(null),
    historySeq = useRef(0),
    editBase = useRef(null),
    quickBase = useRef(null),
    fileChooserOpen = useRef(false),
    focusRefreshTimer = useRef(null),
    focusRefreshPending = useRef(false),
    modalElement = useRef(null),
    modalReturnFocus = useRef(null),
    restoreScroll = useRef(null);
  const formErrorRef = useRef(null);
  const modalOpen =
    Boolean(preview) ||
    (typeof mode === "object" && mode !== null && state === "ready");
  useEffect(() => {
    if (modalOpen) {
      if (!modalReturnFocus.current)
        modalReturnFocus.current = document.activeElement;
      requestAnimationFrame(() => {
        if (
          modalElement.current &&
          !modalElement.current.contains(document.activeElement)
        )
          modalElement.current.querySelector("button:not([disabled])")?.focus();
      });
    } else if (modalReturnFocus.current) {
      const previous = modalReturnFocus.current;
      modalReturnFocus.current = null;
      requestAnimationFrame(() => previous.isConnected && previous.focus());
    }
  }, [modalOpen]);
  function onModalKeyDown(event) {
    if (event.key === "Escape" && !saving) {
      event.preventDefault();
      if (mode) setMode(null);
      else closePreview();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = [
      ...event.currentTarget.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.getClientRects().length > 0);
    if (!nodes.length) return;
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  const task = useCallback(() => {
    const c = new AbortController();
    requests.current.add(c);
    return {
      signal: c.signal,
      abort: () => c.abort(),
      done: () => requests.current.delete(c),
      generation: generation.current,
    };
  }, []);
  const closePreview = () => {
    previewSeq.current++;
    previewWork.current?.abort();
    previewWork.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPreview(null);
  };
  const clear = useCallback(() => {
    clearTimeout(focusRefreshTimer.current);
    fileChooserOpen.current = false;
    focusRefreshPending.current = false;
    generation.current++;
    previewSeq.current++;
    historySeq.current++;
    requests.current.forEach((c) => {
      c.abort();
    });
    requests.current.clear();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setRows([]);
    setUsers([]);
    setUsersError(false);
    setSelected(null);
    selectedId.current = null;
    setDetail(null);
    setHistory(null);
    setHistoryName(null);
    setPreview(null);
    setForm(EMPTY);
    setFormError(null);
    setProgress(UPDATE);
    setComposerOpen(false);
    setMode(null);
    setQuickEdit(null);
    setUploadError(null);
    quickBase.current = null;
    editBase.current = null;
    uncertainRef.current = null;
    inflightRef.current = null;
    lock.current = null;
    setUncertain(null);
    setSynced(null);
  }, []);
  const refresh = useCallback(
    async (options = {}) => {
      const background = options?.background === true;
      focusRefreshPending.current = false;
      if (inflightRef.current && !uncertainRef.current) {
        uncertainRef.current = inflightRef.current;
        setUncertain(inflightRef.current);
        setMessage(tr("请求已中断，保存结果待确认；请核对或同次重试。"));
      }
      generation.current++;
      previewSeq.current++;
      historySeq.current++;
      requests.current.forEach((c) => {
        c.abort();
      });
      requests.current.clear();
      lock.current = null;
      const work = task();
      if (!background) {
        setState("loading");
        setMe(null);
        setRows([]);
        setDetail(null);
      }
      setHistory(null);
      setHistoryName(null);
      setPreview(null);
      setSaving(false);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
      try {
        const user = await currentUser(work.signal);
        if (work.generation !== generation.current) return;
        const key = `${user.team?.id || "none"}:${user.id}`;
        if (identity.current && identity.current !== key) {
          clear();
          identity.current = key;
          setMe(user);
          const next = readRoute();
          selectedId.current = next.id || null;
          setSelected(next.id || null);
          return refresh();
        }
        identity.current = key;
        setMe(user);
        if (!user.team) {
          setState("no-team");
          return;
        }
        const memos = await listTeamMemos(work.signal);
        const directory = await activeUsers(work.signal).catch(() => null);
        if (work.generation !== generation.current) return;
        setUsers(directory || []);
        setUsersError(!directory);
        let currentDetail = null;
        let revokedName = null;
        if (selectedId.current) {
          const name = selectedId.current;
          if (memos.some((m) => m.name === name)) {
            currentDetail = await getContext(name, work.signal).catch(
              () => null,
            );
          }
          if (work.generation !== generation.current) return;
          if (
            currentDetail?.memo.visibility !== "protected" ||
            currentDetail?.memo.state !== "normal"
          ) {
            revokedName = name;
            selectedId.current = null;
            setSelected(name);
            setDetail(null);
            setDetailState("denied");
            setMode(null);
            setQuickEdit(null);
            quickBase.current = null;
          } else {
            setDetail(currentDetail);
            setDetailState("ready");
            if (currentDetail.can_manage !== true)
              setMode((old) => (old === "edit" ? null : old));
          }
        }
        setRows(
          revokedName ? memos.filter((m) => m.name !== revokedName) : memos,
        );
        setDay(todayLocal());
        setSynced(new Date().toISOString());
        setState("ready");
        if (uncertainRef.current?.kind === "memo") {
          const match = memos.find(
            (m) => m.payload?.client_id === uncertainRef.current.id,
          );
          if (match) {
            uncertainRef.current = null;
            inflightRef.current = null;
            setUncertain(null);
            setMessage(tr("已核对保存结果：") + match.name + tr(""));
          }
        }
      } catch (e) {
        if (work.generation !== generation.current || e.name === "AbortError")
          return;
        if (e.status === 401) clear();
        setState(e.status === 401 ? "signed-out" : "failed");
        setMe(null);
        setMessage(
          e.status === 401
            ? tr("请先使用 FlareMo 账号登录。")
            : tr("权限刷新失败；受保护内容已隐藏：") + tr(e.message),
        );
      } finally {
        work.done();
      }
    },
    [clear, task],
  );
  useEffect(() => {
    refresh();
    const onFocus = () => {
      setDay(todayLocal());
      // A native file chooser returns focus before its change/cancel event. Do not
      // unmount that input or abort the upload that follows it.
      if (
        fileChooserOpen.current ||
        inflightRef.current ||
        lock.current !== null
      ) {
        focusRefreshPending.current = true;
        return;
      }
      clearTimeout(focusRefreshTimer.current);
      // Let the focus-initiating click finish. Same-identity rechecks retain
      // the DOM; revoked access, changed identity and failures hide it.
      focusRefreshTimer.current = setTimeout(() => {
        if (
          fileChooserOpen.current ||
          inflightRef.current ||
          lock.current !== null
        ) {
          focusRefreshPending.current = true;
          return;
        }
        refresh({ background: true });
      }, 0);
    };
    window.addEventListener("focus", onFocus);
    const ticker = setInterval(() => setDay(todayLocal()), 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearTimeout(focusRefreshTimer.current);
      clearInterval(ticker);
      requests.current.forEach((c) => {
        c.abort();
      });
    };
  }, [refresh]);
  const corpus = useMemo(() => readCorpus(rows), [rows]);
  const project = selected ? corpus.projectById.get(selected) : null;
  const updates = project
    ? corpus.updates
        .filter((x) => x.data.project_ref === selected)
        .sort((a, b) => b.memo.create_time.localeCompare(a.memo.create_time))
    : [];
  const visible = corpus.projects.filter((p) => {
    const phase = p.data.phase;
    if (
      filter === "current" &&
      !phaseFilter &&
      !["active", "planned"].includes(phase)
    )
      return false;
    if (filter === "followup" && !followupStatus(p, day)) return false;
    if (filter === "ideas" && phase !== "idea") return false;
    if (
      filter === "revisit" &&
      !(
        phase === "idea" &&
        validDate(p.data.idea_review_on) &&
        p.data.idea_review_on <= day
      )
    )
      return false;
    if (filter === "paused" && phase !== "paused") return false;
    if (filter === "ended" && !["completed", "cancelled"].includes(phase))
      return false;
    if (filter === "mine" && p.data.owner?.user_id !== me?.id) return false;
    if (memberFilter === "self" && p.data.owner?.user_id !== me?.id)
      return false;
    if (
      memberFilter !== "all" &&
      memberFilter !== "self" &&
      p.data.owner?.user_id !== memberFilter
    )
      return false;
    if (filter === "maintain" && p.memo.can_manage !== true) return false;
    if (filter === "unlinked" && ownerStatus(p, me) === tr("已关联本账号"))
      return false;
    if (phaseFilter && phaseFilter !== "all" && phase !== phaseFilter)
      return false;
    if (filter === "issues" && !p.issues.length) return false;
    if (
      query &&
      !displayName(p).toLowerCase().includes(query.toLowerCase()) &&
      !p.memo.name.toLowerCase().includes(query.toLowerCase())
    )
      return false;
    if (ownerQuery && !filled(p.data.owner?.name).includes(ownerQuery))
      return false;
    return true;
  });
  const orderedVisible = groupByOwner
    ? [...visible].sort(
        (a, b) =>
          filled(a.data.owner?.name).localeCompare(
            filled(b.data.owner?.name),
            "zh-CN",
          ) || projectTitle(a).localeCompare(projectTitle(b), "zh-CN"),
      )
    : visible;
  const activeNav = ["ideas", "revisit"].includes(filter)
    ? "ideas"
    : memberFilter === "self"
      ? "mine"
      : "current";
  async function open(name) {
    selectedId.current = name;
    editBase.current = null;
    setMode(null);
    setSelected(name);
    setProgress(UPDATE);
    setComposerOpen(false);
    setQuickEdit(null);
    setQuickError("");
    setUploadError(null);
    quickBase.current = null;
    setDetail(null);
    setDetailState("loading");
    setHistory(null);
    setHistoryName(null);
    setHistoryState("idle");
    closePreview();
    const w = task();
    try {
      const context = await getContext(name, w.signal);
      if (w.generation !== generation.current || selectedId.current !== name)
        return;
      if (
        context.memo.visibility !== "protected" ||
        context.memo.state !== "normal"
      ) {
        setRows((old) => old.filter((x) => x.name !== name));
        setSelected(name);
        setDetail(null);
        setDetailState("denied");
        setMessage(tr("原记录已不在当前团队可见范围"));
        return;
      }
      setDetail(context);
      setDetailState("ready");
    } catch (e) {
      if (
        w.generation !== generation.current ||
        selectedId.current !== name ||
        e.name === "AbortError"
      )
        return;
      setRows((old) => old.filter((x) => x.name !== name));
      setSelected(name);
      setDetail(null);
      setDetailState(
        e.status === 403 || e.status === 404 ? "denied" : "failed",
      );
      setMessage(tr("详情读取失败：") + tr(e.message));
    } finally {
      w.done();
    }
  }
  function fail(text) {
    if (mode === "create" || mode === "edit") {
      setMessage("");
      setFormError({ summary: text, fields: {} });
      requestAnimationFrame(() => formErrorRef.current?.focus());
    } else {
      setMessage(text);
    }
  }
  function finishWrite(w) {
    w.done();
    const ownsLock = lock.current === w.generation;
    if (ownsLock) lock.current = null;
    if (w.generation === generation.current) setSaving(false);
    if (ownsLock && focusRefreshPending.current && !fileChooserOpen.current) {
      focusRefreshPending.current = false;
      queueMicrotask(() => refresh({ background: true }));
    }
  }
  function updateForm(key, value, extra = {}) {
    setForm((old) => ({ ...old, [key]: value, ...extra }));
    if (key === "phase") {
      setFormError(null);
      return;
    }
    setFormError((old) =>
      old
        ? {
            summary: "",
            fields: Object.fromEntries(
              Object.entries(old.fields).filter(([field]) => field !== key),
            ),
          }
        : null,
    );
  }
  function openCreate(phase) {
    editBase.current = null;
    setForm({ ...EMPTY, phase });
    setMode("create");
    setFormError(null);
    setMessage("");
  }
  function openEdit() {
    if (!detail?.can_manage) return;
    const initial = initialForm(project);
    editBase.current = {
      name: project.memo.name,
      content: project.memo.content,
      update_time: project.memo.update_time,
      initial,
      phase: project.data.phase,
    };
    setForm(initial);
    setMode("edit");
    setFormError(null);
    setMessage("");
  }
  function openQuick(field) {
    if (!detail?.can_manage || !project) return;
    quickBase.current = {
      name: project.memo.name,
      content: project.memo.content,
      update_time: project.memo.update_time,
      phase: project.data.phase,
    };
    setQuickValue(
      typeof project.data[field] === "string" ? project.data[field] : "",
    );
    setQuickReason("");
    setQuickError("");
    setQuickEdit(field);
  }
  async function saveQuick() {
    const base = quickBase.current;
    if (!base || !quickEdit || lock.current !== null || uncertainRef.current)
      return;
    if (
      base.name !== selected ||
      base.name !== project?.memo.name ||
      selectedId.current !== base.name
    ) {
      setQuickError(tr("项目已切换，请重新打开当前项目的编辑入口"));
      return;
    }
    const value = filled(quickValue);
    if (quickEdit === "next_check_on" && value && !validDate(value)) {
      setQuickError(tr("请选择有效日期"));
      return;
    }
    if (quickEdit === "phase" && !NEXT_PHASES[base.phase]?.includes(value)) {
      setQuickError(tr("不能直接切换到这个状态"));
      return;
    }
    if (
      quickEdit === "phase" &&
      value !== base.phase &&
      (["paused", "completed", "cancelled"].includes(value) ||
        ["paused", "completed", "cancelled"].includes(base.phase)) &&
      !filled(quickReason)
    ) {
      setQuickError(tr("请说明状态变化的原因或结果"));
      return;
    }
    const w = task();
    lock.current = w.generation;
    setSaving(true);
    setQuickError("");
    try {
      const latest = await getContext(base.name, w.signal);
      if (
        !latest.can_manage ||
        latest.memo.visibility !== "protected" ||
        latest.memo.state !== "normal"
      ) {
        setQuickError(tr("当前账号无权编辑这条项目记录"));
        return;
      }
      if (
        latest.memo.update_time !== base.update_time ||
        latest.memo.content !== base.content
      ) {
        setQuickError(tr("项目已被其他入口更新，请刷新后再编辑"));
        return;
      }
      const parsed = parseMemo(latest.memo);
      if (parsed.type !== "project") {
        setQuickError(tr("项目格式已变化，请刷新后再试"));
        return;
      }
      if (
        w.generation !== generation.current ||
        selectedId.current !== base.name ||
        project?.memo.name !== base.name
      )
        return;
      const data = { ...parsed.data };
      if (quickEdit === "phase") {
        if (value !== data.phase) {
          if (
            data.phase_history != null &&
            !Array.isArray(data.phase_history)
          ) {
            setQuickError(tr("原阶段说明格式异常，请先修复原记录"));
            return;
          }
          data.phase_history = [
            ...(Array.isArray(data.phase_history) ? data.phase_history : []),
            {
              from: data.phase,
              to: value,
              reason: filled(quickReason),
              recorded_at: new Date().toISOString(),
            },
          ];
          data.phase = value;
        }
        if (value === "active" && validateActive(data).length) {
          setQuickError(
            tr("启动为进行中前需补齐目标、负责人、当前情况、下一步和跟进日期"),
          );
          return;
        }
      } else {
        data[quickEdit] = value || null;
      }
      const content = replaceMetadata(latest.memo.content, data);
      const pending = {
        kind: "quick",
        action: "quick",
        memoName: base.name,
        baseContent: base.content,
        baseTime: base.update_time,
        content,
      };
      inflightRef.current = pending;
      let saved;
      try {
        saved = await updateMemo(base.name, content, w.signal);
      } catch (error) {
        if (!unknownWriteResult(error)) {
          inflightRef.current = null;
          throw error;
        }
        const check = await getContext(base.name, w.signal).catch(() => null);
        if (check?.memo.content === content) saved = check.memo;
        else {
          uncertainRef.current = pending;
          setUncertain(pending);
          setQuickError(tr("保存结果待确认，请核对后使用同一次提交重试"));
          return;
        }
      }
      inflightRef.current = null;
      if (w.generation !== generation.current || !saved?.name) return;
      setQuickEdit(null);
      await refresh({ background: true });
      setMessage(tr("项目已更新"));
    } catch (error) {
      if (w.generation === generation.current && error.name !== "AbortError")
        setQuickError(tr("保存失败：") + tr(error.message));
    } finally {
      finishWrite(w);
    }
  }
  function scrollHost() {
    return (
      document.querySelector(".team-project-workbench")?.closest("main") ||
      window
    );
  }
  function scrollPosition() {
    const host = scrollHost();
    return host instanceof HTMLElement ? host.scrollTop : window.scrollY;
  }
  function navigateTo(path, { replace = false } = {}) {
    const target = new URL(path, window.location.origin);
    if (route.kind === "list" && !replace) {
      const listUrl = filterUrl({
        view: filter,
        member: memberFilter,
        phase: phaseFilter,
        query,
        owner: ownerQuery,
        group: groupByOwner,
      });
      window.sessionStorage.setItem(lastListKey, listUrl);
      window.sessionStorage.setItem(
        `${lastListKey}:scroll`,
        String(scrollPosition()),
      );
    }
    void navigateTeam(Object.fromEntries(target.searchParams), replace);
    const nextRoute = readRoute(target.pathname, target.search);
    if (nextRoute.kind === "list") {
      restoreScroll.current = Number(
        window.sessionStorage.getItem(`${lastListKey}:scroll`) || 0,
      );
      const nextFilters = readFilters(target.search);
      setFilter(nextFilters.view);
      setMemberFilter(nextFilters.member);
      setPhaseFilter(nextFilters.phase);
      setQuery(nextFilters.query);
      setOwnerQuery(nextFilters.owner);
      setGroupByOwner(nextFilters.group);
    }
    setRoute(nextRoute);
  }
  function returnToList() {
    const saved =
      validListUrl(window.sessionStorage.getItem(lastListKey)) || appPath("/");
    navigateTo(saved);
  }
  useEffect(() => {
    const onLocation = () => {
      const next = readRoute(location.pathname, location.searchStr);
      if (next.kind === "list") {
        restoreScroll.current = Number(
          window.sessionStorage.getItem(`${lastListKey}:scroll`) || 0,
        );
        const f = readFilters(location.searchStr);
        setFilter(f.view);
        setMemberFilter(f.member);
        setPhaseFilter(f.phase);
        setQuery(f.query);
        setOwnerQuery(f.owner);
        setGroupByOwner(f.group);
      }
      setRoute(next);
    };
    onLocation();
  }, [location.pathname, location.searchStr]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Route transitions are keyed by URL and permission state; callbacks read epoch-guarded refs and must not restart this effect on each render.
  useEffect(() => {
    if (state !== "ready") return;
    if (route.kind === "list") {
      selectedId.current = null;
      setSelected(null);
      setMode(null);
      setQuickEdit(null);
      quickBase.current = null;
      closePreview();
    } else if (route.id && selectedId.current !== route.id) {
      setMode(null);
      open(route.id);
    } else if (route.kind === "detail" && mode === "edit") {
      setMode(null);
    } else if (route.kind === "create" && mode !== "create") {
      openCreate(route.phase);
    } else if (
      route.kind === "edit" &&
      detail?.memo.name === route.id &&
      detail.can_manage &&
      mode !== "edit"
    ) {
      openEdit();
    }
  }, [route.kind, route.id, state, detail?.memo.name, detail?.can_manage]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: List length intentionally schedules scroll restoration after rows render; scrollHost only reads the current DOM.
  useEffect(() => {
    if (
      route.kind !== "list" ||
      state !== "ready" ||
      selected !== null ||
      restoreScroll.current === null
    )
      return;
    const target = restoreScroll.current;
    restoreScroll.current = null;
    requestAnimationFrame(() => {
      const host = scrollHost();
      host.scrollTo(0, target);
    });
  }, [route.kind, state, selected, visible.length]);
  useEffect(() => {
    if (route.kind !== "list") return;
    const url = filterUrl({
      view: filter,
      member: memberFilter,
      phase: phaseFilter,
      query,
      owner: ownerQuery,
      group: groupByOwner,
    });
    window.sessionStorage.setItem(lastListKey, url);
    if (`${window.location.pathname}${window.location.search}` !== url)
      void navigateTeam(
        Object.fromEntries(new URL(url, window.location.origin).searchParams),
        true,
      );
  }, [
    route.kind,
    filter,
    memberFilter,
    phaseFilter,
    query,
    ownerQuery,
    groupByOwner,
    navigateTeam,
  ]);
  async function saveProject() {
    if (lock.current !== null || uncertainRef.current) {
      fail(tr("先核对上一笔保存结果，再继续提交"));
      return;
    }
    if (
      mode === "edit" &&
      (!project || editBase.current?.name !== project.memo.name)
    ) {
      fail(tr("项目编辑来源已变化，请重新打开"));
      return;
    }
    const errors = projectFormErrors(form, mode, editBase.current);
    if (Object.keys(errors).length) {
      const summary =
        tr("请先修正：") + Object.values(errors).join("；") + tr("");
      setFormError({ summary, fields: errors });
      setMessage("");
      requestAnimationFrame(() => formErrorRef.current?.focus());
      return;
    }
    const w = task();
    lock.current = w.generation;
    setSaving(true);
    setMessage("");
    try {
      let saved;
      let verifiedUsers = users;
      if (
        mode === "create" ||
        form.ownerId !== editBase.current?.initial.ownerId ||
        form.ownerName !== editBase.current?.initial.ownerName
      ) {
        verifiedUsers = await activeUsers(w.signal);
        setUsers(verifiedUsers);
        setUsersError(false);
        if (
          form.ownerId &&
          !verifiedUsers.some((person) => person.id === form.ownerId)
        ) {
          fail(tr("负责人已不在当前可见名册，请重新选择"));
          return;
        }
      }
      if (mode === "create") {
        const data = newProject({
          ...form,
          owner: ownerFor(form, verifiedUsers),
        });
        if (form.phase !== "active" && filled(form.goal))
          data.goal = filled(form.goal);
        const content = metadataText(data);
        inflightRef.current = {
          kind: "memo",
          action: "project",
          id: data.client_submission_id,
          content,
        };
        try {
          saved = await createMemo(
            content,
            data.client_submission_id,
            w.signal,
          );
          inflightRef.current = null;
        } catch (e) {
          if (unknownWriteResult(e) && !w.signal.aborted) {
            const current = await listTeamMemos(w.signal).catch(() => null);
            saved = current?.find(
              (x) => x.payload?.client_id === data.client_submission_id,
            );
            if (!saved) {
              uncertainRef.current = inflightRef.current;
              setUncertain(uncertainRef.current);
              fail(tr("保存结果待确认。已阻止重复创建；请刷新核对。"));
              return;
            }
            inflightRef.current = null;
          } else {
            if (e.name !== "AbortError") inflightRef.current = null;
            throw e;
          }
        }
      } else {
        const base = editBase.current;
        const latest = await getContext(base.name, w.signal);
        if (!latest.can_manage) {
          fail(tr("原版当前账号无权维护这条项目主记录"));
          return;
        }
        if (
          latest.memo.update_time !== base.update_time ||
          latest.memo.content !== base.content
        ) {
          fail(tr("原记录已变化，请刷新并重新查看后再保存"));
          return;
        }
        const parsed = parseMemo(latest.memo);
        if (parsed.type !== "project") {
          fail(tr("原记录格式已变化，请重新查看"));
          return;
        }
        const data = { ...parsed.data };
        const initial = base.initial;
        for (const key of [
          "name",
          "goal",
          "current_summary",
          "next_action",
          "next_check_on",
          "target_due_on",
          "idea_review_on",
          "blocker",
        ]) {
          if (form[key] !== initial[key])
            data[key] = filled(form[key]) || (key === "name" ? "" : null);
        }
        if (
          form.ownerId !== initial.ownerId ||
          form.ownerName !== initial.ownerName
        )
          data.owner = ownerFor(form, verifiedUsers, data.owner);
        if (form.confirmNow) data.confirmed_at = new Date().toISOString();
        if (data.phase !== form.phase) {
          if (
            data.phase_history !== undefined &&
            data.phase_history !== null &&
            !Array.isArray(data.phase_history)
          ) {
            fail(tr("阶段说明字段格式错误，请先在原记录修复，不能覆盖原值"));
            return;
          }
          const old = data.phase;
          data.phase = form.phase;
          data.phase_history = [
            ...(Array.isArray(data.phase_history) ? data.phase_history : []),
            {
              from: old,
              to: form.phase,
              reason: filled(form.reason),
              recorded_at: new Date().toISOString(),
            },
          ];
          if (form.phase === "active" && validateActive(data).length) {
            fail(tr("启动为进行中前需修正全部必填字段"));
            return;
          }
        }
        saved = await updateMemo(
          base.name,
          replaceMetadata(latest.memo.content, data),
          w.signal,
        );
      }
      if (w.generation !== generation.current) return;
      if (!saved?.name) {
        fail(tr("服务器未返回记录 ID，保存结果待确认"));
        return;
      }
      setMode(null);
      uncertainRef.current = null;
      setUncertain(null);
      selectedId.current = saved.name;
      setSelected(saved.name);
      navigateTo(projectUrl(saved.name), { replace: true });
      const key = identity.current;
      await refresh();
      if (key === identity.current) {
        await open(saved.name);
        setMessage(tr("已保存到 FlareMo 团队记录。"));
      }
    } catch (e) {
      if (w.generation === generation.current && e.name !== "AbortError")
        fail(tr("保存失败：") + tr(e.message));
    } finally {
      finishWrite(w);
    }
  }
  async function publish() {
    if (
      lock.current !== null ||
      uncertainRef.current ||
      !project ||
      !filled(progress.text)
    ) {
      if (uncertainRef.current) fail(tr("先核对上一笔保存结果，再继续提交"));
      return;
    }
    if (progress.occurred_on && !validDate(progress.occurred_on)) {
      fail(tr("发生日期无效"));
      return;
    }
    const refs = progress.references.split("\n").map(filled).filter(Boolean);
    if (refs.some((x) => !validUrl(x))) {
      fail(tr("资料链接须为有效的 HTTP 或 HTTPS 地址"));
      return;
    }
    const w = task();
    lock.current = w.generation;
    setSaving(true);
    const data = {
      schema: "kosx.pm/1",
      kind: "update",
      project_ref: project.memo.name,
      category: progress.category,
      occurred_on: progress.occurred_on || null,
      references: refs,
      client_submission_id: crypto.randomUUID(),
    };
    const content = metadataText(data, progress.text);
    try {
      const root = await getContext(project.memo.name, w.signal);
      if (parseMemo(root.memo).type !== "project")
        throw new Error(tr("关联项目已不可读或格式已变化，请刷新"));
      inflightRef.current = {
        kind: "memo",
        action: "progress",
        projectRef: data.project_ref,
        id: data.client_submission_id,
        content,
      };
      let saved;
      try {
        saved = await createMemo(content, data.client_submission_id, w.signal);
        inflightRef.current = null;
      } catch (e) {
        if (unknownWriteResult(e) && !w.signal.aborted) {
          const current = await listTeamMemos(w.signal).catch(() => null);
          saved = current?.find(
            (x) => x.payload?.client_id === data.client_submission_id,
          );
          if (!saved) {
            uncertainRef.current = inflightRef.current;
            setUncertain(uncertainRef.current);
            fail(tr("进展保存结果待确认，已阻止重复提交。"));
            return;
          }
          inflightRef.current = null;
        } else {
          if (e.name !== "AbortError") inflightRef.current = null;
          throw e;
        }
      }
      if (w.generation !== generation.current) return;
      setProgress(UPDATE);
      setComposerOpen(false);
      const key = identity.current;
      await refresh();
      if (key === identity.current) {
        await open(data.project_ref);
        fail(tr("进展已保存"));
      }
    } catch (e) {
      if (w.generation === generation.current && e.name !== "AbortError")
        fail(tr("发布失败：") + tr(e.message));
    } finally {
      finishWrite(w);
    }
  }
  async function saveOwnUpdate(update, text) {
    if (lock.current !== null || !filled(text)) return;
    const w = task();
    lock.current = w.generation;
    setSaving(true);
    try {
      const latest = await getContext(update.memo.name, w.signal);
      if (
        !latest.can_manage ||
        latest.memo.update_time !== update.memo.update_time
      ) {
        fail(tr("记录已变化或当前身份无权修改，请刷新"));
        return;
      }
      await updateMemo(
        update.memo.name,
        replaceBody(latest.memo.content, text),
        w.signal,
      );
      if (w.generation !== generation.current) return;
      setMode(null);
      const key = identity.current;
      await refresh();
      if (key === identity.current) {
        await open(update.data.project_ref);
        fail(tr("本人记录已修改"));
      }
    } catch (e) {
      if (w.generation === generation.current && e.name !== "AbortError")
        fail(tr("修改失败：") + tr(e.message));
    } finally {
      finishWrite(w);
    }
  }
  async function showHistory(name) {
    const sequence = ++historySeq.current;
    const projectName = selectedId.current;
    const w = task();
    setHistory(null);
    setHistoryName(name);
    setHistoryState("loading");
    try {
      const data = await revisions(name, w.signal);
      if (
        w.generation !== generation.current ||
        sequence !== historySeq.current ||
        selectedId.current !== projectName
      )
        return;
      setHistory(data.revisions || []);
      setHistoryState("ready");
    } catch (e) {
      if (
        w.generation !== generation.current ||
        sequence !== historySeq.current ||
        selectedId.current !== projectName ||
        e.name === "AbortError"
      )
        return;
      setHistoryState(e.status === 403 ? "denied" : "failed");
    } finally {
      w.done();
    }
  }
  async function showAttachment(attachment, name) {
    closePreview();
    const sequence = previewSeq.current;
    const w = task();
    previewWork.current = w;
    setPreview({ state: "loading", filename: attachment.filename });
    try {
      const result = await previewAttachment({
        attachment,
        memoName: name,
        signal: w.signal,
      });
      if (
        w.generation !== generation.current ||
        sequence !== previewSeq.current ||
        selectedId.current !== selected
      )
        return;
      const url = URL.createObjectURL(result.blob);
      objectUrl.current = url;
      setPreview({
        state: "ready",
        filename: attachment.filename,
        url,
        type: result.blob.type,
        cacheControl: result.cacheControl,
      });
    } catch (e) {
      if (
        w.generation !== generation.current ||
        sequence !== previewSeq.current ||
        selectedId.current !== selected ||
        e.name === "AbortError"
      )
        return;
      setPreview({ state: "failed", filename: attachment.filename });
      fail(tr("附件权限待验证：") + tr(e.message));
    } finally {
      if (previewWork.current === w) previewWork.current = null;
      w.done();
    }
  }
  async function attach(file, name) {
    if (!file || lock.current !== null || uncertainRef.current) return;
    const w = task(),
      id = crypto.randomUUID();
    lock.current = w.generation;
    inflightRef.current = { kind: "attachment", id, file, memoName: name };
    setSaving(true);
    setUploadError(null);
    try {
      await uploadAttachment(name, file, id, w.signal);
      inflightRef.current = null;
      if (w.generation !== generation.current) return;
      const key = identity.current;
      focusRefreshPending.current = false;
      await refresh();
      if (key === identity.current) {
        await open(selected);
        fail(tr("资料已上传并绑定原记录"));
      }
    } catch (e) {
      if (
        unknownWriteResult(e) &&
        e.name !== "AbortError" &&
        w.generation === generation.current
      ) {
        uncertainRef.current = inflightRef.current;
        setUncertain(inflightRef.current);
      }
      if (!unknownWriteResult(e)) inflightRef.current = null;
      if (w.generation === generation.current && e.name !== "AbortError") {
        const text = unknownWriteResult(e)
          ? tr("上传结果待确认；请核对后以同一提交标识重试")
          : tr("上传失败：") + tr(e.message);
        setUploadError({ name, text });
        fail(text);
      }
    } finally {
      finishWrite(w);
    }
  }
  function attachmentChosen(event, name) {
    const file = event.target.files?.[0];
    event.target.value = "";
    fileChooserOpen.current = false;
    if (file) {
      focusRefreshPending.current = false;
      void attach(file, name);
    } else if (focusRefreshPending.current) {
      focusRefreshPending.current = false;
      void refresh({ background: true });
    }
  }
  function attachmentCancelled() {
    fileChooserOpen.current = false;
    if (focusRefreshPending.current) {
      focusRefreshPending.current = false;
      void refresh({ background: true });
    }
  }
  async function retryPending() {
    const pending = uncertainRef.current;
    if (!pending || state !== "ready" || lock.current !== null) return;
    const w = task();
    lock.current = w.generation;
    setSaving(true);
    setMessage(tr("正在核对同一次提交…"));
    try {
      if (pending.kind === "memo") {
        const current = await listTeamMemos(w.signal);
        const found = current.find((x) => x.payload?.client_id === pending.id);
        if (!found) await createMemo(pending.content, pending.id, w.signal);
      } else if (pending.kind === "quick") {
        const context = await getContext(pending.memoName, w.signal);
        if (
          !context.can_manage ||
          context.memo.visibility !== "protected" ||
          context.memo.state !== "normal"
        )
          throw new Error(tr("当前身份无权维护这条项目记录"));
        if (context.memo.content !== pending.content) {
          if (
            context.memo.content !== pending.baseContent ||
            context.memo.update_time !== pending.baseTime
          )
            throw new Error(tr("原记录已变化，请刷新并核对，不能自动重试"));
          await updateMemo(pending.memoName, pending.content, w.signal);
        }
      } else {
        const context = await getContext(pending.memoName, w.signal);
        if (
          !context.can_manage ||
          context.memo.visibility !== "protected" ||
          context.memo.state !== "normal"
        )
          throw new Error(tr("当前身份无权为这条记录上传资料"));
        await uploadAttachment(
          pending.memoName,
          pending.file,
          pending.id,
          w.signal,
        );
      }
      if (w.generation !== generation.current) return;
      uncertainRef.current = null;
      inflightRef.current = null;
      setUncertain(null);
      if (pending.action === "project") setMode(null);
      if (pending.action === "quick") setQuickEdit(null);
      if (pending.action === "progress") setProgress(UPDATE);
      const key = identity.current;
      await refresh();
      if (key === identity.current) {
        if (selectedId.current) await open(selectedId.current);
        fail(tr("同一次提交已核对并保存"));
      }
    } catch (e) {
      if (w.generation === generation.current && e.name !== "AbortError")
        fail(tr("仍无法确认结果：") + tr(e.message));
    } finally {
      finishWrite(w);
    }
  }

  return (
    <div className="pm-app team-project-workbench">
      {message && (
        <div className="pm-message" role="status">
          {message}
          <button type="button" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      {state !== "ready" ? (
        <div className="pm-empty">
          <h1>
            {state === "loading"
              ? tr("正在读取团队记录")
              : state === "signed-out"
                ? tr("请登录 FlareMo")
                : state === "no-team"
                  ? tr("当前账号没有有效团队成员身份")
                  : tr("连接失败")}
          </h1>
          <p>{message || tr("使用原版 FlareMo 账号登录，再返回此页刷新。")}</p>
          <a href={SOURCE} target="_blank" rel="noreferrer">
            {tr("\n\t\t\t\t\t\t打开 FlareMo\n\t\t\t\t\t")}
          </a>
          <button type="button" onClick={refresh}>
            {tr("重新连接")}
          </button>
        </div>
      ) : mode === "create" || mode === "edit" ? null : (
        <div className="pm-layout">
          <section className="pm-content">
            {selected && project ? (
              <>
                <div className="pm-detailnav">
                  <button type="button" onClick={returnToList}>
                    {tr("\n\t\t\t\t\t\t\t\t\t\t← 返回总览\n\t\t\t\t\t\t\t\t\t")}
                  </button>
                </div>
                <div className="pm-title pm-project-title">
                  <div className="pm-title-copy">
                    <div className="pm-title-line">
                      <h1>{projectTitle(project)}</h1>
                      <span
                        className={`pm-phase pm-phase-${project.data.phase}`}
                      >
                        {tr(PHASE_LABELS[project.data.phase])}
                      </span>
                    </div>
                    <p>
                      {tr("负责人：")}
                      {show(project.data.owner?.name)} {tr(" · 最近更新：")}
                      {shortTime(project.memo.update_time)}
                    </p>
                  </div>
                  {detail?.can_manage && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        openEdit();
                        navigateTo(projectEditUrl(selected));
                      }}
                    >
                      {tr(
                        "\n\t\t\t\t\t\t\t\t\t\t\t编辑项目信息\n\t\t\t\t\t\t\t\t\t\t",
                      )}
                    </button>
                  )}
                  <button type="button" onClick={() => refresh()}>
                    {tr("刷新")}
                  </button>
                </div>
                <section className="pm-work-top">
                  <div className="pm-work-next">
                    <small>{tr("接下来")}</small>
                    <strong>
                      {filled(project.data.next_action) ||
                        (project.data.phase === "active"
                          ? tr("待补充")
                          : tr("尚未安排"))}
                    </strong>
                    <span>
                      {tr("下次跟进：")}
                      {validDate(project.data.next_check_on)
                        ? project.data.next_check_on
                        : tr("尚未安排")}
                    </span>
                  </div>
                  {detail?.can_manage && (
                    <div className="pm-quick-actions">
                      <button type="button" onClick={() => openQuick("phase")}>
                        {tr("更新状态")}
                      </button>
                      <button
                        type="button"
                        onClick={() => openQuick("next_action")}
                      >
                        {tr("修改下一步")}
                      </button>
                      <button
                        type="button"
                        onClick={() => openQuick("next_check_on")}
                      >
                        {tr("调整跟进日期")}
                      </button>
                    </div>
                  )}
                  {quickEdit && (
                    <div className="pm-quick-editor">
                      <div className="pm-quick-field">
                        <span>
                          {quickEdit === "phase"
                            ? tr("项目状态")
                            : quickEdit === "next_action"
                              ? tr("下一步动作")
                              : tr("下次跟进日期")}
                        </span>
                        {quickEdit === "phase" ? (
                          <SelectMenu
                            ariaLabel={tr("项目状态")}
                            value={quickValue}
                            onChange={setQuickValue}
                            options={(
                              NEXT_PHASES[quickBase.current?.phase] || PHASES
                            ).map((phase) => ({
                              value: phase,
                              label: tr(PHASE_LABELS[phase]),
                            }))}
                          />
                        ) : (
                          <input
                            aria-label={
                              quickEdit === "next_action"
                                ? tr("下一步动作")
                                : tr("下次跟进日期")
                            }
                            type={
                              quickEdit === "next_check_on" ? "date" : "text"
                            }
                            value={quickValue}
                            onChange={(e) => setQuickValue(e.target.value)}
                          />
                        )}
                      </div>
                      {quickEdit === "phase" &&
                        quickValue !== quickBase.current?.phase && (
                          <label>
                            {tr("变化原因或结果")}
                            <textarea
                              value={quickReason}
                              onChange={(e) => setQuickReason(e.target.value)}
                            />
                          </label>
                        )}
                      {quickError && <p role="alert">{quickError}</p>}
                      <div>
                        <button
                          type="button"
                          className="primary"
                          disabled={saving || Boolean(uncertain)}
                          onClick={saveQuick}
                        >
                          {saving ? tr("保存中…") : tr("保存")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setQuickEdit(null)}
                        >
                          {tr("取消")}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
                <Issues items={project.issues} />
                <section className="pm-card pm-activity">
                  <h2>
                    {tr("\n\t\t\t\t\t\t\t\t\t\t最新进展 ")}
                    <small>
                      {updates.length} {tr(" 条")}
                    </small>
                  </h2>
                  {me.role !== "reader" && (
                    <button
                      type="button"
                      className="pm-add-progress"
                      onClick={() => setComposerOpen((open) => !open)}
                      aria-expanded={composerOpen}
                    >
                      {composerOpen ? tr("收起记录") : tr("添加进展")}
                    </button>
                  )}
                  {me.role !== "reader" && composerOpen && (
                    <div className="pm-progress">
                      <SelectMenu
                        ariaLabel={tr("记录类型")}
                        value={progress.category}
                        onChange={(category) =>
                          setProgress((old) => ({ ...old, category }))
                        }
                        options={Object.entries(CATEGORIES).map(
                          ([id, label]) => ({ value: id, label: tr(label) }),
                        )}
                      />
                      <textarea
                        aria-label={tr("进展正文")}
                        placeholder={tr("记录实际进展、会议结论或资料说明")}
                        value={progress.text}
                        onChange={(e) =>
                          setProgress({ ...progress, text: e.target.value })
                        }
                      />
                      <details>
                        <summary>
                          {tr("日期与资料链接（可选）")}
                          <ChevronDownIcon size={15} aria-hidden="true" />
                        </summary>
                        <input
                          type="date"
                          value={progress.occurred_on}
                          onChange={(e) =>
                            setProgress({
                              ...progress,
                              occurred_on: e.target.value,
                            })
                          }
                        />
                        <textarea
                          aria-label={tr("资料链接")}
                          placeholder={tr("每行一个链接")}
                          value={progress.references}
                          onChange={(e) =>
                            setProgress({
                              ...progress,
                              references: e.target.value,
                            })
                          }
                        />
                      </details>
                      <button
                        type="button"
                        className="primary"
                        disabled={saving || !filled(progress.text)}
                        onClick={publish}
                      >
                        {tr("发布")}{" "}
                        {tr(CATEGORIES[progress.category]) || tr("进展")}
                      </button>
                    </div>
                  )}
                  {updates.map((u) => (
                    <article className="pm-update" key={u.memo.name}>
                      <small>
                        {tr(CATEGORIES[u.data.category]) || tr("未分类")} ·{" "}
                        {validDate(u.data.occurred_on)
                          ? tr("发生于 ") + u.data.occurred_on + tr("")
                          : tr("发生日期未登记")}{" "}
                        {tr(
                          "\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t· 当前记录归属 ",
                        )}
                        {u.memo.creator_name || u.memo.creator}{" "}
                        {tr(" · 保存于 ")}
                        {shortTime(u.memo.create_time)}
                      </small>
                      <p>{show(u.body)}</p>
                      <Issues items={u.issues} />
                      {Array.isArray(u.data.references) &&
                        u.data.references.filter(validUrl).map((link) => (
                          <p key={link}>
                            <a href={link} target="_blank" rel="noreferrer">
                              {tr(
                                "\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t资料链接 ↗\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t",
                              )}
                            </a>
                          </p>
                        ))}
                      {u.memo.can_manage && (
                        <>
                          <button
                            type="button"
                            onClick={() => setMode({ update: u })}
                          >
                            {tr(
                              "\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t修改本人记录\n\t\t\t\t\t\t\t\t\t\t\t\t\t",
                            )}
                          </button>
                          <UploadControl
                            name={tr("本人进展")}
                            disabled={saving || Boolean(uncertain)}
                            busy={
                              saving &&
                              inflightRef.current?.memoName === u.memo.name
                            }
                            error={
                              uploadError?.name === u.memo.name
                                ? uploadError.text
                                : ""
                            }
                            onStart={() => {
                              fileChooserOpen.current = true;
                            }}
                            onChoose={(e) => attachmentChosen(e, u.memo.name)}
                            onCancel={attachmentCancelled}
                          />
                        </>
                      )}
                      <details className="pm-source">
                        <summary>
                          {tr("来源与记录")}
                          <ChevronDownIcon size={15} aria-hidden="true" />
                        </summary>
                        <p>
                          {tr("当前记录归属：")}
                          {u.memo.creator_name || u.memo.creator}{" "}
                          {tr(" · 原始提交者未验证")}
                        </p>
                        <a
                          href={source(u.memo.name)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tr("打开 FlareMo 原记录 ↗")}
                        </a>
                        {u.memo.can_govern === true ? (
                          <button
                            type="button"
                            onClick={() => showHistory(u.memo.name)}
                          >
                            {tr(
                              "\n\t\t\t\t\t\t\t\t\t\t\t\t\t查看可访问的修订\n\t\t\t\t\t\t\t\t\t\t\t\t",
                            )}
                          </button>
                        ) : (
                          <small>
                            {tr("当前身份无权查看这条记录的修订。")}
                          </small>
                        )}
                        {historyName === u.memo.name &&
                          historyState === "loading" && (
                            <p>{tr("修订读取中…")}</p>
                          )}
                        {historyName === u.memo.name &&
                          historyState === "denied" && (
                            <p>{tr("当前身份无权查看修订。")}</p>
                          )}
                        {historyName === u.memo.name &&
                          historyState === "failed" && (
                            <p>{tr("修订读取失败。")}</p>
                          )}
                        {historyName === u.memo.name &&
                          historyState === "ready" && (
                            <div>
                              <p>
                                {tr("仅展示当前账号可访问且原版仍保留的修订。")}
                              </p>
                              {history.length ? (
                                history.map((h) => (
                                  <details key={h.name}>
                                    <summary>
                                      {shortTime(h.create_time)} ·{" "}
                                      {show(h.visibility)} · {h.name}
                                      <ChevronDownIcon
                                        size={15}
                                        aria-hidden="true"
                                      />
                                    </summary>
                                    <pre>{show(h.content)}</pre>
                                  </details>
                                ))
                              ) : (
                                <p>{tr("当前可访问范围内没有保留的修订。")}</p>
                              )}
                            </div>
                          )}
                      </details>
                      {u.memo.attachments?.map((a) => (
                        <button
                          type="button"
                          key={a.name}
                          onClick={() => showAttachment(a, u.memo.name)}
                        >
                          {tr("\n\t\t\t\t\t\t\t\t\t\t\t\t\t预览 ")}
                          {a.filename}
                        </button>
                      ))}
                    </article>
                  ))}
                  {!updates.length && <p>{tr("尚无关联进展。")}</p>}
                </section>
                <section className="pm-card pm-materials">
                  <h2>{tr("资料")}</h2>
                  {detailState === "loading" && (
                    <p>{tr("正在核验原记录权限…")}</p>
                  )}
                  {detailState === "denied" && (
                    <p>{tr("当前身份无法访问原记录。")}</p>
                  )}
                  {detailState === "ready" && (
                    <>
                      {detail.attachments?.map((a) => (
                        <button
                          type="button"
                          key={a.name}
                          onClick={() => showAttachment(a, selected)}
                        >
                          {tr("\n\t\t\t\t\t\t\t\t\t\t\t\t\t预览 ")}
                          {a.filename}
                        </button>
                      ))}
                      {!detail.attachments?.length && (
                        <p>{tr("主记录暂无附件。")}</p>
                      )}
                      {detail.can_manage && (
                        <UploadControl
                          name={tr("项目主记录")}
                          disabled={saving || Boolean(uncertain)}
                          busy={
                            saving && inflightRef.current?.memoName === selected
                          }
                          error={
                            uploadError?.name === selected
                              ? uploadError.text
                              : ""
                          }
                          onStart={() => {
                            fileChooserOpen.current = true;
                          }}
                          onChoose={(e) => attachmentChosen(e, selected)}
                          onCancel={attachmentCancelled}
                        />
                      )}
                    </>
                  )}
                </section>
                <div className="pm-columns">
                  <section className="pm-card">
                    <h2>{tr("当前概况")}</h2>
                    {[
                      [tr("目标"), project.data.goal],
                      [tr("当前情况"), project.data.current_summary],
                      [tr("目标截止日"), project.data.target_due_on],
                      [tr("卡点"), project.data.blocker],
                      [
                        tr("情况确认时间"),
                        project.data.confirmed_at &&
                          shortTime(project.data.confirmed_at),
                      ],
                    ].map(([label, val]) => (
                      <div className="pm-fact" key={label}>
                        <span>{label}</span>
                        <b>
                          {filled(val) ||
                            (label === tr("目标截止日")
                              ? tr("未设截止日")
                              : label === tr("卡点")
                                ? tr("尚未确认")
                                : label === tr("情况确认时间")
                                  ? tr("尚未登记")
                                  : tr("待补充"))}
                        </b>
                      </div>
                    ))}
                    {followupStatus(project, day) && (
                      <p className="pm-due">
                        {tr(followupStatus(project, day))}
                      </p>
                    )}
                  </section>
                  <details className="pm-source">
                    <summary>
                      {tr("来源与记录")}
                      <ChevronDownIcon size={15} aria-hidden="true" />
                    </summary>
                    <p>
                      {tr("记录 ID：")}
                      {selected}
                    </p>
                    <p>
                      {tr("当前记录归属：")}
                      {project.memo.creator_name || project.memo.creator} ·{" "}
                      {ownerStatus(project, me)}
                    </p>
                    <p>
                      {tr("原始提交者未验证 · 确认者未验证 · 原记录最后修改：")}
                      {shortTime(project.memo.update_time)}
                    </p>
                    <a href={source(selected)} target="_blank" rel="noreferrer">
                      {tr("打开 FlareMo 原记录 ↗")}
                    </a>
                    <section className="pm-card">
                      <h2>{tr("阶段说明与原版修订")}</h2>
                      {Array.isArray(project.data.phase_history) &&
                      project.data.phase_history.length ? (
                        project.data.phase_history.map((h) => (
                          <p
                            key={`${h?.recorded_at}-${h?.from}-${h?.to}-${h?.reason}`}
                          >
                            {tr(PHASE_LABELS[h?.from]) || tr("初始")} →{" "}
                            {tr(PHASE_LABELS[h?.to]) || show(h?.to)} ·{" "}
                            {show(h?.reason)} · {shortTime(h?.recorded_at)}
                          </p>
                        ))
                      ) : (
                        <p>{tr("尚无已登记阶段说明。")}</p>
                      )}
                      <button
                        type="button"
                        onClick={() => showHistory(selected)}
                      >
                        {tr(
                          "\n\t\t\t\t\t\t\t\t\t\t\t查看可访问的原版修订\n\t\t\t\t\t\t\t\t\t\t",
                        )}
                      </button>
                      {historyName === selected &&
                        historyState === "loading" && <p>{tr("读取中…")}</p>}
                      {historyName === selected &&
                        historyState === "denied" && (
                          <p>{tr("无权查看他人修订。")}</p>
                        )}
                      {historyName === selected &&
                        historyState === "failed" && (
                          <p>{tr("修订读取失败。")}</p>
                        )}
                      {historyName === selected && historyState === "ready" && (
                        <>
                          <p className="pm-subtle">
                            {tr(
                              "\n\t\t\t\t\t\t\t\t\t\t\t\t\t仅展示当前账号可访问且原版仍保留的修订。原版有最近 50\n\t\t\t\t\t\t\t\t\t\t\t\t\t份的保留阈值。\n\t\t\t\t\t\t\t\t\t\t\t\t",
                            )}
                          </p>
                          {history.length ? (
                            history.map((h) => (
                              <details key={h.name}>
                                <summary>
                                  {shortTime(h.create_time)} · {h.visibility} ·{" "}
                                  {h.name}
                                  <ChevronDownIcon
                                    size={15}
                                    aria-hidden="true"
                                  />
                                </summary>
                                <pre>{h.content}</pre>
                              </details>
                            ))
                          ) : (
                            <p>{tr("当前可访问范围内没有保留的修订。")}</p>
                          )}
                        </>
                      )}
                    </section>
                  </details>
                </div>
                {filled(project.body) && (
                  <section className="pm-card pm-background">
                    <h2>{tr("补充说明")}</h2>
                    <p>{project.body}</p>
                  </section>
                )}
              </>
            ) : selected ? (
              <div>
                <button type="button" onClick={returnToList}>
                  {tr("← 返回总览")}
                </button>
                <p>{tr("该项目当前不可读取或格式已变化。")}</p>
              </div>
            ) : (
              <>
                <div className="pm-title">
                  <div className="pm-title-copy">
                    <small>
                      {tr("团队共享 · 最近同步 ")}
                      {shortTime(synced)}
                    </small>
                    <h1>
                      {filter === "followup"
                        ? tr("需要跟进")
                        : activeNav === "ideas"
                          ? tr("想法")
                          : activeNav === "mine"
                            ? tr("我的项目")
                            : tr("团队项目")}
                    </h1>
                    <p>
                      {tr("当前显示 ")}
                      {visible.length} {tr(" 个项目 · 团队共 ")}
                      {corpus.projects.length} {tr(" 个项目")}
                    </p>
                  </div>
                  {me.role !== "reader" && (
                    <div className="pm-title-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          openCreate("active");
                          navigateTo(appPath("/projects/new"));
                        }}
                      >
                        {tr(
                          "\n\t\t\t\t\t\t\t\t\t\t\t\t新建项目\n\t\t\t\t\t\t\t\t\t\t\t",
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          openCreate("idea");
                          navigateTo(appPath("/ideas/new"));
                        }}
                      >
                        {tr(
                          "\n\t\t\t\t\t\t\t\t\t\t\t\t记录想法\n\t\t\t\t\t\t\t\t\t\t\t",
                        )}
                      </button>
                    </div>
                  )}
                  <button type="button" onClick={() => refresh()}>
                    {tr("刷新")}
                  </button>
                </div>
                <div className="pm-search">
                  <input
                    aria-label={tr("搜索项目名称")}
                    placeholder={tr("搜索项目名称")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="pm-search-field">
                    <span>{tr("负责人")}</span>
                    <SelectMenu
                      ariaLabel={tr("按成员筛选")}
                      value={memberFilter}
                      onChange={setMemberFilter}
                      options={[
                        { value: "all", label: tr("全部成员") },
                        { value: "self", label: tr("我负责的") },
                        ...(memberFilter !== "all" &&
                        memberFilter !== "self" &&
                        !users.some((person) => person.id === memberFilter)
                          ? [
                              {
                                value: memberFilter,
                                label: tr("原成员当前不在名册"),
                              },
                            ]
                          : []),
                        ...users.map((person) => ({
                          value: person.id,
                          label: person.name,
                        })),
                      ]}
                    />
                  </div>
                  <div className="pm-search-field">
                    <span>{tr("状态")}</span>
                    <SelectMenu
                      ariaLabel={tr("按项目状态筛选")}
                      value={phaseFilter}
                      onChange={setPhaseFilter}
                      options={[
                        { value: "", label: tr("当前项目") },
                        { value: "all", label: tr("全部状态") },
                        ...PHASES.map((id) => ({
                          value: id,
                          label: tr(PHASE_LABELS[id]),
                        })),
                      ]}
                    />
                  </div>
                  <details className="pm-filter-panel">
                    <summary>
                      {tr("更多筛选")}
                      <ChevronDownIcon size={15} aria-hidden="true" />
                    </summary>
                    <div className="pm-filter-controls">
                      <div className="pm-filter-field">
                        <span>{tr("查看范围")}</span>
                        <SelectMenu
                          ariaLabel={tr("查看范围")}
                          value={filter}
                          onChange={setFilter}
                          options={[
                            [
                              "current",
                              phaseFilter ? tr("按主状态") : tr("当前项目"),
                            ],
                            ["all", tr("全部状态")],
                            ["followup", tr("需要跟进")],
                            ["maintain", tr("我维护的")],
                            ["ideas", tr("想法")],
                            ["revisit", tr("想法待回看")],
                            ["paused", tr("暂停")],
                            ["ended", tr("已结束")],
                            ["issues", tr("信息待补充")],
                            ["unlinked", tr("负责人未关联")],
                          ].map(([value, label]) => ({ value, label }))}
                        />
                      </div>
                      <label>
                        {tr("负责人姓名\n\t\t\t\t\t\t\t\t\t\t\t\t")}
                        <input
                          aria-label={tr("按负责人姓名筛选")}
                          placeholder={tr("输入姓名")}
                          value={ownerQuery}
                          onChange={(e) => setOwnerQuery(e.target.value)}
                        />
                      </label>
                      <label className="pm-group-toggle">
                        <input
                          type="checkbox"
                          checked={groupByOwner}
                          onChange={(e) => setGroupByOwner(e.target.checked)}
                        />
                        {tr("按负责人分组")}
                      </label>
                    </div>
                  </details>
                </div>
                <div className="pm-active-filters">
                  {!(filter === "current" && phaseFilter) && (
                    <span>
                      {tr("范围：")}
                      {filter === "current"
                        ? tr("待启动与进行中")
                        : filter === "all"
                          ? tr("全部状态")
                          : {
                              followup: tr("需要跟进"),
                              maintain: tr("我维护的"),
                              ideas: tr("想法"),
                              revisit: tr("想法待回看"),
                              paused: tr("暂停"),
                              ended: tr("已结束"),
                              issues: tr("信息待补充"),
                              unlinked: tr("负责人未关联"),
                            }[filter] || tr("当前项目")}
                    </span>
                  )}
                  <span>
                    {tr("负责人：")}
                    {memberFilter === "all"
                      ? tr("全部成员")
                      : memberFilter === "self"
                        ? tr("我负责的")
                        : users.find((person) => person.id === memberFilter)
                            ?.name || tr("原成员当前不在名册")}
                  </span>
                  {phaseFilter && (
                    <span>
                      {tr("状态：")}
                      {phaseFilter === "all"
                        ? tr("全部状态")
                        : tr(PHASE_LABELS[phaseFilter])}
                    </span>
                  )}
                  {query && (
                    <span>
                      {tr("搜索：")}
                      {query}
                    </span>
                  )}
                  {ownerQuery && (
                    <span>
                      {tr("姓名：")}
                      {ownerQuery}
                    </span>
                  )}
                  {groupByOwner && <span>{tr("按负责人分组")}</span>}
                  <button
                    type="button"
                    onClick={() => {
                      setFilter("current");
                      setMemberFilter("all");
                      setPhaseFilter("");
                      setQuery("");
                      setOwnerQuery("");
                      setGroupByOwner(false);
                    }}
                  >
                    {tr("清除条件")}
                  </button>
                </div>
                {usersError && (
                  <p className="pm-subtle">
                    {tr("成员名册暂不可用；项目仍可浏览。")}
                  </p>
                )}
                {filter === "mine" && !visible.length && (
                  <p>
                    {tr(
                      "\n\t\t\t\t\t\t\t\t\t\t暂无已关联到你账号的项目。可查看“负责人未关联”的姓名记录。\n\t\t\t\t\t\t\t\t\t",
                    )}
                  </p>
                )}
                <div className="pm-list">
                  <div className="pm-list-head" aria-hidden="true">
                    <span>{tr("项目")}</span>
                    <span>{tr("负责人")}</span>
                    <span>{tr("状态")}</span>
                    <span>{tr("当前进展")}</span>
                    <span>{tr("下一步")}</span>
                    <span>{tr("跟进时间")}</span>
                  </div>
                  {orderedVisible.map((p, index) => (
                    <Fragment key={p.memo.name}>
                      {groupByOwner &&
                        (index === 0 ||
                          filled(orderedVisible[index - 1].data.owner?.name) !==
                            filled(p.data.owner?.name)) && (
                          <div className="pm-group-heading">
                            {filled(p.data.owner?.name) || tr("负责人未登记")}
                          </div>
                        )}
                      <button
                        type="button"
                        className="pm-project"
                        onClick={() => navigateTo(projectUrl(p.memo.name))}
                      >
                        <div
                          className="pm-cell pm-project-name"
                          data-label={tr("项目")}
                        >
                          <strong>{projectTitle(p)}</strong>
                          {!filled(p.data.name) && (
                            <small>
                              {tr("编号 ")}
                              {shortId(p.memo.name)}
                            </small>
                          )}
                          {p.issues.length > 0 && (
                            <small className="pm-row-issue">
                              {tr("待补充 ")}
                              {p.issues.length} {tr(" 项")}
                            </small>
                          )}
                        </div>
                        <span className="pm-cell" data-label={tr("负责人")}>
                          {show(p.data.owner?.name)}
                        </span>
                        <span className="pm-cell" data-label={tr("状态")}>
                          <span className={`pm-phase pm-phase-${p.data.phase}`}>
                            {tr(PHASE_LABELS[p.data.phase])}
                          </span>
                        </span>
                        <span className="pm-cell" data-label={tr("当前进展")}>
                          {show(p.data.current_summary)}
                        </span>
                        <span className="pm-cell" data-label={tr("下一步")}>
                          {filled(p.data.next_action) ||
                            (p.data.phase === "active"
                              ? tr("待补充")
                              : tr("未安排"))}
                        </span>
                        <span
                          className="pm-cell"
                          data-label={tr("跟进时间")}
                          title={
                            validDate(p.data.next_check_on)
                              ? p.data.next_check_on
                              : undefined
                          }
                        >
                          {validDate(p.data.next_check_on) ? (
                            <>
                              <span className="sr-only">
                                {p.data.next_check_on}
                              </span>
                              <span className="pm-date-full" aria-hidden="true">
                                {p.data.next_check_on}
                              </span>
                              <span
                                className="pm-date-short"
                                aria-hidden="true"
                              >
                                {p.data.next_check_on
                                  .slice(5)
                                  .replace("-", "/")}
                              </span>
                            </>
                          ) : p.data.phase === "idea" ? (
                            tr("未安排跟进")
                          ) : (
                            tr("待补充")
                          )}{" "}
                          {followupStatus(p, day) && (
                            <b className="pm-due">
                              {tr(followupStatus(p, day))}
                            </b>
                          )}
                          {p.data.phase === "idea" &&
                            validDate(p.data.idea_review_on) &&
                            p.data.idea_review_on <= day && (
                              <b className="pm-due">{tr("想法待回看")}</b>
                            )}
                          {validDate(p.data.target_due_on) && (
                            <small>
                              {tr("目标截止：")}
                              {p.data.target_due_on}
                            </small>
                          )}
                        </span>
                      </button>
                    </Fragment>
                  ))}
                  {!visible.length && filter !== "mine" && (
                    <p>{tr("当前筛选没有项目。")}</p>
                  )}
                </div>
                {(corpus.errors.length > 0 || corpus.orphans.length > 0) && (
                  <details className="pm-exceptions">
                    <summary>
                      {tr("记录需处理 · ")}
                      {corpus.errors.length + corpus.orphans.length}
                      <ChevronDownIcon size={15} aria-hidden="true" />
                    </summary>
                    {corpus.errors.length > 0 && (
                      <section className="pm-card">
                        <h2>
                          {tr("格式异常 · ")}
                          {corpus.errors.length}
                        </h2>
                        {corpus.errors.map((x) => (
                          <p key={x.memo.name}>
                            {tr(x.reason)} ·{" "}
                            <a
                              href={source(x.memo.name)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {tr("\n\t\t\t\t\t\t\t\t\t\t\t\t\t查看原记录 ")}
                              {x.memo.name}
                            </a>
                          </p>
                        ))}
                      </section>
                    )}
                    {corpus.orphans.length > 0 && (
                      <section className="pm-card">
                        <h2>
                          {tr("关联待处理 · ")}
                          {corpus.orphans.length}
                        </h2>
                        {corpus.orphans.map((x) => (
                          <p key={x.memo.name}>
                            {x.memo.name} → {show(x.data.project_ref)} ·{" "}
                            <a
                              href={source(x.memo.name)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {tr(
                                "\n\t\t\t\t\t\t\t\t\t\t\t\t\t查看原记录\n\t\t\t\t\t\t\t\t\t\t\t\t",
                              )}
                            </a>
                          </p>
                        ))}
                      </section>
                    )}
                  </details>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {preview && (
        <div
          className="pm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={tr("附件预览")}
          ref={mode ? null : modalElement}
          onKeyDown={onModalKeyDown}
        >
          <div className="pm-dialog">
            <button type="button" onClick={closePreview}>
              {tr("关闭")}
            </button>
            <h2>{preview.filename}</h2>
            {preview.state === "loading" ? (
              <p>{tr("正在重新验证附件及原记录权限…")}</p>
            ) : preview.state === "failed" ? (
              <p>{tr("权限待验证，无法预览。")}</p>
            ) : preview.type?.startsWith("image/") ? (
              <img
                className="pm-image"
                src={preview.url}
                alt={preview.filename}
              />
            ) : (
              <a href={preview.url} download={preview.filename}>
                {tr("\n\t\t\t\t\t\t\t\t下载已验证文件\n\t\t\t\t\t\t\t")}
              </a>
            )}
          </div>
        </div>
      )}
      {mode && state === "ready" && (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: This wrapper is an interactive dialog only for a personal-update modal; the project form is a normal page.
        <div
          className={typeof mode === "object" ? "pm-overlay" : "pm-edit-page"}
          role={typeof mode === "object" ? "dialog" : undefined}
          aria-modal={typeof mode === "object" ? "true" : undefined}
          aria-label={typeof mode === "object" ? tr("修改本人记录") : undefined}
          ref={typeof mode === "object" ? modalElement : undefined}
          onKeyDown={typeof mode === "object" ? onModalKeyDown : undefined}
        >
          <div
            className={
              typeof mode === "object"
                ? "pm-dialog pm-form"
                : "pm-edit-surface pm-form"
            }
          >
            <button
              type="button"
              className="pm-close"
              onClick={() => {
                if (typeof mode === "object") setMode(null);
                else if (mode === "edit") {
                  setMode(null);
                  navigateTo(projectUrl(selected));
                } else {
                  setMode(null);
                  returnToList();
                }
              }}
            >
              {typeof mode === "object" ? tr("关闭") : tr("← 返回")}
            </button>
            {typeof mode === "object" ? (
              <OwnUpdate
                update={mode.update}
                saving={saving}
                save={saveOwnUpdate}
              />
            ) : (
              <>
                <h2>
                  {mode === "create"
                    ? tr("新建项目或想法")
                    : tr("编辑项目信息")}
                </h2>
                {formError?.summary && (
                  <div
                    className="pm-form-error"
                    role="alert"
                    tabIndex={-1}
                    ref={formErrorRef}
                  >
                    <strong>{tr("请检查表单")}</strong>
                    <p>{formError.summary}</p>
                  </div>
                )}
                {[
                  ["name", tr("项目名称")],
                  ["phase", tr("项目阶段")],
                  ["ownerName", tr("负责人")],
                  ["goal", tr("目标 / 预期结果")],
                  ["current_summary", tr("当前情况")],
                  ["next_action", tr("下一步动作")],
                  ["next_check_on", tr("下次跟进日期")],
                  ["target_due_on", tr("目标截止日期")],
                  ["idea_review_on", tr("想法回看日期")],
                  ["blocker", tr("当前卡点")],
                ].map(([key, label]) => (
                  <div
                    key={key}
                    className={`pm-field pm-field-${key} ${formError?.fields[key] ? "pm-field-invalid" : ""}`}
                  >
                    <span className="pm-field-label">
                      {label}
                      <small>
                        {requirement(key, form, mode, editBase.current)}
                      </small>
                    </span>
                    {key === "ownerName" ? (
                      <SelectMenu
                        ariaLabel={tr("负责人")}
                        required={
                          requirement(key, form, mode, editBase.current) ===
                          tr("必填")
                        }
                        invalid={Boolean(formError?.fields[key])}
                        describedBy={
                          formError?.fields[key] ? `pm-error-${key}` : undefined
                        }
                        value={form.ownerId || (form.ownerName ? "legacy" : "")}
                        onChange={(value) => {
                          if (value === "legacy") return;
                          const person = users.find(
                            (item) => item.id === value,
                          );
                          setForm((old) => ({
                            ...old,
                            ownerId: person?.id || "",
                            ownerName: person?.name || "",
                          }));
                          setFormError(null);
                        }}
                        options={[
                          { value: "", label: tr("未指定") },
                          ...(form.ownerName && !form.ownerId
                            ? [
                                {
                                  value: "legacy",
                                  label:
                                    tr("原记录：") +
                                    form.ownerName +
                                    tr("（未关联）"),
                                },
                              ]
                            : []),
                          ...(form.ownerId &&
                          !users.some((person) => person.id === form.ownerId)
                            ? [
                                {
                                  value: form.ownerId,
                                  label: tr("原负责人目前不在名册"),
                                },
                              ]
                            : []),
                          ...users.map((person) => ({
                            value: person.id,
                            label: person.name,
                          })),
                        ]}
                      />
                    ) : key === "phase" ? (
                      <SelectMenu
                        ariaLabel={label}
                        required={
                          requirement(key, form, mode, editBase.current) ===
                          tr("必填")
                        }
                        describedBy={
                          formError?.fields[key] ? `pm-error-${key}` : undefined
                        }
                        value={form.phase}
                        invalid={Boolean(formError?.fields[key])}
                        onChange={(value) => updateForm("phase", value)}
                        options={(mode === "create"
                          ? ["idea", "planned", "active"]
                          : NEXT_PHASES[editBase.current?.phase] || PHASES
                        ).map((value) => ({
                          value,
                          label: tr(PHASE_LABELS[value]),
                        }))}
                      />
                    ) : [
                        "next_check_on",
                        "target_due_on",
                        "idea_review_on",
                      ].includes(key) ? (
                      <input
                        aria-label={label}
                        required={
                          requirement(key, form, mode, editBase.current) ===
                          tr("必填")
                        }
                        aria-describedby={
                          formError?.fields[key] ? `pm-error-${key}` : undefined
                        }
                        type="date"
                        value={form[key]}
                        aria-invalid={Boolean(formError?.fields[key])}
                        onChange={(e) => updateForm(key, e.target.value)}
                      />
                    ) : (
                      <input
                        aria-label={label}
                        required={
                          requirement(key, form, mode, editBase.current) ===
                          tr("必填")
                        }
                        aria-describedby={
                          formError?.fields[key] ? `pm-error-${key}` : undefined
                        }
                        value={form[key]}
                        aria-invalid={Boolean(formError?.fields[key])}
                        onChange={(e) => updateForm(key, e.target.value)}
                      />
                    )}
                    {formError?.fields[key] && (
                      <small className="pm-field-error" id={`pm-error-${key}`}>
                        {formError.fields[key]}
                      </small>
                    )}
                  </div>
                ))}
                {usersError && (
                  <p>
                    {tr(
                      "成员名册暂不可用；可继续查看项目，暂时无法变更负责人。",
                    )}
                  </p>
                )}
                {mode === "edit" && form.phase !== editBase.current?.phase && (
                  <label
                    className={
                      formError?.fields.reason ? "pm-field-invalid" : ""
                    }
                  >
                    <span className="pm-field-label">
                      {tr("阶段变化原因 / 结果")}
                      <small>
                        {needsPhaseReason(form, mode, editBase.current)
                          ? tr("必填")
                          : tr("可选")}
                      </small>
                    </span>
                    <textarea
                      aria-label={tr("阶段变化原因 / 结果")}
                      aria-required={needsPhaseReason(
                        form,
                        mode,
                        editBase.current,
                      )}
                      aria-describedby={
                        formError?.fields.reason ? "pm-error-reason" : undefined
                      }
                      value={form.reason}
                      aria-invalid={Boolean(formError?.fields.reason)}
                      onChange={(e) => updateForm("reason", e.target.value)}
                    />
                    {formError?.fields.reason && (
                      <small className="pm-field-error" id="pm-error-reason">
                        {formError.fields.reason}
                      </small>
                    )}
                  </label>
                )}
                {mode === "edit" && (
                  <label className="pm-check">
                    <input
                      type="checkbox"
                      checked={form.confirmNow}
                      onChange={(e) =>
                        setForm({ ...form, confirmNow: e.target.checked })
                      }
                    />
                    {tr(
                      "\n\t\t\t\t\t\t\t\t\t\t我已核对当前情况，登记确认时间\n\t\t\t\t\t\t\t\t\t",
                    )}
                  </label>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={saving}
                  onClick={saveProject}
                >
                  {saving ? tr("保存中…") : tr("保存")}
                </button>
                <p>
                  {tr("负责人负责业务推进；项目编辑权限按当前记录归属判断。")}
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {uncertain && (
        <div className="pm-pending">
          {tr(
            "\n\t\t\t\t\t有一笔保存结果待确认。先刷新核对；需要重试时复用同一提交标识。\n\t\t\t\t\t",
          )}
          <button type="button" onClick={refresh}>
            {tr("刷新核对")}
          </button>
          <button
            type="button"
            onClick={retryPending}
            disabled={state !== "ready" || saving}
          >
            {tr("\n\t\t\t\t\t\t核对后同次重试\n\t\t\t\t\t")}
          </button>
        </div>
      )}
    </div>
  );
}
function OwnUpdate({ update, saving, save }) {
  const [text, setText] = useState(update.body);
  return (
    <>
      <h2>{tr("修改本人记录")}</h2>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        className="primary"
        disabled={saving || !filled(text)}
        onClick={() => save(update, text)}
      >
        {tr("\n\t\t\t\t保存修改\n\t\t\t")}
      </button>
    </>
  );
}
