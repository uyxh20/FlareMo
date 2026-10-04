// Installer: init / doctor / uninstall / update. Every mutating step backs up
// the original into backup/<harness>/ first and is safe to re-run.
// Harness homes are env-overridable (ZCODE_HOME / CODEX_HOME / GEMINI_HOME /
// AGENTS_HOME / FLAREMO_BIN_DIR) so tests never touch the real machine.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveCredentials } from "./credentials.mjs";
import { runImport } from "./importer.mjs";
import {
  agentsHome,
  backupDir,
  checkoutRoot,
  codexHome,
  flaremoBinDir,
  flaremoHome,
  geminiHome,
  hookWrapperPath,
  piHome,
  zcodeHome,
} from "./paths.mjs";

export const PLUGIN_NAME = "flaremo-memory";
export const MARKETPLACE_NAME = "flaremo";

const noop = () => {};

// --- primitives --------------------------------------------------------------

function backupOnce(home, harness, srcPath, backupName, log) {
  const dest = join(backupDir(home), harness, backupName);
  if (existsSync(dest)) return dest; // first backup wins — never overwrite it
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(srcPath, dest);
  log(`    备份原件 → ${dest}`);
  return dest;
}

/** Move-aside backup for files we edit in place (keep original, edit copy). */
function backupCopyOnce(home, harness, srcPath, backupName, log) {
  const dest = join(backupDir(home), harness, backupName);
  if (existsSync(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcPath, dest);
  log(`    备份原件 → ${dest}`);
  return dest;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function ensureSymlink(
  linkPath,
  target,
  { log = noop, dryRun = false, home, backupTag } = {},
) {
  let stat = null;
  try {
    stat = lstatSync(linkPath);
  } catch {}
  if (stat?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === target) {
      log(`    已是软链 ${linkPath} → ${target}`);
      return true;
    }
    if (!dryRun) {
      rmSync(linkPath);
      symlinkSync(target, linkPath);
    }
    log(`    重指软链 ${linkPath} → ${target}`);
    return true;
  }
  if (stat) {
    // Real file/dir in the way — back it up, never clobber.
    if (dryRun) {
      log(`    将备份现有 ${linkPath} 并建立软链 → ${target}`);
      return true;
    }
    backupOnce(
      home,
      backupTag ?? "misc",
      linkPath,
      `${linkPath.split("/").pop()}-replaced`,
      log,
    );
    symlinkSync(target, linkPath);
    log(`    软链 ${linkPath} → ${target}`);
    return true;
  }
  if (dryRun) {
    log(`    将建立软链 ${linkPath} → ${target}`);
    return true;
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  log(`    软链 ${linkPath} → ${target}`);
  return true;
}

function writeHookWrapper(home, { log = noop, dryRun = false } = {}) {
  const path = hookWrapperPath(home);
  const cli = join(checkoutRoot(), "bin", "flaremo");
  const body = `#!/bin/sh\nexec "${process.execPath}" "${cli}" hook "$@"\n`;
  if (existsSync(path) && readFileSync(path, "utf-8") === body) {
    log(`    flaremo-hook 已是最新`);
    return;
  }
  if (dryRun) {
    log(`    将写入 ${path}（exec ${process.execPath} ${cli} hook "$@"）`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  log(`    写入 ${path}`);
}

// --- codex config.toml [memories] edit --------------------------------------

/**
 * Minimal line edit: set generate_memories/use_memories inside the [memories]
 * table (create it if missing); everything else in the file is left byte-for-
 * byte untouched.
 */
export function setTomlMemoriesDisabled(text) {
  const lines = text.split("\n");
  const out = [];
  let inMem = false;
  let seenMem = false;
  const want = { generate_memories: false, use_memories: false };
  const wrote = new Set();
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      if (inMem) {
        for (const [k, v] of Object.entries(want)) {
          if (!wrote.has(k)) out.push(`${k} = ${v}`);
        }
      }
      inMem = header[1].trim() === "memories";
      if (inMem) seenMem = true;
      out.push(line);
      continue;
    }
    if (inMem) {
      const kv = line.match(/^\s*(generate_memories|use_memories)\s*=/);
      if (kv) {
        out.push(`${kv[1]} = false`);
        wrote.add(kv[1]);
        continue;
      }
    }
    out.push(line);
  }
  if (inMem) {
    for (const [k, v] of Object.entries(want)) {
      if (!wrote.has(k)) out.push(`${k} = ${v}`);
    }
  }
  if (!seenMem) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push("[memories]", "generate_memories = false", "use_memories = false");
  }
  return out.join("\n");
}

export function tomlMemoriesState(text) {
  const state = { generate_memories: null, use_memories: null };
  let inMem = false;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inMem = header[1].trim() === "memories";
      continue;
    }
    if (inMem) {
      const kv = line.match(/^\s*(generate_memories|use_memories)\s*=\s*(\w+)/);
      if (kv) state[kv[1]] = kv[2];
    }
  }
  return state;
}

