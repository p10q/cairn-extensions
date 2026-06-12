/**
 * cairn-tab-status — Emit OSC 7727 escape sequences so Cairn/Ghostty can show live
 *              session status (streaming, tool, compacting, error, idle) in
 *              the terminal tab title.
 *
 * Hooks into pi's extension event system: message_start/update/end,
 * tool_execution_start/end, session_before_compact/compact, agent_end,
 * session_shutdown.
 *
 * Detection: TERM_PROGRAM === "ghostty" (Cairn preserves this for upstream
 * rebase compatibility) AND stdout.isTTY. Emits nothing in any other terminal
 * and nothing under `pi -p` / non-interactive runs.
 *
 * OSC payload format (matches the Cairn fork's reader):
 *   ESC ] 7727 ; action=set-tab-status ; status=<s> ; activity=<a> [ ; tool=<t> ] ; updated=<unix> ESC \
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TabStatus = "idle" | "streaming" | "tool" | "compacting" | "error";

interface TabStatusUpdate {
	status: TabStatus;
	activity: string;
	tool?: string;
}

function urlEncode(value: string): string {
	return value.replace(/%/g, "%25").replace(/;/g, "%3B").replace(/\\/g, "%5C");
}

function writeOsc(payload: string): void {
	process.stdout.write(`\x1b]7727;${payload}\x1b\\`);
}

class TabStatusEmitter {
	private enabled: boolean;

	constructor() {
		this.enabled = process.env.TERM_PROGRAM === "ghostty" && process.stdout.isTTY === true;
	}

	setStatus(update: TabStatusUpdate): void {
		if (!this.enabled) return;
		const parts = [
			"action=set-tab-status",
			`status=${urlEncode(update.status)}`,
			`activity=${urlEncode(update.activity)}`,
		];
		if (update.tool) parts.push(`tool=${urlEncode(update.tool)}`);
		parts.push(`updated=${Math.floor(Date.now() / 1000)}`);
		writeOsc(parts.join(";"));
	}

	clear(): void {
		if (!this.enabled) return;
		writeOsc("action=clear-tab-status");
	}
}

/** Cap activity strings at this length so the tab title doesn't blow up. */
const ACTIVITY_MAX = 60;

function clip(s: string): string {
	if (s.length <= ACTIVITY_MAX) return s;
	return `${s.slice(0, ACTIVITY_MAX - 1)}…`;
}

/** Best-effort: pull a representative single-line activity string from a
 *  tool call's argument record. Mirrors the formatter used by the
 *  upstream interactive mode for consistent labels. */
function formatToolActivity(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "Bash": {
			const cmd = typeof a.command === "string" ? a.command : "";
			return clip(`Bash: ${cmd}`);
		}
		case "Read": {
			const p = typeof a.path === "string" ? a.path : "";
			return clip(`Read: ${p}`);
		}
		case "Edit":
		case "Write": {
			const p = typeof a.path === "string" ? a.path : "";
			return clip(`${toolName}: ${p}`);
		}
		case "Grep":
		case "Find": {
			const pat = typeof a.pattern === "string" ? a.pattern : "";
			return clip(`${toolName}: ${pat}`);
		}
		case "Ls": {
			const p = typeof a.path === "string" ? a.path : "";
			return clip(`Ls: ${p}`);
		}
		default:
			return clip(toolName);
	}
}

/** Extract a streaming-friendly preview from an in-flight assistant message.
 *  Pi's MessageUpdateEvent shape: a content array of blocks, where text
 *  blocks have a `text` field. We grab the latest text content and clip it.
 *  Defensive: any shape mismatch falls through to a generic "Responding…". */
function previewFromMessage(message: unknown): string {
	const m = message as { content?: Array<{ type?: string; text?: string }> } | undefined;
	const content = m?.content ?? [];
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			return clip(block.text.replace(/\s+/g, " ").trim());
		}
	}
	return "Responding…";
}

export default function tabStatusExtension(pi: ExtensionAPI) {
	const emitter = new TabStatusEmitter();
	let lastStreamingActivity = "";

	pi.on("message_start", () => {
		emitter.setStatus({ status: "streaming", activity: "Responding…" });
		lastStreamingActivity = "Responding…";
	});

	pi.on("message_update", (event: any) => {
		const activity = previewFromMessage(event?.message);
		lastStreamingActivity = activity;
		emitter.setStatus({ status: "streaming", activity });
	});

	pi.on("message_end", () => {
		emitter.setStatus({ status: "idle", activity: lastStreamingActivity });
	});

	pi.on("tool_execution_start", (event: any) => {
		const activity = formatToolActivity(event?.toolName ?? "", event?.args);
		emitter.setStatus({ status: "tool", activity, tool: event?.toolName });
	});

	pi.on("tool_execution_end", () => {
		// Back to thinking state; the next message_update will overwrite if
		// the model resumes streaming text.
		emitter.setStatus({ status: "streaming", activity: lastStreamingActivity || "Thinking…" });
	});

	pi.on("session_before_compact", () => {
		emitter.setStatus({ status: "compacting", activity: "Compacting context…" });
	});

	pi.on("session_compact", () => {
		emitter.setStatus({ status: "idle", activity: lastStreamingActivity });
	});

	pi.on("agent_end", () => {
		emitter.setStatus({ status: "idle", activity: lastStreamingActivity });
	});

	pi.on("session_shutdown", () => {
		emitter.clear();
	});
}
