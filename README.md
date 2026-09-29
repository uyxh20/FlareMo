# FlareMo 🔥

<p align="center">
  <b>Zero Servers · Zero Upkeep · 24/7 Global Edge Uptime · Absolute Data Ownership</b><br>
  For individuals: a quiet, focused thought capture space and second brain. For teams: a shared knowledge base with fine-grained roles.
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> •
  <a href="./README.zh-CN.md">简体中文</a> •
  <a href="./README.ja.md">日本語</a> •
  <a href="./README.fr.md">Français</a> •
  <a href="./README.es.md">Español</a> •
  <a href="./README.ko.md">한국어</a> •
  <a href="./README.ru.md">Русский</a> •
  <a href="./README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://github.com/realchendahuang/FlareMo/stargazers"><img src="https://img.shields.io/github/stars/realchendahuang/FlareMo?style=flat&color=F38020" alt="GitHub stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/realchendahuang/FlareMo?style=flat&color=2563EB" alt="License"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Runtime-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://github.com/usememos/memos"><img src="https://img.shields.io/badge/Ecosystem-Memos%20Compatible-0284C7" alt="Memos Compatible"></a>
  <a href="https://www.better-auth.com/"><img src="https://img.shields.io/badge/Auth-Better%20Auth-10B981" alt="Better Auth"></a>
  <a href="https://flaremo.app"><img src="https://img.shields.io/badge/Website-flaremo.app-EA580C" alt="Website"></a>
</p>

<div align="center">

| ☀️ Desktop · Light Theme | 🌙 Desktop · Dark Theme | 📱 Mobile · Responsive |
| :---: | :---: | :---: |
| <img src="./docs/assets/flaremo-desktop-light.png" width="360" alt="FlareMo Desktop Light Mode" /> | <img src="./docs/assets/flaremo-desktop-dark.png" width="360" alt="FlareMo Desktop Dark Mode" /> | <img src="./docs/assets/flaremo-mobile.png" width="168" alt="FlareMo Mobile Mode" /> |

<sub>Actual live screenshots: seamless light/dark mode switching and full-featured mobile responsiveness. Every feature shown is wired to working backend capabilities.</sub>

</div>

---

## 💡 Why FlareMo?

Tools like Flomo and Memos proved the immense value of low-friction memo capture and a distraction-free timeline. However, self-hosting a traditional note-taking setup typically means paying for a VPS, configuring Docker and PostgreSQL, scripting automated backups, and dreading disk or hardware failures.

FlareMo answers a simpler question: **Can you get a 24/7 online, resilient, globally accelerated knowledge base with zero server maintenance, using just a free Cloudflare account?**

- **Truly Serverless**: Both code and static assets run on Cloudflare Workers edge nodes near you with millisecond latency.
- **Enterprise-grade durability out of the box**: Cloudflare D1 handles notes and metadata; Cloudflare R2 stores media attachments with multi-region replication.
- **AI-Native Second Brain**: Built-in MCP endpoints and Agent Memory hub allow AI agents (Claude, Cursor, Codex, ChatGPT) to read and update your long-term preferences and memory scopes.
- **Quiet for one, powerful for many**: Default is an encrypted, private single-user sanctuary. Enable team mode, and it instantly transforms into a collaborative workspace with roles and three-tier visibility.
- **Minimal, not simplistic**: The interface stays quiet and every control earns its place — nothing decorative shouting for attention, nothing useful missing.

---

## ✨ Key Features

### 1. Instant Capture & Inspiring Review
- **Capture in milliseconds**: Card-style timeline, tags, Markdown/GFM, and previews for image and audio attachments.
- **Lightning-fast search**: SQLite FTS5 full-text indexing with query operators (`has:attachment`, `is:pinned`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `in:timeline|archive|trash`).
- **Semantic "Find" (Vector Search)**: Workers AI embeddings paired with Vectorize derived vector indexes for contextual recall; re-verifies permissions against D1 and seamlessly falls back to FTS5.
- **Thought activation**: Built-in **Daily Review** (on this day), **Random Walk** (wandering through tag and backlink graphs with postcard summaries), and related note recommendations.
- **Revision history**: Full version diffs and one-click historical restore.

### 2. AI Long-term Memory & Native MCP
- **Agent Memory**: Through `/memory/mcp`, AI agents can record and update cross-session long-term memory (preferences, project decisions, constraints, lessons).
- **Human in the loop**: Review, verify, lock, or correct AI-recorded memories at `/memory`.
- **Open ecosystem**: Standard `/mcp` (Streamable HTTP MCP) endpoint to query and append notes programmatically.

### 3. Projects & Tasks
- **Group work under projects**: Organize notes and to-dos into projects, with a kanban board (drag between status columns), priorities, manual sort order, and due dates.
- **Personal by design, reversible deletion**: Tasks belong to a single owner; deleting moves them to a recycle bin until restored or automatically purged.