// --- detection ---------------------------------------------------------------

export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  try {
    const out = execFileSync("which", ["codex"], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out) return out;
  } catch {}
  const appBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(appBin) ? appBin : null;
}

export function detectHarnesses(env = process.env) {
  const found = [];
  if (existsSync(zcodeHome(env))) found.push("zcode");
  if (existsSync(codexHome(env)) || resolveCodexBin(env)) found.push("codex");
  if (existsSync(join(geminiHome(env), "config"))) found.push("antigravity");
  if (existsSync(piHome(env))) found.push("pi");
  return found;
}

function zcodeRunning() {
  try {
    execFileSync("pgrep", ["-x", "ZCode"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function marketplaceName(checkout) {
  const m = readJsonFile(
    join(checkout, "harness", ".agents", "plugins", "marketplace.json"),
  );
  return m?.name || MARKETPLACE_NAME;
}

// --- init ---------------------------------------------------------------------

export async function initCmd({
  env = process.env,
  home = flaremoHome(env),
  harnesses = null,
  dryRun = false,
  log = console.log,
} = {}) {
  const checkout = checkoutRoot();
  const targets = harnesses ?? detectHarnesses(env);
  log(`FlareMo init${dryRun ? "（dry-run，只打印计划）" : ""}`);
  log(`检出目录: ${checkout}`);
  log(`状态目录: ${home}`);
  log(
    `目标 Harness: ${targets.length ? targets.join(", ") : "（未探测到，仅装 CLI 与 skill）"}`,
  );

  // 1. state home + hook wrapper + PATH symlink
  if (!dryRun) {
    for (const d of ["bin", "cache", "outbox", "sessions", "backup"]) {
      mkdirSync(join(home, d), { recursive: true });
    }
  }
  log(`\n[1] 本地状态与 CLI`);
  writeHookWrapper(home, { log, dryRun });
  ensureSymlink(
    join(flaremoBinDir(env), "flaremo"),
    join(checkout, "bin", "flaremo"),
    {
      log,
      dryRun,
      home,
      backupTag: "cli",
    },
  );
  ensureSymlink(
    join(agentsHome(env), "skills", PLUGIN_NAME),
    join(checkout, "skills", PLUGIN_NAME),
    { log, dryRun, home, backupTag: "agents" },
  );

  // 2. per-harness wiring; import BEFORE disabling native memory
  for (const harness of targets) {
    log(`\n[${harness}]`);
    if (harness === "zcode")
      await initZcode({ env, home, checkout, dryRun, log });
    if (harness === "codex")
      await initCodex({ env, home, checkout, dryRun, log });
    if (harness === "antigravity")
      await initAntigravity({ env, home, checkout, dryRun, log });
    if (harness === "pi") await initPi({ env, home, checkout, dryRun, log });
  }

  if (!dryRun) {
    const cred = resolveCredentials(env, home);
    if (!cred.pat) {
      log(
        `\n⚠️ 尚未配置凭据：运行 flaremo login --url <实例地址>（PAT 从 stdin 读入）。`,
      );
    }
    log(`\n完成。自检: flaremo doctor`);
  }
}

async function initZcode({ env, home, checkout, dryRun, log }) {
  const pluginDir = join(checkout, "harness", "zcode");
  const configPath = join(zcodeHome(env), "cli", "config.json");
  const settingPath = join(zcodeHome(env), "v2", "setting.json");

  const config = readJsonFile(configPath) ?? {};
  const dirs = config.plugins?.dirs ?? [];
  if (dirs.includes(pluginDir)) {
    log(`    plugins.dirs 已包含 ${pluginDir}`);
  } else if (dryRun) {
    log(`    将向 ${configPath} 的 plugins.dirs 添加 ${pluginDir}`);
  } else {
    if (existsSync(configPath))
      backupCopyOnce(home, "zcode", configPath, "cli-config.json", log);
    const next = {
      ...config,
      plugins: { ...config.plugins, dirs: [...dirs, pluginDir] },
    };
    writeJsonAtomic(configPath, next);
    log(`    plugins.dirs += ${pluginDir}（目录源插件默认启用）`);
  }

  // 搬家 before 关闭原生记忆
  const imported = await runImport("zcode", { apply: !dryRun, env, home });
  if (dryRun) {
    log(`    将导入原生记忆 ${imported.total} 条（dry-run 未发送）`);
  } else {
    log(
      `    原生记忆导入: ${imported.sent}/${imported.total} 条已入账${imported.skipped.length ? `，跳过 ${imported.skipped.length}` : ""}`,
    );
  }
  if (imported.unreachable) {
    log(`    ⚠️ 记忆服务不可达，搬家未完成——暂不关闭原生记忆`);
    return;
  }

  const setting = readJsonFile(settingPath);
  if (setting && setting.memoryEnabled === false) {
    log(`    memoryEnabled 已是 false`);
  } else if (dryRun) {
    log(`    将设置 ${settingPath} 的 memoryEnabled=false`);
  } else {
    if (existsSync(settingPath))
      backupCopyOnce(home, "zcode", settingPath, "v2-setting.json", log);
    writeJsonAtomic(settingPath, { ...(setting ?? {}), memoryEnabled: false });
    log(`    memoryEnabled → false`);
    if (zcodeRunning()) {
      log(
        `    ⚠️ 检测到 ZCode 正在运行，它可能把设置写回——若被覆盖请退出 ZCode 后重跑 init`,
      );
    }
  }
}

async function initCodex({ env, home, checkout, dryRun, log }) {
  const codex = resolveCodexBin(env);
  const marketplace = marketplaceName(checkout);
  if (!codex) {
    log(`    ⚠️ 未找到 codex 可执行文件（PATH 或 ChatGPT.app），跳过插件安装`);
  } else if (dryRun) {
    log(
      `    将执行: ${codex} plugin marketplace add ${join(checkout, "harness")}`,
    );
    log(`    将执行: ${codex} plugin add ${PLUGIN_NAME}@${marketplace}`);
  } else {
    for (const args of [
      ["plugin", "marketplace", "add", join(checkout, "harness")],
      ["plugin", "add", `${PLUGIN_NAME}@${marketplace}`],
    ]) {
      const r = spawnSync(codex, args, { encoding: "utf-8", timeout: 30_000 });
      const ok = r.status === 0;
      log(
        `    ${ok ? "✅" : "⚠️"} codex ${args.join(" ")}${ok ? "" : ` → ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`}`,
      );
    }
  }

  const imported = await runImport("codex", { apply: !dryRun, env, home });
  if (dryRun) {
    log(`    将导入原生记忆 ${imported.total} 条（dry-run 未发送）`);
  } else {
    log(
      `    原生记忆导入: ${imported.sent}/${imported.total} 条已入账${imported.skipped.length ? `，跳过 ${imported.skipped.length}` : ""}`,
    );
  }
  if (imported.unreachable) {
    log(`    ⚠️ 记忆服务不可达，搬家未完成——暂不关闭原生记忆`);
    return;
  }

  const tomlPath = join(codexHome(env), "config.toml");
  const cur = existsSync(tomlPath) ? readFileSync(tomlPath, "utf-8") : "";
  const next = setTomlMemoriesDisabled(cur);
  if (next === cur) {
    log(`    config.toml [memories] 已关闭`);
  } else if (dryRun) {
    log(
      `    将在 ${tomlPath} 的 [memories] 中设置 generate_memories=false / use_memories=false`,
    );
  } else {
    if (existsSync(tomlPath))
      backupCopyOnce(home, "codex", tomlPath, "config.toml", log);
    writeFileSync(tomlPath, next, "utf-8");
    log(`    config.toml [memories] → 已关闭`);
  }

  const rulesPath = join(codexHome(env), "rules", "flaremo.rules");
  const rulesBody = 'prefix_rule(pattern=["flaremo"], decision="allow")\n';
  if (existsSync(rulesPath) && readFileSync(rulesPath, "utf-8") === rulesBody) {
    log(`    rules/flaremo.rules 已存在`);
  } else if (dryRun) {
    log(`    将写入 ${rulesPath}：${rulesBody.trim()}`);
  } else {
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, rulesBody, "utf-8");
    log(`    写入 ${rulesPath}（flaremo 命令免审批）`);
  }

  log(
    `    人工动作：在 codex CLI 中运行 /hooks，信任 flaremo-memory 的 hook 定义（一次性）`,
  );
}

async function initAntigravity({ env, home, checkout, dryRun, log }) {
  ensureSymlink(
    join(geminiHome(env), "config", "plugins", PLUGIN_NAME),
    join(checkout, "harness", "antigravity"),
    { log, dryRun, home, backupTag: "antigravity" },
  );
}

async function initPi({ env, home, checkout, dryRun, log }) {
  // The extension is a thin lifecycle shim; all memory semantics live in the
  // shared CLI it shells out to.
  ensureSymlink(
    join(piHome(env), "extensions", "flaremo-memory.ts"),
    join(checkout, "harness", "pi", "flaremo-memory.ts"),
    { log, dryRun, home, backupTag: "pi" },
  );

  // 搬家 before 关闭原生记忆
  const imported = await runImport("pi", { apply: !dryRun, env, home });
  if (dryRun) {
    log(`    将导入 pi-hermes 原生记忆 ${imported.total} 条（dry-run 未发送）`);
  } else {
    log(
      `    原生记忆导入: ${imported.sent}/${imported.total} 条已入账${imported.skipped.length ? `，跳过 ${imported.skipped.length}` : ""}`,
    );
  }
  if (imported.unreachable) {
    log(`    ⚠️ 记忆服务不可达，搬家未完成——暂不摘除 pi-hermes-memory`);
    return;
  }

  const settingsPath = join(piHome(env), "settings.json");
  const settings = readJsonFile(settingsPath);
  const packages = settings?.packages;
  if (!Array.isArray(packages) || !packages.includes("npm:pi-hermes-memory")) {
    log(`    settings.json 中未启用 pi-hermes-memory`);
  } else if (dryRun) {
    log(`    将从 ${settingsPath} 的 packages 移除 npm:pi-hermes-memory`);
  } else {
    backupCopyOnce(home, "pi", settingsPath, "settings.json", log);
    writeJsonAtomic(settingsPath, {
      ...settings,
      packages: packages.filter((p) => p !== "npm:pi-hermes-memory"),
    });
    log(
      `    settings.json → 已摘除 npm:pi-hermes-memory（数据文件保留在 ~/.pi/agent/pi-hermes-memory）`,
    );
  }
  log(`    人工动作：在 pi 中运行 /reload（或重启会话）加载扩展`);
}

// --- doctor -------------------------------------------------------------------

export async function doctorCmd({
  env = process.env,
  home = flaremoHome(env),
  log = console.log,
} = {}) {
  const checkout = checkoutRoot();
  let problems = 0;
  log("FlareMo doctor\n");

  const cred = resolveCredentials(env, home);
  log(`1) 实例 URL: ${cred.url}（来源: ${cred.source}）`);
  if (!cred.pat) {
    log(`2) 凭据: ❌ 无 PAT（flaremo login --url <实例地址>）`);
    problems += 1;
  } else {
    log(`2) 凭据: ✅ PAT 已配置（来源: ${cred.source}）`);
  }

  try {
    const res = await fetch(`${cred.url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    log(
      `3) 连通性: ${res.ok ? "✅ 服务可达" : `⚠️ /healthz 返回 ${res.status}`}`,
    );
  } catch (error) {
    log(
      `3) 连通性: ❌ 无法连接 (${error instanceof Error ? error.message : error})`,
    );
    problems += 1;
  }

  try {
    const res = await fetch(`${cred.url.replace(/\/+$/, "")}/memory/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cred.pat ? { Authorization: `Bearer ${cred.pat}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401 || res.status === 403) {
      log(`4) 鉴权: ❌ PAT 无效或已过期`);
      problems += 1;
    } else {
      const data = await res.json().catch(() => null);
      const n = Array.isArray(data?.result?.tools)
        ? data.result.tools.length
        : "?";
      log(`4) 鉴权: ✅ PAT 有效（${n} 个记忆工具）`);
    }
  } catch (error) {
    log(
      `4) 鉴权: ❌ 校验失败 (${error instanceof Error ? error.message : error})`,
    );
    problems += 1;
  }

  let n = 5;
  // zcode
  const zcodeCfg = readJsonFile(join(zcodeHome(env), "cli", "config.json"));
  const zPluginDir = join(checkout, "harness", "zcode");
  const zOk = (zcodeCfg?.plugins?.dirs ?? []).includes(zPluginDir);
  const zSetting = readJsonFile(join(zcodeHome(env), "v2", "setting.json"));
  log(
    `${n++}) ZCode: ${existsSync(zcodeHome(env)) ? (zOk ? "✅ 插件目录已注册" : "⚠️ plugins.dirs 未包含 harness/zcode") : "ℹ️ 未安装"}；原生记忆 memoryEnabled=${zSetting?.memoryEnabled ?? "?"}`,
  );
  if (existsSync(zcodeHome(env)) && !zOk) problems += 1;

  // codex
  const codexCfg = existsSync(join(codexHome(env), "config.toml"))
    ? readFileSync(join(codexHome(env), "config.toml"), "utf-8")
    : "";
  const memState = tomlMemoriesState(codexCfg);
  const codexPluginCache = join(codexHome(env), "plugins", "cache");
  let codexInstalled = false;
  try {
    codexInstalled = readdirSync(codexPluginCache).some((m) =>
      existsSync(join(codexPluginCache, m, PLUGIN_NAME)),
    );
  } catch {}
  log(
    `${n++}) Codex: ${existsSync(codexHome(env)) ? (codexInstalled ? "✅ 插件已安装" : "⚠️ 插件缓存中未见 flaremo-memory（codex plugin list 可复核）") : "ℹ️ 未安装"}；原生记忆 generate_memories=${memState.generate_memories ?? "?"} use_memories=${memState.use_memories ?? "?"}`,
  );
  if (existsSync(codexHome(env))) {
    log(`    提示：codex 插件 hook 需在 CLI 内 /hooks 信任一次`);
  }

  // antigravity
  const agyLink = join(geminiHome(env), "config", "plugins", PLUGIN_NAME);
  let agyOk = false;
  try {
    agyOk =
      lstatSync(agyLink).isSymbolicLink() || lstatSync(agyLink).isDirectory();
  } catch {}
  log(
    `${n++}) Antigravity: ${existsSync(join(geminiHome(env), "config")) ? (agyOk ? "✅ 插件已挂载" : "⚠️ ~/.gemini/config/plugins/flaremo-memory 缺失") : "ℹ️ 未安装"}`,
  );

  // pi
  const piLink = join(piHome(env), "extensions", "flaremo-memory.ts");
  let piOk = false;
  try {
    piOk = lstatSync(piLink).isSymbolicLink() || lstatSync(piLink).isFile();
  } catch {}
  const piSettings = readJsonFile(join(piHome(env), "settings.json"));
  const hermesOn =
    Array.isArray(piSettings?.packages) &&
    piSettings.packages.includes("npm:pi-hermes-memory");
  log(
    `${n++}) Pi: ${existsSync(piHome(env)) ? (piOk ? "✅ 扩展已挂载" : "⚠️ ~/.pi/agent/extensions/flaremo-memory.ts 缺失") : "ℹ️ 未安装"}；pi-hermes-memory ${hermesOn ? "仍在启用" : "已摘除/未启用"}`,
  );
  if (existsSync(piHome(env))) {
    if (!piOk) problems += 1;
    if (hermesOn)
      log(`    提示：pi-hermes-memory 仍在启用，双记忆系统并存会互相污染`);
  }

  // hook wrapper + PATH symlink
  const wrapperOk = existsSync(hookWrapperPath(home));
  const binLink = join(flaremoBinDir(env), "flaremo");
  let binOk = false;
  try {
    binOk = lstatSync(binLink).isSymbolicLink();
  } catch {}
  log(
    `${n++}) 本地: ${wrapperOk ? "✅" : "❌"} flaremo-hook；${binOk ? "✅" : "❌"} ${binLink} 软链`,
  );
  if (!wrapperOk || !binOk) problems += 1;

  log(problems === 0 ? "\n全部就绪。" : `\n${problems} 项需要处理。`);
  return problems;
}

// --- uninstall ------------------------------------------------------------------

export async function uninstallCmd({
  env = process.env,
  home = flaremoHome(env),
  harnesses = null,
  dryRun = false,
  log = console.log,
} = {}) {
  const targets = harnesses ?? detectHarnesses(env);
  log(`FlareMo uninstall${dryRun ? "（dry-run）" : ""}`);

  const restore = (harness, backupName, destPath) => {
    const bak = join(backupDir(home), harness, backupName);
    if (!existsSync(bak)) {
      log(`    ${destPath}：无备份可还原，跳过`);
      return;
    }
    if (dryRun) {
      log(`    将还原 ${destPath} ← ${bak}`);
      return;
    }
    copyFileSync(bak, destPath);
    log(`    已还原 ${destPath}`);
  };

  for (const harness of targets) {
    log(`\n[${harness}]`);
    if (harness === "zcode") {
      const configPath = join(zcodeHome(env), "cli", "config.json");
      restore("zcode", "cli-config.json", configPath);
      restore(
        "zcode",
        "v2-setting.json",
        join(zcodeHome(env), "v2", "setting.json"),
      );
    }
    if (harness === "codex") {
      const codex = resolveCodexBin(env);
      if (codex && !dryRun) {
        for (const args of [
          ["plugin", "remove", PLUGIN_NAME],
          ["plugin", "marketplace", "remove", marketplaceName(checkoutRoot())],
        ]) {
          const r = spawnSync(codex, args, {
            encoding: "utf-8",
            timeout: 30_000,
          });
          log(
            `    codex ${args.join(" ")} → ${r.status === 0 ? "✅" : `⚠️ ${(r.stderr || "").slice(0, 160)}`}`,
          );
        }
      } else if (codex) {
        log(
          `    将执行 codex plugin remove ${PLUGIN_NAME} / marketplace remove ${marketplaceName(checkoutRoot())}`,
        );
      }
      restore("codex", "config.toml", join(codexHome(env), "config.toml"));
      const rulesPath = join(codexHome(env), "rules", "flaremo.rules");
      if (existsSync(rulesPath)) {
        if (dryRun) log(`    将删除 ${rulesPath}`);
        else {
          rmSync(rulesPath);
          log(`    已删除 ${rulesPath}`);
        }
      }
    }
    if (harness === "antigravity") {
      const link = join(geminiHome(env), "config", "plugins", PLUGIN_NAME);
      try {
        if (lstatSync(link).isSymbolicLink()) {
          if (dryRun) log(`    将移除软链 ${link}`);
          else {
            rmSync(link);
            log(`    已移除 ${link}`);
          }
        }
      } catch {}
      const bak = join(
        backupDir(home),
        "antigravity",
        `${PLUGIN_NAME}-replaced`,
      );
      if (existsSync(bak)) {
        if (dryRun) log(`    将还原原有插件目录 ${link}`);
        else {
          renameSync(bak, link);
          log(`    已还原 ${link}`);
        }
      }
    }
    if (harness === "pi") {
      const link = join(piHome(env), "extensions", "flaremo-memory.ts");
      try {
        if (lstatSync(link).isSymbolicLink()) {
          if (dryRun) log(`    将移除软链 ${link}`);
          else {
            rmSync(link);
            log(`    已移除 ${link}`);
          }
        }
      } catch {}
      restore("pi", "settings.json", join(piHome(env), "settings.json"));
    }
  }

  // shared pieces
  log(`\n[共享]`);
  const binLink = join(flaremoBinDir(env), "flaremo");
  try {
    if (lstatSync(binLink).isSymbolicLink()) {
      if (dryRun) log(`    将移除软链 ${binLink}`);
      else {
        rmSync(binLink);
        log(`    已移除 ${binLink}`);
      }
    }
  } catch {}
  const skillLink = join(agentsHome(env), "skills", PLUGIN_NAME);
  try {
    if (lstatSync(skillLink).isSymbolicLink()) {
      if (dryRun) log(`    将移除软链 ${skillLink}`);
      else {
        rmSync(skillLink);
        log(`    已移除 ${skillLink}`);
      }
    }
  } catch {}
  const skillBak = join(backupDir(home), "agents", `${PLUGIN_NAME}-replaced`);
  if (existsSync(skillBak)) {
    if (dryRun) log(`    将还原原有 skill 目录 ${skillLink}`);
    else {
      renameSync(skillBak, skillLink);
      log(`    已还原 ${skillLink}`);
    }
  }
  log(`\n完成。凭据与 outbox 保留在 ${home}（需要可手动删除）。`);
}

// --- update -----------------------------------------------------------------------

export async function updateCmd({
  env = process.env,
  home = flaremoHome(env),
  log = console.log,
} = {}) {
  const checkout = checkoutRoot();
  const pull = spawnSync("git", ["-C", checkout, "pull", "--ff-only"], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  log(
    `git pull: ${pull.status === 0 ? (pull.stdout || "").trim() || "已是最新" : `⚠️ ${(pull.stderr || "").trim().slice(0, 200)}`}`,
  );

  const codex = resolveCodexBin(env);
  if (codex) {
    const r = spawnSync(
      codex,
      ["plugin", "marketplace", "upgrade", marketplaceName(checkout)],
      {
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
    log(
      `codex marketplace upgrade: ${r.status === 0 ? "✅" : `⚠️ ${(r.stderr || "").trim().slice(0, 160)}`}`,
    );
  }
  writeHookWrapper(home, { log });
  log("完成。");
}
