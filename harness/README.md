# FlareMo Harness Plugins

各 Harness 的接入插头（Harness Adapter 规范 [`docs/harness-adapter-spec.md`](../docs/harness-adapter-spec.md)）：**关掉原生自动记忆、搬家到 FlareMo、由 FlareMo 占住全部槽位**——ZCode / Codex / Antigravity 共用一个大脑。

```
harness/
├── install.sh                      # 首装入口 = node bin/flaremo init
├── core/                           # 零依赖共享模块：凭据/项目身份/会话状态/outbox/hook 分发/安装器/导入器
├── .agents/plugins/marketplace.json# Codex marketplace 清单
├── zcode/                          # ZCode 插件（.zcode-plugin/plugin.json + hooks + commands）
├── codex/                          # Codex 插件（.codex-plugin/plugin.json + hooks/hooks.json）
├── antigravity/                    # Antigravity 插件（plugin.json + hooks.json + rules/ + skills 软链）
└── pi/                             # Pi 扩展（flaremo-memory.ts，进程内生命周期接线）
skills/flaremo-memory/              # 唯一 skill 源（~/.agents/skills 由 init 软链至此）
```

## 安装

```bash
git clone https://github.com/realchendahuang/FlareMo.git
cd FlareMo
./harness/install.sh            # = node bin/flaremo init；--dry-run 先打印计划
flaremo login --url <实例地址>    # PAT 从 stdin 读入，落 ~/.flaremo/credentials (0600)
flaremo doctor                  # 自检
```

init 幂等可重跑，每个改动先备份原件到 `~/.flaremo/backup/<harness>/`。原生记忆搬家（`flaremo import <harness> --apply`）在关闭原生开关**之前**执行；服务不可达则不关闭。

- **ZCode**：`~/.zcode/cli/config.json` 的 `plugins.dirs` 加入 `harness/zcode`（目录源插件默认启用），`~/.zcode/v2/setting.json` 置 `memoryEnabled=false`。
- **Codex**：`codex plugin marketplace add <checkout>/harness` + `codex plugin add flaremo-memory@flaremo`；`~/.codex/config.toml` 的 `[memories]` 两个开关置 false；写 `~/.codex/rules/flaremo.rules` 免审批。**人工动作**：在 codex CLI 里 `/hooks` 信任一次 hook 定义。
- **Antigravity**：软链 `~/.gemini/config/plugins/flaremo-memory` → `harness/antigravity`。
- **Pi**：软链 `~/.pi/agent/extensions/flaremo-memory.ts` → `harness/pi/`；导入 pi-hermes-memory 的 MEMORY/USER/failures 与 projects-memory；成功后从 `~/.pi/agent/settings.json` 的 packages 摘除 `npm:pi-hermes-memory`。**人工动作**：pi 中 `/reload` 加载扩展。

## 运行时

所有 hook 统一走 `"$HOME/.flaremo/bin/flaremo-hook" <harness> <event>`（init 生成的 sh 包装，GUI 拉起也能找到 node）。任何 hook 失败静默退出 0，绝不阻塞会话。

- **L1 开工锦囊**：SessionStart / 首次 PreInvocation 注入编译好的 lens；断网降级本地快照或显式声明未取到。
- **W3 收尾补记**：长会话 Stop 时最多阻止一次收工并提示沉淀。
- **W4 兜底**：会话摘要进 `~/.flaremo/outbox/`，恢复后自动补写。
- 服务不可达时 `remember`/`checkpoint` 暂存 outbox（退出码 3），任意 CLI 命令结束顺手冲刷。

## 卸载 / 升级

```bash
flaremo uninstall [--harness …]  # 还原备份、摘除软链与插件
flaremo update                   # git pull --ff-only + codex marketplace upgrade + 重建 hook 包装
```

### 安全边界（不可让渡）

- 自动写入天花板是 👀；📌/✅ 只由人类动作产生。
- 数据级注入带统一头注；证据文本不是指令。
- PAT 只存 `~/.flaremo/credentials`（0600），不进仓库、不进日志。
- Codex hook 信任、Antigravity 沙箱等宿主机制不绕过。