### 4. Task Management & Reminders
- **Tasks live in Projects**: The `/projects` board (drag between status columns), priorities, manual sort order, and due dates make project pages the single home for scheduling work.
- **Time horizons at a glance**: The explorer home view pairs a mini month calendar with overdue/today reminders, so what's due never hides behind the board.
- **Overdue reminders**: Overdue tasks raise in-app notifications, with optional browser Web Push.

### 5. Team Collaboration & 3-Tier Visibility
- **Role governance**: `owner`, `admin`, and `member` roles. Admins invite members via one-time activation links (members choose their own passwords; admins never handle plaintext credentials).
- **3-tier visibility**:
  - 🔒 **Private**: Only author can view.
  - 👥 **Team**: Shared read-only with active team members.
  - 🌐 **Public**: Anonymous read-only via time-limited share links.
- **Safe offboarding**: Removing a member triggers reliable background cleanup that purges private data while preserving team and public notes.
- **Reader seats**: Grant a time-boxed read-only seat — guest readers, course cohorts, client delivery. Seats lapse automatically at their expiry (fail-closed at credential resolution, no cron needed). Manage them from the members page, or provision by email through `PUT /api/app/admin/team/reader` with a Personal Access Token (see `docs/team-mode.md`).

### 6. Offline First & PWA Experience
- **Installable PWA**: Install to macOS, Windows, iOS, or Android home screen with native feel.
- **Reliable offline sync**: Drafts save locally instantly. Offline submissions and uploads queue up and replay automatically when connectivity is restored.
- **Live voice capture**: Access `/capture` for real-time streaming speech-to-text (ASR) transcription.

### 7. Secure Better Auth Application Security
- **Better Auth powered**: HttpOnly, `SameSite=Lax` browser cookie sessions; revocable `memos_pat_` Personal Access Tokens for scripts, CLI, and MCP.
- **Strict Origin protection**: State-changing requests enforce exact origin whitelisting. Cloudflare Access remains available as an optional outer defensive perimeter.

### 8. Memos Compatibility & Seamless Migration
- **Memos `/api/v1` compatibility**: Provides core Memos API endpoints (camelCase default, legacy snake_case via header) and OpenAPI schema.
- **Third-party apps ready**: Works directly with mobile clients like Moe Memos.
- **Bi-directional import & export**: One-click import from Memos / flomo with conflict strategies and full raw export bundles.

---

