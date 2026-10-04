import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * FlareMo memory adapter for Pi.
 *
 * Thin shim: all memory semantics live in the shared `flaremo` CLI and the
 * cloud ledger. This extension only wires Pi's lifecycle to it:
 *   - before_agent_start → inject the project lens once per session
 *   - flaremo_recall / flaremo_remember / flaremo_checkpoint → model tools
 *   - session_before_compact / session_shutdown → flush the local outbox
 *
 * Replaces pi-hermes-memory: remove "npm:pi-hermes-memory" from
 * ~/.pi/agent/settings.json `packages` (flaremo init does this with a backup).
 */

const CLI_CANDIDATES = [
	process.env.FLAREMO_BIN,
	join(homedir(), ".local", "bin", "flaremo"),
	join(homedir(), ".flaremo", "bin", "flaremo"),
	"flaremo",
].filter((v): v is string => Boolean(v));

const CLI = CLI_CANDIDATES.find((p) => p.includes("/") && existsSync(p)) ?? "flaremo";

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function flaremo(args: string[], cwd: string, timeoutMs = 8000): Promise<CliResult> {
	return new Promise((resolve) => {
		execFile(
			CLI,
			[...args, "--agent", "pi"],
			{ cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
				resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
	});
}

const toolText = (r: CliResult) => ({
	content: [
		{
			type: "text" as const,
			text: (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim() || `flaremo exited ${r.code}`,
		},
	],
});

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let lensInjected = false;

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd ?? cwd;
		lensInjected = false;
	});

	// L1: inject the compiled lens once per session. Offline → snapshot (exit 0
	// with stderr notice) or an explicit one-line unavailable declaration (3).
	pi.on("before_agent_start", async (event) => {
		if (lensInjected) return;
		lensInjected = true;

		const r = await flaremo(["lens"], cwd, 4000);
		if (r.code === 0 && r.stdout.trim()) {
			const body = r.stdout.split("\n--- 预算")[0].trim();
			if (!body || body.startsWith("当前项目无活跃随身锦囊")) return;
			return {
				systemPrompt: `${event.systemPrompt}\n\n<flaremo-memory>\n${body}\n</flaremo-memory>`,
			};
		}
		if (r.code === 3) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n<flaremo-memory>FlareMo 记忆服务当前不可达，且无本地快照。本会话按无记忆运行；写入会自动暂存本地补写队列。</flaremo-memory>`,
			};
		}
	});

	pi.registerTool({
		name: "flaremo_recall",
		label: "FlareMo Recall",
		description:
			"Search the shared FlareMo memory ledger (project + global scope). Use before touching unfamiliar modules, before deploys/migrations, when an error repeats, or when the user says '上次/之前/还记得'.",
		promptSnippet: "flaremo_recall: query the shared cross-agent memory ledger",
		promptGuidelines: [
			"Recall before acting on unfamiliar subsystems or repeating a previously seen error.",
			"Results tagged 👀/💡 are agent observations/proposals; only 📌/✅ are human-confirmed rules.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to look up." }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
		}),
		async execute(_id, params: { query: string; limit?: number }) {
			const args = ["recall", params.query];
			if (params.limit) args.push("--limit", String(params.limit));
			return toolText(await flaremo(args, cwd));
		},
	});

	pi.registerTool({
		name: "flaremo_remember",
		label: "FlareMo Remember",
		description:
			"Persist a durable fact to the shared FlareMo ledger as an observed note. Use when the user corrects you, a tradeoff is decided, a pitfall is hit, or the user states a preference. Not for temporary task state.",
		promptSnippet: "flaremo_remember: write a durable memory to the shared ledger",
		promptGuidelines: [
			"Write one atomic fact per call; include the why, not just the what.",
			"Agent writes land as 👀 observed — never claim human confirmation.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "One atomic durable fact." }),
			key: Type.Optional(Type.String({ description: "Deterministic fact_key for later updates." })),
			tags: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params: { content: string; key?: string; tags?: string[] }) {
			const args = ["remember", params.content];
			if (params.key) args.push("--key", params.key);
			for (const t of params.tags ?? []) args.push("--tags", t);
			return toolText(await flaremo(args, cwd));
		},
	});

	pi.registerTool({
		name: "flaremo_checkpoint",
		label: "FlareMo Checkpoint",
		description:
			"Record a work-session war report (summary + atomic conclusions) into the ledger. Use at meaningful completion boundaries: task done, milestone reached, before compaction.",
		promptSnippet: "flaremo_checkpoint: persist a session war report",
		parameters: Type.Object({
			summary: Type.String({ description: "What was done and the outcome." }),
			items: Type.Optional(
				Type.Array(Type.String(), { description: "Atomic conclusions worth keeping." }),
			),
		}),
		async execute(_id, params: { summary: string; items?: string[] }) {
			const args = ["checkpoint", params.summary];
			for (const it of params.items ?? []) args.push("--item", it);
			return toolText(await flaremo(args, cwd));
		},
	});

	// Durability: replay queued offline writes at the two natural boundaries.
	const flush = () => flaremo(["outbox", "flush"], cwd, 4000).catch(() => {});
	pi.on("session_before_compact", flush);
	pi.on("session_shutdown", flush);
}
