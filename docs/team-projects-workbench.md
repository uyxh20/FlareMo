# Team projects workbench

`/team-projects` adds a shared project view inside the existing authenticated FlareMo workspace. It does not replace the personal task board at `/projects` or create a second account, database, file store, or permission system. The workbench uses protected team memos and the existing attachment API. Existing ordinary notes remain ordinary notes: only records with one valid `kosx-pm` fenced metadata block, `schema: "kosx.pm/1"`, and `kind: "project"` or `"update"` appear here. The protocol is a compatibility format for records already used by KOSX, not a new server-side project table or migration.

This release uses one team-wide shared workspace. All active members of that team, including read-only readers, can view team projects that FlareMo allows them to read. “My projects” and business-owner filters only change which readable records appear in the list; they are not access controls. There is no operations-versus-backend department boundary or multiple-team selector in this release. The main project summary remains editable by the record author under the original `can_manage` permission; administrator lifecycle governance does not grant content-edit permission. Naming someone as business owner does not make that person the record author or grant edit access.

The list shows project, business owner, phase, current progress, next action, and follow-up date. Filters distinguish team projects, records assigned to the current account, and ideas. Project URLs use `/team-projects?project=<memo-id>` so details can be shared with another authorized member; list filters survive navigation and reload. The project page separates the summary, dated updates, materials, and source history. Active team members other than read-only readers can add their own progress, meeting decisions, and material notes when the project is readable. No member can edit someone else’s update merely because it appears under the same project. Creation follows existing team-publishing permissions; editing existing records follows `can_manage`. A business owner in metadata does **not** receive editing rights merely by being named. An upload targets a particular memo through FlareMo's attachment API and is never written directly to R2.

The browser reads `/api/app/me`, paginates `/api/app/memos?space=team`, uses `/api/app/memos/:id` for per-record access and `can_manage`, reads `/api/v1/users` for active-account names, and uses existing memo and attachment writes. Current-wire `/api/v1/users` uses `displayName` and `state`; the revision and upload routes explicitly request the legacy wire used by the existing attachment contract. The directory lists active FlareMo accounts, but does not independently prove a user's future team membership. Before a changed owner is saved, the directory is read again; failure does not fall back to a guessed ID. Permission and source record are rechecked for writes and file previews. The browser uses `no-store` for protected reads and revokes its local blob URL when the preview closes or identity changes. This does not erase a file already downloaded by someone.

Department or multi-team isolation is deferred. It cannot be implemented by hiding rows in this workbench: a future design must apply server-side authorization consistently to existing projects, updates, attachments, ordinary memos, search results, and every other backend read path, including direct URLs and API access. It must also define how already-created records move into the new boundary without widening or silently removing access.

`zh-CN` and `en-US` workbench copy are supplied. Other FlareMo locales currently display the English workbench copy; the host shell keeps its own locale. Follow-up dates use the viewer's local calendar day. The raw `kosx.pm/1` metadata remains language-neutral, and user-entered project names, updates, and source content are never translated.

The ported workbench JavaScript is checked by its local `checkJs` TypeScript configuration as part of the web check command. This does not relax the host application's strict TypeScript configuration or claim a full strict-TypeScript migration of the workbench.

Relevant validation commands, from the repository root:

```sh
pnpm --filter @flaremo/web check
pnpm --filter @flaremo/web build
pnpm exec vitest run tests/team-projects/workbench.test.ts apps/web/src/features/team-projects/navigation.test.ts
```

`tests/e2e/team-projects.spec.ts` is an opt-in Playwright route and guard case under the existing disposable E2E fixture; do not run it against a real team. Browser acceptance should use separate member sessions and check that a shared main record is readable, a non-creator can add a personal update and attachment, and that assigning someone as business owner does not grant main-record edit access.