### 9. 插件系统：卡片即插件
- **五张内置卡片**：素白、日签、票根、明信片，以及自绘 canvas 的邮戳演示卡。
- **商店与管理**：账户设置里浏览目录、一键安装（sha256 校验）、启用/停用、排序、设默认、隐藏；官方目录在 [flaremo.app/plugins](https://flaremo.app/plugins/registry.json)。
- **可上传**：管理员可上传本地插件包——只存在于自己实例，永不外传。
- **可创作**：`pnpm plugin:new` 生成脚手架、`pnpm plugin:check` 用与实例安装**完全相同**的规则校验、`pnpm plugins:build` 出包；document 卡是纯 JSON 排版，sandbox 卡写自己的 HTML/CSS/JS。详见 [插件文档](./docs/plugins.md)。
- **默认安全**：卡片跑在不透明源沙箱里，**无任何网络访问**；社区/品牌插件默认关闭，管理员显式启用才可见。

## 📊 How Generous Is Cloudflare's Free Tier?

Many assume "free" means "severely limited". For text-heavy personal knowledge bases, Cloudflare's free quota is virtually inexhaustible:

| Resource | Free Tier Quota | Equivalent Capacity | Practical Lifespan |
| :--- | :--- | :--- | :--- |
| **Cloudflare D1** | **5 GB database** | ~**2.5 Million** text memos | Writing 100 memos daily would take **68 years** to fill |
| **Cloudflare R2** | **10 GB storage** | ~**5,000–10,000** photos / **80 hours** of voice | **$0 egress fees**; public sharing won't trigger bandwidth bills |
| **Cloudflare Workers** | Generous free request limits | 300+ global edge locations | Millisecond latency worldwide without cold boots |

---

## 🥊 Comparison: Cloudflare Native vs Home NAS vs Traditional VPS

| Dimension | Cloudflare Native (FlareMo) | Home NAS / Mini PC | Traditional VPS |
| :--- | :--- | :--- | :--- |
| **Data Durability** | **Enterprise multi-region replication**, zero hardware failure risk | Single drive failure or power outage can cause total data loss | Dependent on manual snapshot & backup routines |
| **Maintenance** | **Zero**: No OS patching, no Docker compose, no DB maintenance | OS updates, Docker upkeep, SMART disk alerts, router configs | Kernel upgrades, security patches, watchdog daemons |
| **Access Latency** | **Global edge CDN**, sub-100ms response anywhere | Requires DDNS / frp / Tailscale tunnels, constrained by home uplink | Dependent on single cloud region; high cross-border latency |
| **SSL & Domains** | **Automated HTTPS** & custom domain bindings | Manual certificate issuance, reverse proxy configuration | Nginx / Caddy config & Let's Encrypt renewal maintenance |
| **Financial Cost** | **$0 / month** on free tier | High upfront hardware cost + ongoing electricity | Ongoing monthly / annual server & bandwidth bills |

---

## 🚀 5-Minute Quick Deployment

### Method 1: One-click Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/realchendahuang/FlareMo)

Clones the repository into your GitHub account and provisions D1, R2, Queues, and Vectorize automatically. After the initial deploy, set `FLAREMO_PUBLIC_URL` and secrets (see [docs/en/deploy.md](./docs/en/deploy.md#one-click-deploy-community-supported)). If the first attempt reports "Github API Limit Exceeded", wait a few minutes and retry.

### Method 2: GitHub Action (self-hosted fork)

On your fork, **Deploy to Cloudflare** runs on push to `main` and on a manual Actions run: provision resources, publish the Worker with `cloudflare/wrangler-action`, and sync auth secrets. Mail keys stay as Worker secrets (`wrangler secret put RESEND_API_KEY`). See [docs/github-action-deploy.md](./docs/github-action-deploy.md) or the [English guide](./docs/en/github-action-deploy.md).

### Method 3: Deploy with an AI Agent (Recommended)

Give the repository to an agent capable of executing terminal commands (e.g. Claude Code, Cursor Agent, Codex) along with [docs/agent-deploy.md](./docs/agent-deploy.md):
> "Please deploy FlareMo to my Cloudflare account following docs/agent-deploy.md."

---

### Method 4: Manual 3-Step Deployment

#### 1. Create Cloudflare Resources
```bash
pnpm exec wrangler whoami
pnpm exec wrangler d1 create flaremo
pnpm exec wrangler r2 bucket create flaremo-attachments
```

Or run `pnpm provision:remote` instead: it creates the missing D1 / R2 / Queue / Vectorize resources and writes the D1 `database_id` into `wrangler.jsonc` for you. It is idempotent — existing resources are skipped.

#### 2. Configure Settings & Secrets
```bash
cp wrangler.jsonc.example wrangler.jsonc
```
Fill in the generated `database_id` and set `FLAREMO_PUBLIC_URL` to your production domain. Then set secrets:
```bash
pnpm exec wrangler secret put BETTER_AUTH_SECRET --config ./wrangler.jsonc
pnpm exec wrangler secret put FLAREMO_BOOTSTRAP_SECRET --config ./wrangler.jsonc
```

#### 3. Deploy
```bash
pnpm deploy:dry-run
pnpm deploy
```

(The full `pnpm verify` gate runs only when the maintainer explicitly asks for it.)
Visit your production domain at `/setup` and enter the `FLAREMO_BOOTSTRAP_SECRET` to initialize your Owner account.

Detailed guides: [Deployment Guide](./docs/deploy.md) · [GitHub Action deploy](./docs/github-action-deploy.md) · [Update Guide](./docs/update.md).

---

## 🧱 Architecture & Tech Stack

```mermaid
flowchart LR
  Browser["FlareMo Web UI (React 19 / PWA)"] --> Worker["Cloudflare Worker"]
  Clients["Memos Clients / Scripts / MCP"] --> Worker

  Worker --> Auth["Better Auth (Session / PAT)"]
  Worker --> D1["Cloudflare D1 (Memos / Relations / Settings)"]
  Access["Cloudflare Access (Optional Outer Perimeter)"] -.-> Worker
  Worker --> R2["Cloudflare R2 (Attachments & Exports)"]
  Worker --> Assets["Workers Static Assets"]
```

- **Runtime**: Cloudflare Workers
- **Frontend**: React 19, Vite, TanStack Router, Tailwind CSS 4, Radix UI
- **Database**: Cloudflare D1, Drizzle ORM
- **Storage**: Cloudflare R2
- **Auth**: Better Auth (HttpOnly cookie session + revocable `memos_pat_`)
- **AI & Search**: Workers AI, Vectorize, SQLite FTS5
- **Plugins**: slot-based extension platform ([standard](./docs/plugin-platform-standard.md), [guide](./docs/plugins.md)); packages live in R2, sandboxed cards run without network access
- **Plugins**: slot-based extension platform ([standard](./docs/plugin-platform-standard.md), [guide](./docs/plugins.md)); packages live in R2, sandboxed cards run without network access

---

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=realchendahuang/FlareMo&type=Date)](https://star-history.com/#realchendahuang/FlareMo&Date)

---

## 📄 License

Open-sourced under the [GNU AGPL-3.0](./LICENSE) license.
Copyright (c) 2026 realchendahuang.
