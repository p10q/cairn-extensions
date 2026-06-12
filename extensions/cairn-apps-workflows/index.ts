/**
 * cairn-apps-workflows pi extension
 *
 * Author, run, observe, and iterate on workflows hosted by the Cairn apps daemon
 * (appsd) — the SQLite-backed HTTP server bundled inside Cairn.app/Contents/Resources/.
 *
 * Daemon API:  http://127.0.0.1:8765 (override via GHOSTTY_APPS_PORT or GHOSTTY_APPS_BASE_URL).
 * Auth:        none (loopback only).
 * SSE:         GET /stream — multiplexed event bus; client filters by `kind` + `run_id`.
 *
 * Tools (snake_case, model-callable):
 *   Workflow CRUD
 *     apps_workflow_list
 *     apps_workflow_get          {slug}
 *     apps_workflow_create       {definition}
 *     apps_workflow_update       {slug, definition}
 *     apps_workflow_delete       {slug}                 (deletes user / resets embedded)
 *     apps_workflow_reload                              (re-seed embedded + on-disk JSON)
 *     apps_workflow_skeleton                            (returns an empty-but-valid def)
 *     apps_workflow_generate_script {prompt, system_prompt?}
 *
 *   Runs
 *     apps_run_start             {slug, params?, wait?, watch_turns?}
 *     apps_run_status            {run_id}
 *     apps_run_list
 *     apps_run_resume            {run_id}
 *     apps_run_cancel            {run_id}
 *     apps_run_drop_in           {run_id, step_pk, mode?}
 *     apps_run_watch             {run_id, until?}
 *
 *   Misc
 *     apps_skills_list
 *     apps_status
 *
 * Slash commands:
 *   /apps-status                — probe daemon, print version + run summary
 *   /apps-open [slug]           — open editor in companion pane (falls back to system browser)
 *   /apps-watch <run_id>        — re-attach SSE for an in-flight run
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

// ───────────────────── Config ─────────────────────

const DEFAULT_PORT = 8765;
function baseUrl(): string {
	if (process.env.GHOSTTY_APPS_BASE_URL) return process.env.GHOSTTY_APPS_BASE_URL.replace(/\/$/, "");
	const port = process.env.GHOSTTY_APPS_PORT || String(DEFAULT_PORT);
	return `http://127.0.0.1:${port}`;
}

// ───────────────────── HTTP helpers ─────────────────────

interface FetchOpts {
	method?: string;
	body?: any;
	signal?: AbortSignal;
}

async function call<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
	const url = `${baseUrl()}${path}`;
	const init: RequestInit = {
		method: opts.method ?? "GET",
		signal: opts.signal,
		headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	};
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (e: any) {
		const msg = e?.message || String(e);
		throw Object.assign(new Error(daemonHint(msg)), { code: "NETWORK", cause: e });
	}
	const text = await res.text();
	let parsed: any;
	try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
	if (!res.ok) {
		const err = new Error(`appsd ${res.status} ${res.statusText} on ${opts.method ?? "GET"} ${path}`);
		(err as any).status = res.status;
		(err as any).body = parsed;
		throw err;
	}
	return parsed as T;
}

function daemonHint(msg: string): string {
	return [
		`apps daemon unreachable at ${baseUrl()}: ${msg}`,
		`Hint: open Cairn.app (it auto-spawns the daemon) or set GHOSTTY_APPS_PORT / GHOSTTY_APPS_BASE_URL.`,
		`To run the daemon manually: pkg/apps/zig-out/bin/appsd --port 8765 --db /tmp/appsd.sqlite`,
	].join("\n");
}

function formatServerErrors(body: any): string {
	if (!body || typeof body !== "object") return "";
	if (Array.isArray(body.errors) && body.errors.length > 0) {
		return body.errors
			.map((e: any) => `  • ${e.field ?? "?"}: ${e.message ?? JSON.stringify(e)}`)
			.join("\n");
	}
	if (typeof body.error === "string") return `  • ${body.error}`;
	return "";
}

function toolError(prefix: string, e: any) {
	const lines: string[] = [];
	const status = e?.status;
	const msg = e?.message ?? String(e);
	lines.push(`${prefix}: ${msg}`);
	const detail = formatServerErrors(e?.body);
	if (detail) lines.push(detail);
	return {
		isError: true,
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: { status, body: e?.body, code: e?.code },
	};
}

function toolOk(text: string, details: any = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

// ───────────────────── SSE reader ─────────────────────

interface BusEvent {
	kind: string;
	payload: any;
}

async function* sseEvents(signal: AbortSignal): AsyncGenerator<BusEvent> {
	const res = await fetch(`${baseUrl()}/stream`, { signal });
	if (!res.ok || !res.body) {
		throw new Error(`SSE /stream returned ${res.status} ${res.statusText}`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) return;
		buf += decoder.decode(value, { stream: true });
		// SSE frames are separated by \n\n
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			// Each frame may have multiple "data: ..." lines; appsd sends one.
			const dataLines = frame
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart());
			if (dataLines.length === 0) continue; // comment / keepalive
			const dataStr = dataLines.join("\n");
			try {
				const ev = JSON.parse(dataStr) as BusEvent;
				yield ev;
			} catch {
				// ignore malformed frame
			}
		}
	}
}

// ───────────────────── Run watching (blocking start + watch tool) ─────────────────────

interface RunStepRow {
	id: number;
	step_id: string;
	state: string;
	output?: string;
	pi_session_id?: string;
	transcript_path?: string;
	cwd?: string;
}
interface RunDetail {
	run: { id: number; workflow_slug: string; state: string; created_at?: string; finished_at?: string };
	steps: RunStepRow[];
}

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

interface WatchResult {
	state: string;
	reason: string; // "terminal" | "paused" | "limit"
	last_step?: { step_id: string; state: string; pk?: number };
	turns_seen: number;
}

/**
 * Subscribe to /stream, filter to this run, surface progress via onUpdate + widget,
 * return when terminal or paused (or watch_turns cap reached).
 */
