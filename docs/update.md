# 更新 FlareMo

FlareMo 的更新由部署仓库和 Cloudflare Workers Builds 完成。应用不会保存 GitHub Personal Access Token 或 Cloudflare API Token。

## 首次启用

把 `FLAREMO_DEPLOY_REPOSITORY` 填成你自己的部署仓库（FlareMo 的 fork 或副本，即你运行部署的仓库），格式为：

```text
你的 GitHub 用户名/仓库名
```

例如：

```text
octocat/flaremo
```

然后在该仓库中打开 `Settings` -> `Actions` -> `General`：

- 允许仓库运行 GitHub Actions。
- 在 `Workflow permissions` 中允许 workflow 读取和写入仓库。
- 允许 GitHub Actions 创建 pull request。

再到 Cloudflare Worker 的 `Settings` -> `Build` 确认：

- Production branch 是部署仓库的默认分支，通常为 `main`。
- Production deploy command 是 `pnpm run deploy`。
- Non-production branch deploy command 保持 Cloudflare 默认的 `wrangler versions upload`，不要改成 `pnpm run deploy`。

这个 workflow 只向当前部署仓库创建更新分支和 pull request。它不持有 Cloudflare 凭据，也不负责生产部署。若生产发布走的是 [GitHub Action 部署](./github-action-deploy.md)，合并升级 PR 到 `main` 后会自动发布。

## 日常更新

仓库中的 `Weekly upstream file take` workflow（`.github/workflows/flaremo-update.yml`）每周一上午对照最新稳定 Release。它**不会**把上游整段历史 1:1 套到 `main`，也**不会**合并自己的 pull request。

它只把同时满足这些条件的文件放进 PR：

- 与上游不同
- 不在保护集合里（`apps/worker/src/auth.ts`、自助重置测试与路由、`deploy-cloudflare.yml`、README 里 push-to-main / Resend Worker secret 的句子所在文件）
- 可以整文件取上游且不丢掉本 fork 的独有内容（fork 相对 merge-base 没改过，或 3-way 干净且结果等于上游文件）

冲突和受保护文件的差异写在 PR 正文里，文件保持原样。没有可取文件时 job 绿色退出、不开 PR。

你也可以在 GitHub 手动运行：

1. 打开 `Actions` -> `Weekly upstream file take`。
2. 点击 `Run workflow`；版本留空表示使用最新稳定版。
3. 若有合格文件，等待升级 pull request 创建。
4. 查看 PR 正文里的 Taken / Protected / Conflicts 列表，再决定是否合并。
5. 若使用 [GitHub Action 部署](./github-action-deploy.md)，合并 PR 到 `main` 后会自动发布。

更新 PR 可以生成 preview version，但不会执行生产 D1 migration。合并到 production branch 后，生产部署才会先执行 migration 再发布 Worker。

## 现有实例

从 v0.2.1 或更早版本升级到 v0.3.0 时，需要先按旧的手工流程更新一次。v0.3.0 起，FlareMo 仓库自带更新 workflow（`.github/workflows/flaremo-update.yml`）和应用内版本入口；把它推到你自己的部署仓库即可获得同样的更新流程。

GitHub 可能会在公开仓库连续 60 天没有活动后暂停定时 workflow；应用内版本检查不受影响。此时到仓库 Actions 页面重新启用 workflow，再手工运行一次即可。

GitLab 部署暂不支持这个 GitHub workflow；请继续按 [部署文档](./deploy.md) 的手工升级流程操作。
