/**
 * cairn-spawn — Spawn pi sessions in new Cairn tabs via OSC 7727
 *
 * Commands:
 *   /st [prompt]  - New vertical tab, start a pi session
 *   /sn [prompt]  - New tab group, start a pi session
 *
 * How it works:
 *   1. Forks the current session file so the spawned pi gets full conversation context
 *   2. Emits an OSC 7727 escape sequence to Cairn requesting a new tab (or tab group)
 *   3. Cairn creates the tab and runs the specified command in it
 *
 * Detection:
 *   Uses TERM_PROGRAM=ghostty to confirm we're inside Ghostty.
 *
 * Configuration:
 *   --spawn-cmd <cmd>  Command used to launch pi in spawned tabs.
 *                      Defaults to PI_SPAWN_CMD env var, then "pi".
 */

import { copyFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function isInsideGhostty(): boolean {
	return process.env.TERM_PROGRAM === "ghostty";
}

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function forkSessionFile(sourceFile: string, id: string): string {
	const forked = join(dirname(sourceFile), `spawn-${id}.jsonl`);
	copyFileSync(sourceFile, forked);
	return forked;
}

function detectPiCommand(): string {
	// Resolve the actual pi script/binary path, ignoring PI_SPAWN_CMD
	// which may contain env var assignments that don't work with exec
	try {
		const which = require("node:child_process")
			.execSync("which pi", { encoding: "utf-8" })
			.trim();
		if (which) return which;
	} catch {}
	return "pi";
}

function escapeShellArg(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Emit an OSC 7727 escape sequence to request Cairn to perform an action.
 *
 * Format: \x1b]7727;key=value;key=value\x07
 *
 * Supported keys:
 *   action  - "new-tab" or "new-tab-group"
 *   command - shell command to run in the new tab
 *   cwd     - working directory for the new tab
 *   title   - optional title for the tab
 */
function emitOsc7727(params: Record<string, string>): void {
	const payload = Object.entries(params)
		.map(([k, v]) => `${k}=${v}`)
		.join(";");
	const sequence = `\x1b]7727;${payload}\x07`;
	// Debug: log the exact sequence being sent
	require("node:fs").writeFileSync("/tmp/cairn-spawn-debug.txt", `payload: ${payload}\nfull: ${JSON.stringify(sequence)}\n`);
	try {
		const fd = openSync("/dev/tty", "w");
		writeSync(fd, sequence);
		closeSync(fd);
	} catch {
		process.stdout.write(sequence);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("spawn-cmd", {
		description: "Command to launch pi in spawned Cairn tabs (default: PI_SPAWN_CMD env var or 'pi')",
		type: "string",
	});

	async function handleSpawn(
		action: "new-tab" | "new-tab-group",
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!isInsideGhostty()) {
			ctx.ui.notify("Not running inside Cairn. This command requires the Cairn terminal.", "error");
			return;
		}

		const id = generateId();
		const prompt = args.trim();

		const flagVal = pi.getFlag("spawn-cmd");
		const piCmd = typeof flagVal === "string" && flagVal ? flagVal : detectPiCommand();

		let forkedFile: string | undefined;
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		if (currentSessionFile && existsSync(currentSessionFile)) {
			try {
				forkedFile = forkSessionFile(currentSessionFile, id);
			} catch {
				// Not fatal; fall back to a fresh session
			}
		}

		const piArgs: string[] = [];
		if (forkedFile) {
			piArgs.push("--session", forkedFile);
		} else {
			piArgs.push("--no-session");
		}
		if (prompt) {
			piArgs.push(`"${prompt.replace(/"/g, '\\"')}"`);
		}

		// Wrap in user's login shell so PATH is properly set up (for node/fnm/nvm).
		// Ghostty's login(1) wrapper uses bash --noprofile --norc internally,
		// so we need our own login shell to get the proper environment.
		const rawCmd = `${piCmd} ${piArgs.join(" ")}`;
		const shell = process.env.SHELL || "/bin/zsh";
		const command = `${shell} -li -c 'exec ${rawCmd.replace(/'/g, "'\\''")}'`;

		emitOsc7727({
			action,
			command,
			cwd: ctx.cwd,
			...(prompt ? { title: prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt } : {}),
		});

		const icon = action === "new-tab" ? "⊕" : "⊞";
		const contextNote = forkedFile ? " (with context)" : "";
		const desc = prompt ? `"${prompt.length > 50 ? `${prompt.slice(0, 50)}…` : prompt}"` : "(no initial prompt)";
		ctx.ui.notify(`${icon} Spawned pi tab${contextNote}: ${desc}`, "info");
	}

	pi.registerCommand("st", {
		description: "Spawn a pi session in a new Cairn tab",
		handler: async (args, ctx) => handleSpawn("new-tab", args, ctx),
	});

	pi.registerCommand("sn", {
		description: "Spawn a pi session in a new Cairn tab group",
		handler: async (args, ctx) => handleSpawn("new-tab-group", args, ctx),
	});
}