async function watchRun(
	runId: number,
	opts: {
		signal: AbortSignal;
		onUpdate?: (chunk: { content: any[] }) => void;
		ctx?: any;
		watchTurns?: number;
		untilPaused?: boolean;
	},
): Promise<WatchResult> {
	const watchTurns = opts.watchTurns ?? 2000;
	let turns = 0;
	let lastStepName: string | null = null;
	let lastStepPk: number | undefined;
	let lastAssistantSnippet = "";

	const renderWidget = (state: string) => {
		if (!opts.ctx?.ui?.setWidget) return;
		opts.ctx.ui.setWidget("cairn-apps-workflows", (_tui: any, theme: any) => {
			const head = `${theme.fg("accent", `appsd run #${runId}`)} ${theme.fg("dim", state)}`;
			const step = lastStepName ? `\n  step ${theme.fg("accent", lastStepName)}` : "";
			const tail = lastAssistantSnippet ? `\n  ${theme.fg("dim", lastAssistantSnippet.slice(0, 80))}` : "";
			return `${head}${step}${tail}`;
		});
	};

	const clearWidget = () => {
		if (opts.ctx?.ui?.setWidget) opts.ctx.ui.setWidget("cairn-apps-workflows", undefined);
	};

	const surface = (text: string) => {
		opts.onUpdate?.({ content: [{ type: "text", text }] });
	};

	renderWidget("running");

	try {
		for await (const ev of sseEvents(opts.signal)) {
			if (!ev.payload || ev.payload.run_id !== runId) continue;
			turns++;
			switch (ev.kind) {
				case "workflow.run.started":
					surface(`▶ run #${runId} started`);
					renderWidget("running");
					break;
				case "workflow.step.started": {
					lastStepName = ev.payload.msg ?? null;
					lastStepPk = ev.payload.step_pk;
					surface(`→ step: ${lastStepName ?? "?"}`);
					renderWidget("running");
					break;
				}
				case "workflow.step.turn": {
					// payload.line is a raw pi JSONL string; extract a short hint without spamming.
					try {
						const line = JSON.parse(ev.payload.line);
						if (line?.type === "message_end" && line.role === "assistant" && Array.isArray(line.content)) {
							const text = line.content.find((c: any) => c.type === "text")?.text;
							if (text) {
								lastAssistantSnippet = text.split("\n")[0].slice(0, 200);
								renderWidget("running");
							}
						}
					} catch { /* not json — ignore */ }
					break;
				}
				case "workflow.run.paused":
					surface(`⏸ run #${runId} paused (human review)`);
					clearWidget();
					return {
						state: "paused",
						reason: "paused",
						turns_seen: turns,
						last_step: lastStepName ? { step_id: lastStepName, state: "awaiting_human", pk: lastStepPk } : undefined,
					};
				case "workflow.run.succeeded":
				case "workflow.run.failed":
				case "workflow.run.cancelled": {
					const state = ev.kind.replace("workflow.run.", "");
					surface(`■ run #${runId} ${state}`);
					clearWidget();
					return {
						state,
						reason: "terminal",
						turns_seen: turns,
						last_step: lastStepName ? { step_id: lastStepName, state, pk: lastStepPk } : undefined,
					};
				}
			}
			if (turns >= watchTurns) {
				clearWidget();
				return { state: "running", reason: "limit", turns_seen: turns };
			}
		}
		clearWidget();
		return { state: "unknown", reason: "stream-closed", turns_seen: turns };
	} catch (e) {
		clearWidget();
		throw e;
	}
}

