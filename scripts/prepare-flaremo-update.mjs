#!/usr/bin/env node

// Helpers for .github/workflows/flaremo-update.yml. The daily job must not go
// red on a known three-way conflict; it should open a review PR that keeps
// both the fork hunks and the upstream hunks.

export function updateApplyOutcome({ applyExitCode, unmergedFiles }) {
  const files = [...new Set(unmergedFiles ?? [])].filter(Boolean).sort();
  if (applyExitCode === 0) {
    return { kind: "clean", failJob: false, files: [] };
  }
  if (files.length > 0) {
    return { kind: "conflicts", failJob: false, files };
  }
  return { kind: "failed", failJob: true, files: [] };
}

export function conflictReportMarkdown({
  currentVersion,
  targetVersion,
  files,
  upstreamRepository = "realchendahuang/FlareMo",
}) {
  const list = files.map((file) => `- \`${file}\``).join("\n");
  return `# FlareMo update conflicts (${targetVersion})

This branch is the three-way apply of \`v${currentVersion}\` → \`${targetVersion}\` onto this fork.

Git could not auto-merge these files. **Both sides are kept** as conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Nothing from the fork was discarded.

${list}

Do not merge until the markers are gone. After resolving, commit on this branch (or a follow-up) and merge as a normal upgrade.

Upstream notes: https://github.com/${upstreamRepository}/releases/tag/${targetVersion}
`;
}

export function updatePullRequest({
  currentVersion,
  targetVersion,
  files,
  upstreamRepository = "realchendahuang/FlareMo",
}) {
  const notes = `https://github.com/${upstreamRepository}/releases/tag/${targetVersion}`;
  if (files.length === 0) {
    return {
      title: `Update FlareMo to ${targetVersion}`,
      body: `A new stable FlareMo release is available. Review the release notes and merge this pull request.

Release notes: ${notes}

This workflow only prepares the upgrade. It does not deploy. Production publish is Workers Builds (\`pnpm deploy:ci\` after a Dashboard connect) or **Deploy to Cloudflare** if \`CLOUDFLARE_API_TOKEN\` and \`CLOUDFLARE_ACCOUNT_ID\` are set. Do not put \`RESEND_API_KEY\` in GitHub Actions secrets.`,
    };
  }
  return {
    title: `Update FlareMo to ${targetVersion} (conflicts — do not merge yet)`,
    body: `Three-way apply of v${currentVersion} → ${targetVersion} has conflicts. The daily job opened this PR instead of failing.

Conflicted files (fork hunks and upstream hunks are both in the markers):

${files.map((file) => `- \`${file}\``).join("\n")}

Do not merge until the markers are resolved. The next scheduled run will see this branch/PR and stay green.

Release notes: ${notes}`,
  };
}
