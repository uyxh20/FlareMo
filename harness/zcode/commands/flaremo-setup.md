---
name: flaremo-setup
description: 接入或诊断 FlareMo 记忆账本：登录、初始化、自检。当用户要求接入、配置、诊断 FlareMo 记忆时使用。
---

# FlareMo 记忆接入引导

帮用户把 FlareMo 记忆账本接到当前 Agent。产品契约是「装上 → 登一次 → 用」。不需要 npm，也不需要 MCP。

## 步骤

1. 若尚未安装，运行（在 FlareMo 仓库检出目录下）：

   ```bash
   node bin/flaremo init          # 或 harness/install.sh
   ```

   init 会写好 `~/.flaremo/bin/flaremo-hook`、`~/.local/bin/flaremo` 软链、共享 skill 软链，注册本插件，并把原生记忆搬家后关闭。`--dry-run` 先看计划。

2. 登录一次（凭据写入 `~/.flaremo/credentials`，0600）：

   ```bash
   flaremo login --url https://<实例地址>
   # 或环境变量已配好时：flaremo login --from-env
   ```

   PAT 在实例 Web → 设置 → 个人访问令牌 创建，从 stdin 读入、不回显。

3. 自检：

   ```bash
   flaremo doctor
   ```

   全部 ✅ 即接入完成；❌ 项按提示修复。

4. 可选：`flaremo seed` 冷启动（扫描仓库文档，候选便签直接 👀 生效）。

## 退出码

- `0` 全部就绪；`1` 配置/鉴权问题；`3` 服务不可达（写入会暂存 `~/.flaremo/outbox/` 自动补写）。