// ───────────────────── Skeleton ─────────────────────

const SKELETON_DEF = {
	slug: "my-workflow",
	title: "My Workflow",
	category: "general",
	description: "What this workflow does in one sentence.",
	runner: "script",
	params_schema: [
		{ name: "topic", type: "string", label: "Topic", required: true },
	],
	agent_roles: {
		researcher: {
			system_prompt: "You are a careful researcher. Cite sources.",
			skills: [],
		},
	},
	prompts: {
		researchPrompt: "Research the following topic and return a markdown report:\n\n{{params.topic}}",
	},
	script: [
		"// QuickJS script. Host fns: agent(stepId, opts), evaluate(stepId, opts), humanReview(msg), log(msg).",
		"// opts = { prompt: string, systemPrompt?: string, skills?: string[], cwd?: string }.",
		"const report = agent('research', {",
		"  prompt: PROMPTS.researchPrompt.replace('{{params.topic}}', params.topic),",
		"  systemPrompt: AGENT_ROLES.researcher.system_prompt,",
		"  skills: AGENT_ROLES.researcher.skills,",
		"});",
		"humanReview('Review the report above before final scoring.');",
		"const score = evaluate('judge', {",
		"  prompt: 'Score the report on accuracy and clarity.\\n\\nREPORT:\\n' + report,",
		"  systemPrompt: 'You are a strict grader. Output JSON {score: 0-1, rationale: string}.',",
		"});",
		"log('done score=' + score.score);",
	].join("\n"),
};

// ───────────────────── Extension entry point ─────────────────────

export default function appsWorkflowsExtension(pi: ExtensionAPI) {
	// Track in-flight watches so we can abort on session shutdown.
	const inflight = new Set<AbortController>();
	function track<T>(p: Promise<T>, ac: AbortController): Promise<T> {
		inflight.add(ac);
		return p.finally(() => inflight.delete(ac));
	}

	// ── apps_workflow_list ───────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_list",
		label: "Apps Workflow List",
		description:
			"List all workflows registered with the apps daemon (embedded built-ins, on-disk JSON, and user-authored). Returns slug, title, category, origin, and description for each.",
		promptSnippet: "List all apps-daemon workflows",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const r = await call<{ workflows: any[] }>("/api/workflows", { signal });
				const lines = r.workflows.map((w) =>
					`• ${w.slug}  [${w.origin}]  ${w.title ?? ""}${w.category ? `  (${w.category})` : ""}`,
				);
				return toolOk(
					lines.length ? lines.join("\n") : "(no workflows registered)",
					{ count: r.workflows.length, workflows: r.workflows.map((w) => ({ slug: w.slug, title: w.title, origin: w.origin, category: w.category })) },
				);
			} catch (e) { return toolError("apps_workflow_list failed", e); }
		},
	});

	// ── apps_workflow_get ────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_get",
		label: "Apps Workflow Get",
		description: "Fetch the full JSON definition of a single workflow by slug. Returns origin, definition_version, and the raw definition object (including the QuickJS script).",
		promptSnippet: "Get a workflow definition by slug",
		parameters: Type.Object({ slug: Type.String({ description: "Workflow slug, kebab-case" }) }),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(`/api/workflows/${encodeURIComponent(params.slug)}`, { signal });
				return toolOk(JSON.stringify(r, null, 2), r);
			} catch (e) { return toolError(`apps_workflow_get '${params.slug}' failed`, e); }
		},
	});

	// ── apps_workflow_skeleton ───────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_skeleton",
		label: "Apps Workflow Skeleton",
		description:
			"Return a minimal-but-valid workflow definition skeleton with a sample QuickJS script. Use this as the starting shape for apps_workflow_create. The runner field MUST be 'script'. Host functions inside the script: agent(stepId, {prompt, systemPrompt, skills?, cwd?}) returns string, evaluate(stepId, {prompt, systemPrompt}) returns {score, rationale}, humanReview(message) pauses the run, log(message).",
		promptSnippet: "Get an empty-but-valid workflow definition skeleton",
		parameters: Type.Object({}),
		async execute() {
			return toolOk(JSON.stringify(SKELETON_DEF, null, 2), { definition: SKELETON_DEF });
		},
	});

	// ── apps_workflow_create ─────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_create",
		label: "Apps Workflow Create",
		description:
			"Create a new user-authored workflow. The definition is validated server-side; on validation failure the tool returns the structured field/message errors verbatim. Pass the full definition object as `definition`. Slug must be kebab-case ([a-z0-9-]+, no leading/trailing/double dashes). Use apps_workflow_skeleton first if unsure of the shape.",
		promptSnippet: "Create a new apps-daemon workflow from a JSON definition",
		parameters: Type.Object({
			definition: Type.Any({ description: "Full workflow definition object — see apps_workflow_skeleton for shape." }),
		}),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>("/api/workflows", { method: "POST", body: { definition: params.definition }, signal });
				return toolOk(`Created workflow '${r.slug}'`, r);
			} catch (e) { return toolError("apps_workflow_create failed", e); }
		},
	});

	// ── apps_workflow_update ─────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_update",
		label: "Apps Workflow Update",
		description: "Update an existing workflow. The slug in the URL must match `definition.slug`. Server-side validation errors come back as structured field/message pairs.",
		promptSnippet: "Update an existing workflow definition",
		parameters: Type.Object({
			slug: Type.String({ description: "Workflow slug to update" }),
			definition: Type.Any({ description: "Full updated definition object" }),
		}),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(`/api/workflows/${encodeURIComponent(params.slug)}`, { method: "PUT", body: { definition: params.definition }, signal });
				return toolOk(`Updated workflow '${r.slug}'`, r);
			} catch (e) { return toolError(`apps_workflow_update '${params.slug}' failed`, e); }
		},
	});

	// ── apps_workflow_delete ─────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_delete",
		label: "Apps Workflow Delete",
		description: "Delete a user-authored workflow, OR reset an embedded one back to its built-in bytes. Daemon picks the right action; response includes `action: 'deleted' | 'reset_to_embedded'`.",
		promptSnippet: "Delete a user workflow or reset an embedded one",
		parameters: Type.Object({ slug: Type.String() }),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(`/api/workflows/${encodeURIComponent(params.slug)}`, { method: "DELETE", signal });
				return toolOk(`Workflow '${params.slug}': ${r.action ?? "deleted"}`, r);
			} catch (e) { return toolError(`apps_workflow_delete '${params.slug}' failed`, e); }
		},
	});

	// ── apps_workflow_reload ─────────────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_reload",
		label: "Apps Workflow Reload",
		description: "Re-seed embedded workflows and re-load on-disk JSON definitions from APPS_WORKFLOWS_DIR / ./workflows / ~/.local/state/apps/workflows. User-authored workflows are preserved.",
		promptSnippet: "Reload embedded + on-disk workflow definitions",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const r = await call<any>("/api/workflows/reload", { method: "POST", signal });
				return toolOk(`Reloaded: embedded=${r.embedded ?? 0}, disk=${r.disk ?? 0}`, r);
			} catch (e) { return toolError("apps_workflow_reload failed", e); }
		},
	});

	// ── apps_workflow_generate_script ────────────────────────────────────
	pi.registerTool({
		name: "apps_workflow_generate_script",
		label: "Apps Workflow Generate Script",
		description: "Ask the daemon's pi-helper to draft a QuickJS workflow script from a natural-language prompt. Returns the generated script string only — you still need to wrap it in a full definition (see apps_workflow_skeleton) before apps_workflow_create.",
		promptSnippet: "LLM-draft a workflow QuickJS script from natural language",
		parameters: Type.Object({
			prompt: Type.String({ description: "Plain-English description of what the workflow should do" }),
			system_prompt: Type.Optional(Type.String({ description: "Optional system prompt to steer the script-writer" })),
		}),
		async execute(_id, params, signal) {
			try {
				const r = await call<{ script: string }>("/api/workflows/__generate-script", {
					method: "POST",
					body: { prompt: params.prompt, system_prompt: params.system_prompt ?? "" },
					signal,
				});
				return toolOk(r.script ?? "(empty script)", r);
			} catch (e) { return toolError("apps_workflow_generate_script failed", e); }
		},
	});

	// ── apps_run_start ───────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_start",
		label: "Apps Run Start",
		description:
			"Start a workflow run with concrete params. Defaults to BLOCKING (`wait: true`): subscribes to the daemon's SSE stream, surfaces step transitions via the live widget, and returns when the run reaches a terminal state (succeeded/failed/cancelled) OR pauses for human review. " +
			"If the run pauses, the response includes `state: 'paused'` and the step pk so you can call apps_run_drop_in to hand control to the user. " +
			"Set `wait: false` to fire-and-forget — useful for long runs you intend to poll with apps_run_status, or when you're not on a Cairn session and the SSE stream is impractical. Always returns `run_id`.",
		promptSnippet: "Start a workflow run (blocking by default; returns run_id)",
		promptGuidelines: [
			"Use apps_run_start to execute a saved workflow with concrete params; prefer wait: true unless the workflow has humanReview steps you expect to pause on.",
			"After a paused run from apps_run_start, use apps_run_drop_in to hand control to the user in a new Cairn tab, then apps_run_resume once they're done.",
		],
		parameters: Type.Object({
			slug: Type.String({ description: "Workflow slug to run" }),
			params: Type.Optional(Type.Any({ description: "Object of {paramName: value} matching the workflow's params_schema" })),
			wait: Type.Optional(Type.Boolean({ description: "Block until terminal/paused (default true)" })),
			watch_turns: Type.Optional(Type.Number({ description: "Cap on SSE events to consume before returning state='running' (default 2000)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const started = await call<{ run_id: number }>(
					`/api/workflows/${encodeURIComponent(params.slug)}/runs`,
					{ method: "POST", body: { params: params.params ?? {} }, signal },
				);
				const runId = started.run_id;
				const wait = params.wait !== false; // default true
				if (!wait) {
					return toolOk(
						`Started run #${runId} for '${params.slug}' (fire-and-forget). Poll with apps_run_status or apps_run_watch.`,
						{ run_id: runId, slug: params.slug, mode: "fire-and-forget" },
					);
				}
				const ac = new AbortController();
				signal?.addEventListener("abort", () => ac.abort(), { once: true });
				const result = await track(
					watchRun(runId, { signal: ac.signal, onUpdate, ctx, watchTurns: params.watch_turns }),
					ac,
				);
				const detail = await call<RunDetail>(`/api/workflows/runs/${runId}`).catch(() => null);
				const tail = detail?.steps?.slice(-3).map((s) => `  ${s.step_id} [${s.state}]${s.output ? ` → ${String(s.output).split("\n")[0].slice(0, 120)}` : ""}`).join("\n") ?? "";
				const summary = [
					`Run #${runId} '${params.slug}' → ${result.state} (${result.reason}, ${result.turns_seen} events)`,
					tail,
				].filter(Boolean).join("\n");
				return toolOk(summary, { run_id: runId, slug: params.slug, ...result, detail });
			} catch (e) { return toolError(`apps_run_start '${params.slug}' failed`, e); }
		},
	});

	// ── apps_run_status ──────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_status",
		label: "Apps Run Status",
		description: "Poll the current state of a run. Returns the run row plus all step rows (state, output, eval_score, pi_session_id, transcript_path, cwd).",
		promptSnippet: "Get the current state of a workflow run",
		parameters: Type.Object({ run_id: Type.Number() }),
		async execute(_id, params, signal) {
			try {
				const r = await call<RunDetail>(`/api/workflows/runs/${params.run_id}`, { signal });
				const head = `Run #${r.run.id} '${r.run.workflow_slug}' [${r.run.state}]`;
				const steps = r.steps.map((s) => `  ${s.step_id} [${s.state}]${s.output ? ` → ${String(s.output).split("\n")[0].slice(0, 120)}` : ""}`).join("\n");
				return toolOk(`${head}\n${steps}`, r);
			} catch (e) { return toolError(`apps_run_status #${params.run_id} failed`, e); }
		},
	});

	// ── apps_run_list ────────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_list",
		label: "Apps Run List",
		description: "List the 100 most recent runs across all workflows.",
		promptSnippet: "List recent workflow runs",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const r = await call<{ runs: any[] }>("/api/workflows/runs", { signal });
				const lines = r.runs.map((run) => `• #${run.id} ${run.workflow_slug} [${run.state}]${run.created_at ? `  ${run.created_at}` : ""}`);
				return toolOk(lines.join("\n") || "(no runs)", { count: r.runs.length, runs: r.runs });
			} catch (e) { return toolError("apps_run_list failed", e); }
		},
	});

	// ── apps_run_resume ──────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_resume",
		label: "Apps Run Resume",
		description: "Resume a paused (awaiting_human) run. Flips the latest awaiting_human step to succeeded and re-queues the run.",
		promptSnippet: "Resume a paused workflow run",
		parameters: Type.Object({ run_id: Type.Number() }),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(`/api/workflows/runs/${params.run_id}/resume`, { method: "POST", signal });
				return toolOk(`Resumed run #${params.run_id}`, r);
			} catch (e) { return toolError(`apps_run_resume #${params.run_id} failed`, e); }
		},
	});

	// ── apps_run_cancel ──────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_cancel",
		label: "Apps Run Cancel",
		description: "Cancel an in-flight run.",
		promptSnippet: "Cancel an in-flight workflow run",
		parameters: Type.Object({ run_id: Type.Number() }),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(`/api/workflows/runs/${params.run_id}/cancel`, { method: "POST", signal });
				return toolOk(`Cancelled run #${params.run_id}`, r);
			} catch (e) { return toolError(`apps_run_cancel #${params.run_id} failed`, e); }
		},
	});

	// ── apps_run_drop_in ─────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_drop_in",
		label: "Apps Run Drop-In",
		description:
			"Spawn a new Cairn tab/split running `pi --session <session_id>` in the step's cwd, attached to the pi session that ran (or is running) that step. Use after a workflow paused for humanReview, or whenever the user wants to continue investigating in a real interactive pi session. Does NOT disturb the current pi session — opens a fresh tab.",
		promptSnippet: "Open a new Cairn tab with pi attached to a workflow step's session",
		promptGuidelines: [
			"After a paused run, use apps_run_drop_in to hand control to the user in a new Cairn tab, then apps_run_resume once they're done.",
		],
		parameters: Type.Object({
			run_id: Type.Number(),
			step_pk: Type.Number({ description: "Step primary key (the `id` field on a step row, NOT step_id string)" }),
			mode: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("split_right"), Type.Literal("split_down")], { description: "Default 'tab'" })),
		}),
		async execute(_id, params, signal) {
			try {
				const r = await call<any>(
					`/api/workflows/runs/${params.run_id}/steps/${params.step_pk}/drop-in`,
					{ method: "POST", body: { mode: params.mode ?? "tab" }, signal },
				);
				return toolOk(`Dropped into pi session for run #${params.run_id} step ${params.step_pk}`, r);
			} catch (e) { return toolError(`apps_run_drop_in failed`, e); }
		},
	});

	// ── apps_run_watch ───────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_run_watch",
		label: "Apps Run Watch",
		description: "Re-attach to an in-flight run via SSE and surface progress in the widget. Returns when the run terminates or pauses (or watch_turns events have been seen). Useful after a fire-and-forget apps_run_start.",
		promptSnippet: "Watch an in-flight workflow run via SSE",
		parameters: Type.Object({
			run_id: Type.Number(),
			watch_turns: Type.Optional(Type.Number({ description: "Cap on events; default 2000" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				const ac = new AbortController();
				signal?.addEventListener("abort", () => ac.abort(), { once: true });
				const result = await track(
					watchRun(params.run_id, { signal: ac.signal, onUpdate, ctx, watchTurns: params.watch_turns }),
					ac,
				);
				return toolOk(`Run #${params.run_id} → ${result.state} (${result.reason})`, { run_id: params.run_id, ...result });
			} catch (e) { return toolError(`apps_run_watch #${params.run_id} failed`, e); }
		},
	});

	// ── apps_skills_list ─────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_skills_list",
		label: "Apps Skills List",
		description: "List skills the daemon discovers in ~/.pi/agent/skills/ and ./.agents/skills/ — these are the valid values for `agent_roles.<role>.skills` in workflow definitions.",
		promptSnippet: "List skills available to workflow agent roles",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const r = await call<{ skills: any[] }>("/api/skills", { signal });
				const lines = r.skills.map((s) => `• ${s.name}  [${s.source}]${s.description ? `  — ${s.description.slice(0, 100)}` : ""}`);
				return toolOk(lines.join("\n") || "(no skills found)", { count: r.skills.length, skills: r.skills });
			} catch (e) { return toolError("apps_skills_list failed", e); }
		},
	});

	// ── apps_status ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "apps_status",
		label: "Apps Status",
		description: "Probe the apps daemon — return base URL, workflow count, recent run summary. Use to verify the daemon is reachable before authoring or running.",
		promptSnippet: "Probe the apps daemon",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const [wf, runs] = await Promise.all([
					call<{ workflows: any[] }>("/api/workflows", { signal }),
					call<{ runs: any[] }>("/api/workflows/runs", { signal }).catch(() => ({ runs: [] })),
				]);
				const recent = runs.runs.slice(0, 5).map((r: any) => `  #${r.id} ${r.workflow_slug} [${r.state}]`).join("\n");
				return toolOk(
					`apps daemon ${baseUrl()} OK — ${wf.workflows.length} workflow(s), ${runs.runs.length} recent run(s)\n${recent}`,
					{ base_url: baseUrl(), workflows: wf.workflows.length, runs: runs.runs.length },
				);
			} catch (e) { return toolError("apps_status: daemon probe failed", e); }
		},
	});

	// ───────────────────── Slash commands ─────────────────────

	pi.registerCommand("apps-status", {
		description: "Probe the apps daemon and print health summary.",
		handler: async (_args, ctx) => {
			try {
				const wf = await call<{ workflows: any[] }>("/api/workflows");
				ctx.ui.notify(`apps daemon ${baseUrl()} OK — ${wf.workflows.length} workflow(s)`, "info");
			} catch (e: any) {
				ctx.ui.notify(`apps daemon unreachable: ${e?.message ?? e}`, "warning");
			}
		},
	});

	pi.registerCommand("apps-open", {
		description: "Open the workflow editor in the Cairn companion pane (or system browser). Optional slug to deep-link.",
		getArgumentCompletions: async (prefix: string) => {
			try {
				const r = await call<{ workflows: any[] }>("/api/workflows");
				return r.workflows.map((w) => w.slug).filter((s) => s.startsWith(prefix));
			} catch { return []; }
		},
		handler: async (argsString, ctx) => {
			const slug = argsString.trim();
			const url = slug
				? `${baseUrl()}/workflows/edit/${encodeURIComponent(slug)}`
				: `${baseUrl()}/workflows`;
			// macOS `open` falls back to default browser if no companion is registered for the URL.
			try {
				spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
				ctx.ui.notify(`Opening ${url}`, "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed to open ${url}: ${e?.message ?? e}`, "warning");
			}
		},
	});

	pi.registerCommand("apps-watch", {
		description: "Watch an in-flight workflow run via SSE (prints final state).",
		handler: async (argsString, ctx) => {
			const runId = Number.parseInt(argsString.trim(), 10);
			if (!Number.isFinite(runId)) {
				ctx.ui.notify("Usage: /apps-watch <run_id>", "warning");
				return;
			}
			const ac = new AbortController();
			inflight.add(ac);
			try {
				ctx.ui.notify(`Watching run #${runId}…`, "info");
				const result = await watchRun(runId, { signal: ac.signal, ctx });
				ctx.ui.notify(`Run #${runId} → ${result.state} (${result.reason})`, "info");
			} catch (e: any) {
				ctx.ui.notify(`apps-watch failed: ${e?.message ?? e}`, "warning");
			} finally {
				inflight.delete(ac);
			}
		},
	});

	// ───────────────────── Lifecycle ─────────────────────

	pi.on("session_shutdown", async () => {
		for (const ac of inflight) {
			try { ac.abort(); } catch { /* ignore */ }
		}
		inflight.clear();
	});
}
