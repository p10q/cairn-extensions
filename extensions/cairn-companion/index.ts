import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { connect, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Playwright is lazy-loaded inside CDP-using helpers so the IPC tools work even if
// playwright-core fails to install or load. CDP tools surface a clear error if missing.
import type {
	Browser,
	BrowserContext,
	Page,
	Request as PWRequest,
	Response as PWResponse,
	CDPSession,
} from "playwright-core";

// ─── Swift IPC socket (Ghostty / Cairn companion control plane) ─────────────
// Forks of Ghostty (e.g. Cairn at ~/.cairn/state/companion.sock) write the
// socket under a different bundle directory. Resolve at call-time so we pick
// up whichever socket exists, with an explicit env override always winning.
const SOCKET_CANDIDATES = [
	join(homedir(), ".local", "state", "ghostty", "companion.sock"),
	join(homedir(), ".cairn", "state", "companion.sock"),
];
function resolveSocketPath(): string {
	if (process.env.GHOSTTY_COMPANION_SOCKET) return process.env.GHOSTTY_COMPANION_SOCKET;
	for (const p of SOCKET_CANDIDATES) {
		if (existsSync(p)) return p;
	}
	return SOCKET_CANDIDATES[0]; // fall back to canonical path so error messages are stable
}
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 50 * 1024;

// Per-controller id (Ghostty sets this env var on every shell spawned inside the
// surface). When present, every IPC call carries it so the server routes to *our*
// companion pane instead of "whichever is currently focused".
//
// Captured at startup, but `companion_attach` can override it at runtime so a pi
// session can migrate to a freshly-opened companion (e.g. after the user closes-
// and-reopens the pane to recover from expired AEA cookies) without restarting
// the pi process. Both IPC- and CDP-based tools below read activeCompanionId(),
// so the override flows through everywhere — no separate state in two places.
const ENV_COMPANION_ID = process.env.GHOSTTY_COMPANION_ID;
let runtimeCompanionIdOverride: string | undefined;

function activeCompanionId(): string | undefined {
	return runtimeCompanionIdOverride ?? ENV_COMPANION_ID;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

let socket: Socket | null = null;
let nextId = 1;
let pending = new Map<number, PendingRequest>();
let buffer = "";

function disconnect(): void {
	if (socket) {
		socket.removeAllListeners();
		socket.destroy();
		socket = null;
	}
	for (const [, req] of pending) {
		clearTimeout(req.timer);
		req.reject(new Error("Connection closed"));
	}
	pending.clear();
	buffer = "";
}

function connectToSocket(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (socket) {
			resolve();
			return;
		}

		const socketPath = resolveSocketPath();
		const timer = setTimeout(() => {
			disconnect();
			reject(new Error(`Connection timeout: could not connect to ${socketPath} within ${CONNECT_TIMEOUT_MS}ms`));
		}, CONNECT_TIMEOUT_MS);

		const sock = connect(socketPath, () => {
			clearTimeout(timer);
			socket = sock;
			resolve();
		});

		sock.setEncoding("utf-8");

		sock.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					const req = pending.get(msg.id);
					if (req) {
						clearTimeout(req.timer);
						pending.delete(msg.id);
						if (msg.error) {
							req.reject(new Error(msg.error));
						} else {
							req.resolve(msg.result);
						}
					}
				} catch {
					// Ignore malformed lines
				}
			}
		});

		sock.on("error", (err) => {
			clearTimeout(timer);
			disconnect();
			reject(err);
		});

		sock.on("close", () => {
			disconnect();
		});
	});
}

async function ensureConnected(): Promise<void> {
	if (socket && !socket.destroyed) return;
	socket = null;
	await connectToSocket();
}

async function sendRequest(method: string, params: Record<string, any> = {}): Promise<any> {
	await ensureConnected();

	const id = nextId++;
	const boundCompanionId = activeCompanionId();
	const mergedParams = boundCompanionId && params.companionId === undefined
		? { ...params, companionId: boundCompanionId }
		: params;
	const msg = JSON.stringify({ id, method, params: mergedParams }) + "\n";

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
		}, REQUEST_TIMEOUT_MS);

		pending.set(id, { resolve, reject, timer });
		socket!.write(msg, (err) => {
			if (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(err);
			}
		});
	});
}

function truncateText(text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= MAX_RESULT_BYTES) return text;
	const buf = Buffer.from(text, "utf-8");
	const truncated = buf.subarray(0, MAX_RESULT_BYTES).toString("utf-8");
	return truncated + `\n\n[Truncated: output exceeded ${MAX_RESULT_BYTES / 1024}KB]`;
}

// ─── CDP (Chrome DevTools Protocol) — port discovery ────────────────────────
// Contract documented in ghostty's docs/companion-cdp-sidecar.md. Any change to
// env var name, sidecar path, or fallback port must be kept in sync with
// macos/Sources/Helpers/CEF/GhosttyCEFBrowser.mm.
const CDP_ENV_VAR = "GHOSTTY_CDP_PORT";
const CDP_SIDECAR = join(homedir(), "Library", "Caches", "com.mitchellh.ghostty", "cdp-port");
const CDP_FALLBACK_PORT = 9222;

function discoverCdpPort(): number {
	const env = process.env[CDP_ENV_VAR];
	if (env) return parseInt(env, 10);
	if (existsSync(CDP_SIDECAR)) {
		const v = readFileSync(CDP_SIDECAR, "utf8").trim();
		if (/^\d+$/.test(v)) return parseInt(v, 10);
	}
	return CDP_FALLBACK_PORT;
}

// ─── CDP — lazy playwright-core loader ──────────────────────────────────────
let chromiumImpl: any = null;
async function loadChromium(): Promise<any> {
	if (chromiumImpl) return chromiumImpl;
	try {
		const pw = await import("playwright-core");
		chromiumImpl = pw.chromium;
		return chromiumImpl;
	} catch (err: any) {
		throw new Error(
			"playwright-core not available; CDP-based companion tools require it. " +
				"Run: cd ~/.pi/agent/extensions/cairn-companion && npm install",
		);
	}
}

// ─── CDP — ring buffers ─────────────────────────────────────────────────────
const MAX_NET = 500;
const MAX_CONSOLE = 500;
const MAX_BODY_PREVIEW = 4096;

type NetEntry = {
	id: number;
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	statusText?: string;
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	requestPostData?: string;
	contentType?: string;
	bodyPreview?: string | null; // null = binary or too large; undefined = not yet captured
	bodyBytes?: number;
	startedAt: number;
	durationMs?: number;
	failed?: string;
	pageUrl: string;
	requestRef: PWRequest;
	responseRef?: PWResponse;
};

type ConsoleEntry = {
	id: number;
	type: string; // log, warn, error, info, debug, trace
	text: string;
	location?: string;
	at: number;
	pageUrl: string;
};

const netBuffer: NetEntry[] = [];
const consoleBuffer: ConsoleEntry[] = [];
let nextNetId = 1;
let nextConsoleId = 1;

function pushNet(e: NetEntry) {
	netBuffer.push(e);
	if (netBuffer.length > MAX_NET) netBuffer.shift();
}
function pushConsole(e: ConsoleEntry) {
	consoleBuffer.push(e);
	if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
}

// ─── CDP — connection state ─────────────────────────────────────────────────
let browser: Browser | null = null;
let attachedPage: Page | null = null;
let attachedContext: BrowserContext | null = null;
let attachInProgress: Promise<Page> | null = null;

async function pickActivePage(b: Browser): Promise<Page> {
	const allPages: Page[] = [];
	for (const ctx of b.contexts()) {
		for (const p of ctx.pages()) allPages.push(p);
	}
	if (allPages.length === 0) throw new Error("no pages found in companion CEF");

	// Strongest identification: stamp a unique marker into OUR companion pane via
	// the Ghostty IPC socket (which routes by activeCompanionId()), then find the
	// matching CDP Page by reading the marker. Page references are stable across
	// navigations, so we only need to do this once per attach.
	const id = activeCompanionId();
	if (id) {
		const marker = `pi-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			await sendRequest("evaluate", {
				expression: `window.__piCompanionMarker = ${JSON.stringify(marker)}`,
				awaitPromise: false,
			});
			for (const p of allPages) {
				try {
					const found = await p.evaluate(() => (window as any).__piCompanionMarker);
					if (found === marker) return p;
				} catch {
					// page may have navigated/closed; skip
				}
			}
		} catch {
			// IPC evaluate failed; fall through to URL match
		}
	}

	// Fallback: prefer the page whose URL matches what the IPC socket reports.
	let preferredUrl: string | undefined;
	try {
		const status = await sendRequest("status", {});
		preferredUrl = status?.url;
	} catch {
		// socket may not be running; fall back to any page
	}
	if (preferredUrl) {
		const match = allPages.find((p) => p.url() === preferredUrl);
		if (match) return match;
	}
	return allPages[0];
}

function wireListeners(page: Page) {
	page.on("console", (msg) => {
		const loc = msg.location();
		pushConsole({
			id: nextConsoleId++,
			type: msg.type(),
			text: msg.text(),
			location: loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
			at: Date.now(),
			pageUrl: page.url(),
		});
	});
	page.on("pageerror", (err) => {
		pushConsole({
			id: nextConsoleId++,
			type: "pageerror",
			text: `${err.name}: ${err.message}\n${err.stack ?? ""}`.slice(0, 4000),
			at: Date.now(),
			pageUrl: page.url(),
		});
	});

	const reqMap = new WeakMap<PWRequest, NetEntry>();
	page.on("request", (req) => {
		const entry: NetEntry = {
			id: nextNetId++,
			method: req.method(),
			url: req.url(),
			resourceType: req.resourceType(),
			requestHeaders: req.headers(),
			requestPostData: (req.postData() ?? undefined)?.slice(0, MAX_BODY_PREVIEW),
			startedAt: Date.now(),
			pageUrl: page.url(),
			requestRef: req,
		};
		reqMap.set(req, entry);
		pushNet(entry);
	});
	page.on("response", async (res) => {
		const entry = reqMap.get(res.request());
		if (!entry) return;
		entry.status = res.status();
		entry.statusText = res.statusText();
		entry.responseHeaders = res.headers();
		entry.contentType = res.headers()["content-type"];
		entry.durationMs = Date.now() - entry.startedAt;
		entry.responseRef = res;
		const ct = entry.contentType ?? "";
		if (ct.includes("json") || ct.includes("text") || ct.includes("javascript") || ct.includes("xml")) {
			try {
				const buf = await res.body();
				entry.bodyBytes = buf.length;
				entry.bodyPreview = buf.toString("utf8").slice(0, MAX_BODY_PREVIEW);
			} catch {
				entry.bodyPreview = null;
			}
		} else {
			entry.bodyPreview = null;
		}
	});
	page.on("requestfailed", (req) => {
		const entry = reqMap.get(req);
		if (!entry) return;
		entry.failed = req.failure()?.errorText ?? "unknown";
		entry.durationMs = Date.now() - entry.startedAt;
	});
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) {
			pushConsole({
				id: nextConsoleId++,
				type: "navigation",
				text: `→ ${frame.url()}`,
				at: Date.now(),
				pageUrl: page.url(),
			});
		}
	});
	page.on("close", () => {
		if (attachedPage === page) {
			attachedPage = null;
		}
	});
}

async function ensureAttached(): Promise<Page> {
	if (attachedPage && !attachedPage.isClosed()) return attachedPage;
	if (attachInProgress) return attachInProgress;
	attachInProgress = (async () => {
		const port = discoverCdpPort();
		if (!browser || !browser.isConnected()) {
			const chromium = await loadChromium();
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			browser!.on("disconnected", () => {
				browser = null;
				attachedPage = null;
				attachedContext = null;
			});
		}
		const page = await pickActivePage(browser!);
		attachedPage = page;
		attachedContext = page.context();
		wireListeners(page);
		return page;
	})();
	try {
		return await attachInProgress;
	} finally {
		attachInProgress = null;
	}
}

function summarizeNet(e: NetEntry): string {
	const status = e.failed ? `FAIL(${e.failed})` : e.status ?? "...";
	const ms = e.durationMs !== undefined ? `${e.durationMs}ms` : " - ";
	return `#${e.id} [${e.resourceType}] ${e.method} ${status} ${ms} ${e.url}`;
}

function matchUrl(url: string, pattern?: string): boolean {
	if (!pattern) return true;
	try {
		const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
		return re.test(url);
	} catch {
		return url.includes(pattern);
	}
}

export default function (pi: ExtensionAPI) {
	// --- companion_evaluate ---
	// --- companion_navigate ---
	pi.registerTool({
		name: "companion_navigate",
		label: "Companion Navigate",
		description: "Navigate the existing Cairn companion pane to a URL or local file (in-place, reuses the same pane). Prefer this over companion_open whenever the pane is already active.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to navigate to" })),
			file: Type.Optional(Type.String({ description: "Local file path to load" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!params.url && !params.file) {
				return {
					content: [{ type: "text", text: "Error: must provide either url or file" }],
					details: {},
					isError: true,
				};
			}
			try {
				const reqParams: Record<string, string> = {};
				if (params.file) reqParams.file = params.file;
				else if (params.url) reqParams.url = params.url;

				await sendRequest("navigate", reqParams);
				const target = params.file ?? params.url;
				return {
					content: [{ type: "text", text: `Navigated to: ${target}` }],
					details: { target },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_navigate "));
			text += theme.fg("accent", args.file ?? args.url ?? "");
			return new Text(text, 0, 0);
		},
	});

	// --- companion_screenshot ---
	pi.registerTool({
		name: "companion_screenshot",
		label: "Companion Screenshot",
		description: "Take a screenshot of the Cairn companion pane content.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({ description: "Capture the full scrollable page. Default: false" })
			),
			format: Type.Optional(
				StringEnum(["png", "jpeg"] as const, { description: "Image format. Default: png" })
			),
			quality: Type.Optional(
				Type.Number({ description: "JPEG quality 0-100. Only applies to jpeg format. Default: 80" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const format = params.format ?? "png";
				const result = await sendRequest("screenshot", {
					fullPage: params.fullPage ?? false,
					format,
					quality: params.quality ?? 80,
				});

				const data = typeof result === "object" && result.data ? result.data : result;
				const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

				return {
					content: [{ type: "image", mimeType, data }],
					details: { format, fullPage: params.fullPage ?? false },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_screenshot"));
			if (args.fullPage) text += " " + theme.fg("muted", "full page");
			if (args.format) text += " " + theme.fg("dim", args.format);
			return new Text(text, 0, 0);
		},
		renderResult(_result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Capturing..."), 0, 0);
			return new Text(theme.fg("success", "Screenshot captured"), 0, 0);
		},
	});

	// --- companion_snapshot ---
	pi.registerTool({
		name: "companion_snapshot",
		label: "Companion Snapshot",
		description:
			"Get the DOM tree of the companion pane as a simplified accessible structure. " +
			"Useful for understanding page layout without a screenshot.",
		parameters: Type.Object({
			depth: Type.Optional(
				Type.Number({ description: "Maximum depth to traverse. Default: 10" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await sendRequest("snapshot", {
					depth: params.depth ?? 10,
				});
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return {
					content: [{ type: "text", text: truncateText(text) }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_snapshot"));
			if (args.depth) text += " " + theme.fg("dim", `depth=${args.depth}`);
			return new Text(text, 0, 0);
		},
	});

	// --- companion_get_content ---
	pi.registerTool({
		name: "companion_get_content",
		label: "Companion Get Content",
		description: "Get the full HTML content of the current companion page.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const result = await sendRequest("get_content", {});
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return {
					content: [{ type: "text", text: truncateText(text) }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_get_content")), 0, 0);
		},
	});

	// --- companion_open ---
	pi.registerTool({
		name: "companion_open",
		label: "Companion Open",
		description: "Open/spawn the Cairn companion pane with specific content. Use this only when the pane is not already active; otherwise use companion_navigate to reuse the existing pane. If called while a pane is already active, this tool will transparently fall back to companion_navigate.",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Local file path to display" })),
			url: Type.Optional(Type.String({ description: "URL to display" })),
			mode: Type.Optional(
				StringEnum(["minimal", "split"] as const, { description: "Display mode. Default: split" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const reqParams: Record<string, any> = {};
				if (params.file) reqParams.file = params.file;
				if (params.url) reqParams.url = params.url;
				if (params.mode) reqParams.mode = params.mode;

				// If the companion pane is already active, reuse it via navigate
				// instead of spawning a new one. Only url/file are forwarded; mode
				// is ignored since the pane already exists.
				let alreadyActive = false;
				if (params.url || params.file) {
					try {
						const status: any = await sendRequest("status", {});
						alreadyActive = !!(status && status.active);
					} catch {
						alreadyActive = false;
					}
				}

				const target = params.file ?? params.url ?? "(empty)";

				if (alreadyActive) {
					const navParams: Record<string, string> = {};
					if (params.file) navParams.file = params.file;
					else if (params.url) navParams.url = params.url;
					await sendRequest("navigate", navParams);
					return {
						content: [{ type: "text", text: `Companion already active; navigated to: ${target}` }],
						details: { target, mode: params.mode, reused: true },
					};
				}

				await sendRequest("open", reqParams);
				return {
					content: [{ type: "text", text: `Companion opened: ${target}` }],
					details: { target, mode: params.mode, reused: false },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_open "));
			text += theme.fg("accent", args.file ?? args.url ?? "");
			if (args.mode) text += " " + theme.fg("dim", args.mode);
			return new Text(text, 0, 0);
		},
	});

	// --- companion_reload ---
	pi.registerTool({
		name: "companion_reload",
		label: "Companion Reload",
		description: "Refresh the current page in the Cairn companion pane.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await sendRequest("reload", {});
				return {
					content: [{ type: "text", text: "Companion reloaded" }],
					details: {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_reload")), 0, 0);
		},
	});

	// --- companion_status ---
	pi.registerTool({
		name: "companion_status",
		label: "Companion Status",
		description: "Check if the Cairn companion pane is active and get current URL and title.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const result = await sendRequest("status", {});
				const info = typeof result === "object" ? result : { active: true, raw: result };
				return {
					content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
					details: info,
				};
			} catch (err: any) {
				if (err.message.includes("ENOENT") || err.message.includes("ECONNREFUSED") || err.message.includes("Connection timeout")) {
					return {
						content: [{ type: "text", text: JSON.stringify({ active: false, error: err.message }, null, 2) }],
						details: { active: false },
					};
				}
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_status")), 0, 0);
		},
	});

	// --- companion_list ---
	pi.registerTool({
		name: "companion_list",
		label: "Companion List",
		description:
			"List live Cairn companion pane(s) known to the IPC server with its companionId, url, title, and active flag. " +
			"By default only shows the companion bound to this session (same tab). Pass all=true to see companions in other " +
			"tabs (e.g. after closing and reopening the pane to recover from expired AEA cookies).",
		parameters: Type.Object({
			all: Type.Optional(
				Type.Boolean({ description: "Show companions from ALL tabs, not just this session's. Default: false." })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await sendRequest("companions/list", {});
				const companions = (result && (result as any).companions) ?? [];
				const current = activeCompanionId();
				const annotated = (companions as any[]).map((c) => ({
					...c,
					attached: c.companionId === current,
				}));

				// By default, only show the companion for this session's tab.
				const showAll = params.all === true;
				const filtered = showAll
					? annotated
					: annotated.filter((c) => c.companionId === current);

				const output: any = { attached: current, companions: filtered };
				if (!showAll && annotated.length > filtered.length) {
					output.note = `${annotated.length - filtered.length} companion(s) in other tabs hidden. Pass all=true to see them.`;
				}

				return {
					content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
					details: { count: filtered.length, total: annotated.length, attached: current },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_list"));
			if (args.all) text += theme.fg("accent", " (all tabs)");
			return new Text(text, 0, 0);
		},
	});

	// --- companion_attach ---
	pi.registerTool({
		name: "companion_attach",
		label: "Companion Attach",
		description:
			"Switch the pi session's bound companionId at runtime. Subsequent companion_* IPC calls will target the given " +
			"companionId instead of the env-derived one. Pass an empty string or omit companionId to clear the override and " +
			"fall back to GHOSTTY_COMPANION_ID. ⚠️ Only use this when the user explicitly asks to drive another tab's companion " +
			"or when recovering from a closed/reopened pane. Never attach to another tab's companion unprompted.",
		parameters: Type.Object({
			companionId: Type.Optional(
				Type.String({ description: "Target companionId. Empty/omitted clears the runtime override." })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const id = params.companionId?.trim();
			if (!id) {
				runtimeCompanionIdOverride = undefined;
				const fallback = ENV_COMPANION_ID;
				return {
					content: [{ type: "text", text: `Cleared runtime companion override; now bound to: ${fallback ?? "(active companion)"}` }],
					details: { attached: fallback, cleared: true },
				};
			}

			// Validate the id exists before locking pi onto it.
			try {
				const result = await sendRequest("companions/list", {});
				const companions: any[] = (result && (result as any).companions) ?? [];
				const match = companions.find((c) => c.companionId === id);
				if (!match) {
					return {
						content: [{ type: "text", text: `Error: no companion with id ${id}. Run companion_list to see live ids.` }],
						details: {},
						isError: true,
					};
				}
				runtimeCompanionIdOverride = id;
				return {
					content: [{ type: "text", text: `Attached to companion ${id} (${match.url ?? "no url"})` }],
					details: { attached: id, url: match.url, title: match.title },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("companion_attach "));
			text += theme.fg("accent", args.companionId ?? "(clear)");
			return new Text(text, 0, 0);
		},
	});

	// --- companion_reload_auth ---
	pi.registerTool({
		name: "companion_reload_auth",
		label: "Companion Reload Auth",
		description:
			"Re-inject auth cookies (e.g. ~/.midway/cookie via ~/.config/ghostty/companion-auth.json) into the running CEF " +
			"browser without closing the pane. Use after `mwinit` refreshes Midway cookies and the companion shows " +
			"`AEA verification failed: used_too_late` on internal pages. Avoids the close-and-reopen workaround.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const result = await sendRequest("reload_auth", {});
				return {
					content: [{ type: "text", text: `Auth cookies re-injected for companion ${(result as any)?.companionId ?? "(active)"}` }],
					details: result ?? {},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_reload_auth")), 0, 0);
		},
	});

	// Cleanup on session shutdown
	// ── companion_eval ──
	pi.registerTool({
		name: "companion_eval",
		label: "Companion Eval",
		description:
			"Evaluate a JavaScript function in the Cairn companion's active page and return its value. " +
			"Replaces companion_evaluate (which has a known null-return bug) by going through CDP via Playwright. " +
			"The expression should be a function declaration like `() => document.title` or `async () => { ... }`. " +
			"Plain expressions (e.g. `1+1`) are also accepted and evaluated as-is.",
		parameters: Type.Object({
			fn: Type.String({
				description:
					"Function declaration to invoke, e.g. `() => document.title` or `async () => fetch('/api').then(r => r.json())`. A plain expression is also accepted.",
			}),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const src = params.fn.trim();
				const looksLikeFn = /^\s*(async\s*)?(\([^)]*\)\s*=>|function\b)/.test(src);
				const wrapped = looksLikeFn ? src : `() => (${src})`;
				// Playwright expects a function-as-string; pass via Function constructor on page side.
				const result = await page.evaluate((s: string) => {
					// eslint-disable-next-line no-new-func
					const f = new Function(`return (${s})`)();
					return Promise.resolve(typeof f === "function" ? f() : f);
				}, wrapped);
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return { content: [{ type: "text", text: text ?? "undefined" }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			const expr = args.fn.length > 80 ? args.fn.slice(0, 77) + "..." : args.fn;
			return new Text(theme.fg("toolTitle", theme.bold("companion_eval ")) + theme.fg("dim", expr), 0, 0);
		},
	});

	// ── companion_console_log ──
	pi.registerTool({
		name: "companion_console_log",
		label: "Companion Console",
		description:
			"List recent console messages (log, warn, error, info, pageerror, navigation) from the companion's active page. Buffer holds up to 500 entries. Filterable by type and substring.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Max entries to return (most recent). Default 50." })),
			types: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Filter by message types: log, warn, error, info, debug, trace, pageerror, navigation. Default: all.",
				}),
			),
			contains: Type.Optional(Type.String({ description: "Only return entries whose text contains this substring." })),
			sinceId: Type.Optional(Type.Number({ description: "Only return entries with id > sinceId." })),
		}),
		async execute(_id, params) {
			await ensureAttached(); // ensures listeners are wired
			const limit = params.limit ?? 50;
			const types = params.types?.length ? new Set(params.types) : null;
			const contains = params.contains;
			const sinceId = params.sinceId ?? 0;
			const filtered = consoleBuffer.filter(
				(e) =>
					e.id > sinceId &&
					(!types || types.has(e.type)) &&
					(!contains || e.text.includes(contains)),
			);
			const slice = filtered.slice(-limit);
			const lines = slice.map(
				(e) =>
					`#${e.id} [${e.type}] ${new Date(e.at).toISOString().slice(11, 19)} ${e.text}` +
					(e.location ? ` @ ${e.location}` : ""),
			);
			const text = `${slice.length} of ${filtered.length} matching (buffer total ${consoleBuffer.length}/${MAX_CONSOLE}):\n` +
				(lines.join("\n") || "(none)");
			return { content: [{ type: "text", text }], details: {} };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_console_log")), 0, 0);
		},
	});

	// ── companion_network_list ──
	pi.registerTool({
		name: "companion_network_list",
		label: "Companion Network List",
		description:
			"List recent network requests captured from the companion's active page (fetch, xhr, document, image, script, etc.). Buffer holds up to 500 entries. Filterable by URL glob, resource type, status, and id.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Max entries to return (most recent). Default 50." })),
			urlContains: Type.Optional(Type.String({ description: "Substring or glob (* wildcards) the URL must match." })),
			resourceTypes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Filter by resource type: fetch, xhr, document, script, stylesheet, image, font, websocket, ...",
				}),
			),
			statusMin: Type.Optional(Type.Number({ description: "Only include responses with status >= this." })),
			failedOnly: Type.Optional(Type.Boolean({ description: "Only include requests that failed at the network layer." })),
			sinceId: Type.Optional(Type.Number({ description: "Only return entries with id > sinceId." })),
		}),
		async execute(_id, params) {
			await ensureAttached();
			const limit = params.limit ?? 50;
			const types = params.resourceTypes?.length ? new Set(params.resourceTypes) : null;
			const filtered = netBuffer.filter((e) => {
				if (e.id <= (params.sinceId ?? 0)) return false;
				if (types && !types.has(e.resourceType)) return false;
				if (params.urlContains && !matchUrl(e.url, params.urlContains)) return false;
				if (params.statusMin !== undefined && (e.status ?? 0) < params.statusMin) return false;
				if (params.failedOnly && !e.failed) return false;
				return true;
			});
			const slice = filtered.slice(-limit);
			const lines = slice.map(summarizeNet);
			const text = `${slice.length} of ${filtered.length} matching (buffer total ${netBuffer.length}/${MAX_NET}):\n` +
				(lines.join("\n") || "(none)") +
				`\n\nUse companion_network_get with id=N for headers + body.`;
			return { content: [{ type: "text", text }], details: {} };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_network_list")), 0, 0);
		},
	});

	// ── companion_network_get ──
	pi.registerTool({
		name: "companion_network_get",
		label: "Companion Network Get",
		description:
			"Get full details (request + response headers, post data, response body) for a single request by buffer id. Body is fetched on demand for entries that weren't auto-captured (binary or large).",
		parameters: Type.Object({
			id: Type.Number({ description: "Buffer id from companion_network_list." }),
			maxBodyBytes: Type.Optional(Type.Number({ description: "Cap body bytes returned. Default 16384." })),
		}),
		async execute(_id, params) {
			await ensureAttached();
			const entry = netBuffer.find((e) => e.id === params.id);
			if (!entry) {
				return { content: [{ type: "text", text: `No request with id=${params.id} in buffer.` }], details: {}, isError: true };
			}
			const cap = params.maxBodyBytes ?? 16384;
			let body = entry.bodyPreview;
			let bodyBytes = entry.bodyBytes;
			let bodyNote = "";
			if ((body === null || body === undefined) && entry.responseRef) {
				try {
					const buf = await entry.responseRef.body();
					bodyBytes = buf.length;
					// Guess if textual.
					const ct = entry.contentType ?? "";
					if (ct.includes("json") || ct.includes("text") || ct.includes("javascript") || ct.includes("xml") || !ct) {
						body = buf.toString("utf8");
					} else {
						body = `<binary, ${buf.length} bytes, content-type=${ct}>`;
					}
				} catch (err: any) {
					bodyNote = `\n[body fetch failed: ${err.message}]`;
				}
			}
			if (body && body.length > cap) {
				body = body.slice(0, cap) + `\n[truncated; ${body.length - cap} more bytes]`;
			}
			const fmtHeaders = (h?: Record<string, string>) =>
				h ? Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (none)";
			const out = [
				summarizeNet(entry),
				"",
				"Request headers:",
				fmtHeaders(entry.requestHeaders),
				...(entry.requestPostData ? ["", "Request body:", entry.requestPostData] : []),
				"",
				"Response headers:",
				fmtHeaders(entry.responseHeaders),
				"",
				`Response body (${bodyBytes ?? "?"} bytes):`,
				body ?? "(not captured)",
				bodyNote,
			].join("\n");
			return { content: [{ type: "text", text: out }], details: {} };
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_network_get ")) + theme.fg("dim", `#${args.id}`),
				0,
				0,
			);
		},
	});

	// ── companion_click ──
	pi.registerTool({
		name: "companion_click",
		label: "Companion Click",
		description:
			"Click an element in the companion's active page using a Playwright selector (`text=Submit`, `role=button[name='Save']`, `css=.btn-primary`, etc.).",
		parameters: Type.Object({
			selector: Type.String({ description: "Playwright selector." }),
			timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout. Default 5000." })),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.click(params.selector, { timeout: params.timeoutMs ?? 5000 });
				return { content: [{ type: "text", text: `Clicked ${params.selector}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_click ")) + theme.fg("dim", args.selector), 0, 0);
		},
	});

	// ── companion_fill ──
	pi.registerTool({
		name: "companion_fill",
		label: "Companion Fill",
		description: "Fill an input/textarea/contenteditable in the companion's active page (Playwright selector).",
		parameters: Type.Object({
			selector: Type.String(),
			value: Type.String(),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.fill(params.selector, params.value, { timeout: params.timeoutMs ?? 5000 });
				return { content: [{ type: "text", text: `Filled ${params.selector}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_fill ")) + theme.fg("dim", args.selector), 0, 0);
		},
	});

	// ── companion_wait_for ──
	pi.registerTool({
		name: "companion_wait_for",
		label: "Companion Wait For",
		description: "Wait for a selector to appear, or for a load state ('load', 'domcontentloaded', 'networkidle').",
		parameters: Type.Object({
			selector: Type.Optional(Type.String()),
			loadState: Type.Optional(Type.String({ description: "load | domcontentloaded | networkidle" })),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const timeout = params.timeoutMs ?? 10000;
				if (params.selector) {
					await page.waitForSelector(params.selector, { timeout });
					return { content: [{ type: "text", text: `Selector ready: ${params.selector}` }], details: {} };
				}
				if (params.loadState) {
					await page.waitForLoadState(params.loadState as any, { timeout });
					return { content: [{ type: "text", text: `Load state: ${params.loadState}` }], details: {} };
				}
				return { content: [{ type: "text", text: "Provide selector or loadState." }], details: {}, isError: true };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			const what = args.selector ?? args.loadState ?? "(?)";
			return new Text(theme.fg("toolTitle", theme.bold("companion_wait_for ")) + theme.fg("dim", what), 0, 0);
		},
	});

	// ── companion_a11y_snapshot (CDP-backed) ──
	pi.registerTool({
		name: "companion_a11y_snapshot",
		label: "Companion A11y Snapshot",
		description:
			"Dump the accessibility tree of the companion's active page (compact, role+name). Skips ignored nodes and inline-text leaves by default.",
		parameters: Type.Object({
			maxDepth: Type.Optional(Type.Number({ description: "Max tree depth. Default 12." })),
			includeIgnored: Type.Optional(Type.Boolean({ description: "Include ignored nodes. Default false." })),
			includeInlineText: Type.Optional(
				Type.Boolean({ description: "Include InlineTextBox / StaticText leaves. Default false." }),
			),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const session = await page.context().newCDPSession(page);
				try {
					await session.send("Accessibility.enable");
					const { nodes } = (await session.send("Accessibility.getFullAXTree")) as any;
					const byId = new Map<string, any>();
					for (const n of nodes) byId.set(n.nodeId, n);
					const roots = nodes.filter((n: any) => !n.parentId || !byId.has(n.parentId));
					const maxDepth = params.maxDepth ?? 12;
					const skipIgnored = !params.includeIgnored;
					const skipInline = !params.includeInlineText;
					const skipRoles = new Set(skipInline ? ["InlineTextBox", "StaticText", "LineBreak"] : []);
					const lines: string[] = [];
					const walk = (n: any, depth: number) => {
						if (!n) return;
						const role = n.role?.value ?? "?";
						const skipThis = (skipIgnored && n.ignored) || skipRoles.has(role);
						if (!skipThis) {
							const name = n.name?.value ? ` "${String(n.name.value).slice(0, 80)}"` : "";
							lines.push(`${"  ".repeat(depth)}${role}${name}`);
						}
						if (depth >= maxDepth) return;
						const childDepth = skipThis ? depth : depth + 1;
						(n.childIds ?? []).forEach((id: string) => byId.has(id) && walk(byId.get(id), childDepth));
					};
					roots.forEach((r: any) => walk(r, 0));
					return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }], details: {} };
				} finally {
					await session.detach().catch(() => {});
				}
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_a11y_snapshot")), 0, 0);
		},
	});

	// ── companion_press ──
	pi.registerTool({
		name: "companion_press",
		label: "Companion Press Key",
		description:
			"Press a key in the companion's active page (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Meta+a'). Optional selector to focus first.",
		parameters: Type.Object({
			key: Type.String({ description: "Playwright key string. Combos use '+': 'Control+a', 'Meta+Shift+p'." }),
			selector: Type.Optional(Type.String({ description: "Optional selector to focus before pressing." })),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				if (params.selector) {
					await page.press(params.selector, params.key, { timeout: params.timeoutMs ?? 5000 });
				} else {
					await page.keyboard.press(params.key);
				}
				return { content: [{ type: "text", text: `Pressed ${params.key}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_press ")) + theme.fg("dim", args.key), 0, 0);
		},
	});

	// ── companion_type ──
	pi.registerTool({
		name: "companion_type",
		label: "Companion Type",
		description:
			"Type text character-by-character into the focused element (or a selector if provided). Unlike companion_fill, this dispatches per-character keydown/keypress events — use for inputs that watch typing.",
		parameters: Type.Object({
			text: Type.String(),
			selector: Type.Optional(Type.String()),
			delayMs: Type.Optional(Type.Number({ description: "Delay between keypresses. Default 0." })),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const delay = params.delayMs ?? 0;
				if (params.selector) {
					await page.locator(params.selector).pressSequentially(params.text, { delay });
				} else {
					await page.keyboard.type(params.text, { delay });
				}
				return { content: [{ type: "text", text: `Typed ${params.text.length} chars` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			const preview = args.text.length > 30 ? args.text.slice(0, 27) + "..." : args.text;
			return new Text(theme.fg("toolTitle", theme.bold("companion_type ")) + theme.fg("dim", preview), 0, 0);
		},
	});

	// ── companion_hover ──
	pi.registerTool({
		name: "companion_hover",
		label: "Companion Hover",
		description: "Hover over an element in the companion's active page (Playwright selector).",
		parameters: Type.Object({
			selector: Type.String(),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.hover(params.selector, { timeout: params.timeoutMs ?? 5000 });
				return { content: [{ type: "text", text: `Hovered ${params.selector}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_hover ")) + theme.fg("dim", args.selector), 0, 0);
		},
	});

	// ── companion_scroll ──
	pi.registerTool({
		name: "companion_scroll",
		label: "Companion Scroll",
		description:
			"Scroll the page or an element into view. Either pass a selector (scrolls element into view) or x/y deltas (scrolls window by that amount), or to='top'|'bottom'.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "Scroll this element into view." })),
			x: Type.Optional(Type.Number({ description: "Horizontal scroll delta (pixels)." })),
			y: Type.Optional(Type.Number({ description: "Vertical scroll delta (pixels)." })),
			to: Type.Optional(Type.String({ description: "Shortcut: 'top' | 'bottom'. Overrides x/y." })),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				if (params.selector) {
					await page.locator(params.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
					return { content: [{ type: "text", text: `Scrolled ${params.selector} into view` }], details: {} };
				}
				if (params.to === "top") {
					await page.evaluate(() => window.scrollTo(0, 0));
					return { content: [{ type: "text", text: "Scrolled to top" }], details: {} };
				}
				if (params.to === "bottom") {
					await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
					return { content: [{ type: "text", text: "Scrolled to bottom" }], details: {} };
				}
				const dx = params.x ?? 0;
				const dy = params.y ?? 0;
				await page.evaluate(([dx, dy]: [number, number]) => window.scrollBy(dx, dy), [dx, dy] as [number, number]);
				return { content: [{ type: "text", text: `Scrolled by (${dx}, ${dy})` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_scroll")), 0, 0);
		},
	});

	// ── companion_dialog ──
	pi.registerTool({
		name: "companion_dialog",
		label: "Companion Dialog",
		description: "Pre-arm a handler for the next JS dialog (alert/confirm/prompt). The handler fires once when a dialog appears.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "'accept' (default) | 'dismiss'." })),
			promptText: Type.Optional(Type.String({ description: "Text to enter for window.prompt." })),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const action = params.action === "dismiss" ? "dismiss" : "accept";
				const handler = async (dialog: any) => {
					page.off("dialog", handler);
					if (action === "accept") await dialog.accept(params.promptText ?? "");
					else await dialog.dismiss();
				};
				page.on("dialog", handler);
				return { content: [{ type: "text", text: `Armed: will ${action} next dialog.` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_dialog ")) + theme.fg("dim", args.action ?? "accept"),
				0,
				0,
			);
		},
	});

	// ── companion_drag ──
	pi.registerTool({
		name: "companion_drag",
		label: "Companion Drag",
		description: "Drag from one selector to another in the companion's active page.",
		parameters: Type.Object({
			from: Type.String(),
			to: Type.String(),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.dragAndDrop(params.from, params.to);
				return { content: [{ type: "text", text: `Dragged ${params.from} → ${params.to}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_drag ")) + theme.fg("dim", `${args.from} → ${args.to}`),
				0,
				0,
			);
		},
	});

	// ── companion_upload_file ──
	pi.registerTool({
		name: "companion_upload_file",
		label: "Companion Upload File",
		description: "Set files on a file input in the companion's active page.",
		parameters: Type.Object({
			selector: Type.String({ description: "Selector for the <input type=file>." }),
			files: Type.Array(Type.String(), { description: "Absolute file paths to upload." }),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.setInputFiles(params.selector, params.files);
				return {
					content: [{ type: "text", text: `Set ${params.files.length} file(s) on ${params.selector}` }],
					details: {},
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_upload_file ")) + theme.fg("dim", args.selector),
				0,
				0,
			);
		},
	});

	// ── companion_screenshot_element ──
	pi.registerTool({
		name: "companion_screenshot_element",
		label: "Companion Screenshot Element",
		description: "Screenshot a single element by selector (PNG). Use companion_screenshot for full viewport/page captures.",
		parameters: Type.Object({
			selector: Type.String(),
			path: Type.Optional(Type.String({ description: "Absolute path to save to. If omitted, returns base64 inline." })),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const buf = await page.locator(params.selector).screenshot();
				if (params.path) {
					const { writeFileSync } = await import("node:fs");
					writeFileSync(params.path, buf);
					return {
						content: [{ type: "text", text: `Wrote ${buf.length} bytes to ${params.path}` }],
						details: {},
					};
				}
				return {
					content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }],
					details: {},
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_screenshot_element ")) + theme.fg("dim", args.selector),
				0,
				0,
			);
		},
	});

	// ── companion_resize ──
	pi.registerTool({
		name: "companion_resize",
		label: "Companion Resize",
		description: "Set the viewport size of the companion's active page.",
		parameters: Type.Object({
			width: Type.Number(),
			height: Type.Number(),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				await page.setViewportSize({ width: params.width, height: params.height });
				return { content: [{ type: "text", text: `Resized to ${params.width}x${params.height}` }], details: {} };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_resize ")) + theme.fg("dim", `${args.width}x${args.height}`),
				0,
				0,
			);
		},
	});

	// ── companion_emulate ──
	pi.registerTool({
		name: "companion_emulate",
		label: "Companion Emulate",
		description:
			"Set emulation flags for the active page: color scheme, reduced motion, geolocation, offline, network throttling, CPU throttling.",
		parameters: Type.Object({
			colorScheme: Type.Optional(Type.String({ description: "'light' | 'dark' | 'no-preference'." })),
			reducedMotion: Type.Optional(Type.String({ description: "'reduce' | 'no-preference'." })),
			offline: Type.Optional(Type.Boolean()),
			networkPreset: Type.Optional(
				Type.String({
					description: "'fast-3g' | 'slow-3g' | 'offline' | 'no-throttling'.",
				}),
			),
			cpuThrottle: Type.Optional(
				Type.Number({ description: "CPU slowdown multiplier (1 = none, 4 = 4x slower). Active until reset to 1." }),
			),
			geolocation: Type.Optional(
				Type.Object({
					latitude: Type.Number(),
					longitude: Type.Number(),
					accuracy: Type.Optional(Type.Number()),
				}),
			),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const applied: string[] = [];
				if (params.colorScheme || params.reducedMotion) {
					await page.emulateMedia({
						colorScheme: params.colorScheme as any,
						reducedMotion: params.reducedMotion as any,
					});
					if (params.colorScheme) applied.push(`colorScheme=${params.colorScheme}`);
					if (params.reducedMotion) applied.push(`reducedMotion=${params.reducedMotion}`);
				}
				if (params.geolocation) {
					await page.context().setGeolocation(params.geolocation);
					applied.push(`geolocation=${params.geolocation.latitude},${params.geolocation.longitude}`);
				}
				const needsCdp =
					params.offline !== undefined || params.networkPreset !== undefined || params.cpuThrottle !== undefined;
				if (needsCdp) {
					const session = await page.context().newCDPSession(page);
					try {
						if (params.offline !== undefined) {
							await session.send("Network.emulateNetworkConditions", {
								offline: params.offline,
								latency: 0,
								downloadThroughput: -1,
								uploadThroughput: -1,
							});
							applied.push(`offline=${params.offline}`);
						}
						if (params.networkPreset) {
							const presets: Record<string, any> = {
								"no-throttling": { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
								offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
								"slow-3g": {
									offline: false,
									latency: 400,
									downloadThroughput: ((500 * 1000) / 8) * 0.8,
									uploadThroughput: ((500 * 1000) / 8) * 0.8,
								},
								"fast-3g": {
									offline: false,
									latency: 150,
									downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9,
									uploadThroughput: ((750 * 1000) / 8) * 0.9,
								},
							};
							const preset = presets[params.networkPreset];
							if (!preset) throw new Error(`unknown networkPreset: ${params.networkPreset}`);
							await session.send("Network.emulateNetworkConditions", preset);
							applied.push(`networkPreset=${params.networkPreset}`);
						}
						if (params.cpuThrottle !== undefined) {
							await session.send("Emulation.setCPUThrottlingRate", { rate: params.cpuThrottle });
							applied.push(`cpuThrottle=${params.cpuThrottle}x`);
						}
					} finally {
						await session.detach().catch(() => {});
					}
				}
				return {
					content: [{ type: "text", text: applied.length ? `Applied: ${applied.join(", ")}` : "No changes (no params)." }],
					details: {},
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_emulate")), 0, 0);
		},
	});

	// ── companion_cookies ──
	pi.registerTool({
		name: "companion_cookies",
		label: "Companion Cookies",
		description:
			"Read, set, or clear cookies for the companion's browser context. action='get' (default) lists; 'set' adds/updates; 'clear' wipes all.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "'get' | 'set' | 'clear'. Default 'get'." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Limit get to these URLs." })),
			cookies: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String(),
						value: Type.String(),
						url: Type.Optional(Type.String()),
						domain: Type.Optional(Type.String()),
						path: Type.Optional(Type.String()),
						expires: Type.Optional(Type.Number()),
						httpOnly: Type.Optional(Type.Boolean()),
						secure: Type.Optional(Type.Boolean()),
						sameSite: Type.Optional(Type.String()),
					}),
					{ description: "For action='set'." },
				),
			),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const ctx = page.context();
				const action = params.action ?? "get";
				if (action === "clear") {
					await ctx.clearCookies();
					return { content: [{ type: "text", text: "Cleared all cookies." }], details: {} };
				}
				if (action === "set") {
					if (!params.cookies?.length) throw new Error("action=set requires cookies array");
					await ctx.addCookies(params.cookies as any);
					return { content: [{ type: "text", text: `Set ${params.cookies.length} cookie(s).` }], details: {} };
				}
				const cookies = await ctx.cookies(params.urls);
				const summary = cookies.map(
					(c) =>
						`${c.name}=${c.value.length > 30 ? c.value.slice(0, 27) + "..." : c.value} ` +
						`(domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite})`,
				);
				return {
					content: [{ type: "text", text: `${cookies.length} cookies:\n${summary.join("\n") || "(none)"}` }],
					details: {},
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_cookies ")) + theme.fg("dim", args.action ?? "get"),
				0,
				0,
			);
		},
	});

	// ── companion_storage ──
	pi.registerTool({
		name: "companion_storage",
		label: "Companion Storage",
		description:
			"Read or modify localStorage / sessionStorage on the active page. action='get' returns all keys; 'set' writes one; 'remove' deletes one; 'clear' wipes the store.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "'get' (default) | 'set' | 'remove' | 'clear'." })),
			store: Type.Optional(Type.String({ description: "'local' (default) | 'session'." })),
			key: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				const storeName = params.store === "session" ? "sessionStorage" : "localStorage";
				const action = params.action ?? "get";
				const result = (await page.evaluate(
					({ storeName, action, key, value }) => {
						const s = (window as any)[storeName] as Storage;
						if (action === "clear") {
							s.clear();
							return { ok: true, msg: "cleared" };
						}
						if (action === "set") {
							if (!key) return { ok: false, msg: "key required" };
							s.setItem(key, value ?? "");
							return { ok: true, msg: `set ${key}` };
						}
						if (action === "remove") {
							if (!key) return { ok: false, msg: "key required" };
							s.removeItem(key);
							return { ok: true, msg: `removed ${key}` };
						}
						const out: Record<string, string> = {};
						for (let i = 0; i < s.length; i++) {
							const k = s.key(i);
							if (k) out[k] = s.getItem(k) ?? "";
						}
						return { ok: true, data: out };
					},
					{ storeName, action, key: params.key, value: params.value },
				)) as { ok: boolean; msg?: string; data?: Record<string, string> };
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: {},
					isError: !result.ok,
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_storage ")) +
					theme.fg("dim", `${args.store ?? "local"} ${args.action ?? "get"}`),
				0,
				0,
			);
		},
	});

	// ── companion_perf_trace ──
	let activeTraceSession: import("playwright-core").CDPSession | null = null;
	pi.registerTool({
		name: "companion_perf_trace",
		label: "Companion Perf Trace",
		description:
			"Record a Chrome performance trace. action='start' begins recording; action='stop' finalizes and saves the trace JSON to a file.",
		parameters: Type.Object({
			action: Type.String({ description: "'start' | 'stop'" }),
			path: Type.Optional(Type.String({ description: "For action='stop': absolute path to write trace JSON." })),
			categories: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"For start: trace categories. Defaults to a sensible perf set (devtools.timeline, v8, blink.user_timing, etc.).",
				}),
			),
		}),
		async execute(_id, params) {
			try {
				const page = await ensureAttached();
				if (params.action === "start") {
					if (activeTraceSession) {
						return {
							content: [{ type: "text", text: "Trace already running. Stop it first." }],
							details: {},
							isError: true,
						};
					}
					activeTraceSession = await page.context().newCDPSession(page);
					const categories =
						params.categories ??
						[
							"devtools.timeline",
							"disabled-by-default-devtools.timeline",
							"disabled-by-default-devtools.timeline.frame",
							"disabled-by-default-v8.cpu_profiler",
							"v8",
							"blink.user_timing",
							"latencyInfo",
							"loading",
							"navigation",
						];
					await activeTraceSession.send("Tracing.start", {
						traceConfig: { includedCategories: categories },
						transferMode: "ReturnAsStream",
					} as any);
					return {
						content: [{ type: "text", text: `Trace started (${categories.length} categories).` }],
						details: {},
					};
				}
				if (params.action === "stop") {
					if (!activeTraceSession) {
						return { content: [{ type: "text", text: "No trace running." }], details: {}, isError: true };
					}
					if (!params.path) throw new Error("path required for action=stop");
					const session = activeTraceSession;
					const chunks: string[] = [];
					const done = new Promise<string>((resolve, reject) => {
						session.on("Tracing.tracingComplete", async (evt: any) => {
							try {
								if (evt.stream) {
									while (true) {
										const { data, eof } = (await session.send("IO.read", { handle: evt.stream })) as any;
										chunks.push(data);
										if (eof) break;
									}
									await session.send("IO.close", { handle: evt.stream });
								}
								resolve(chunks.join(""));
							} catch (e) {
								reject(e);
							}
						});
					});
					await session.send("Tracing.end");
					const json = await done;
					const { writeFileSync } = await import("node:fs");
					writeFileSync(params.path, json);
					await session.detach().catch(() => {});
					activeTraceSession = null;
					return {
						content: [{ type: "text", text: `Wrote ${json.length} bytes to ${params.path}` }],
						details: {},
					};
				}
				return { content: [{ type: "text", text: "action must be 'start' or 'stop'" }], details: {}, isError: true };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_perf_trace ")) + theme.fg("dim", args.action),
				0,
				0,
			);
		},
	});

	// ── companion_pages ──
	pi.registerTool({
		name: "companion_pages",
		label: "Companion Pages",
		description:
			"List all pages (targets) in the companion CEF, or select one as the attached target. action='list' (default) returns all; 'select' switches the attached page by url substring or 0-based index.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "'list' (default) | 'select'." })),
			urlContains: Type.Optional(Type.String({ description: "For select: pick the first page whose URL contains this." })),
			index: Type.Optional(Type.Number({ description: "For select: 0-based index from the list." })),
		}),
		async execute(_id, params) {
			try {
				if (!browser || !browser.isConnected()) {
					const port = discoverCdpPort();
					browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
				}
				const pages: Page[] = [];
				for (const ctx of browser.contexts()) for (const p of ctx.pages()) pages.push(p);
				const action = params.action ?? "list";
				if (action === "list") {
					const lines = pages.map((p, i) => {
						const marker = p === attachedPage ? " [attached]" : "";
						return `${i}: ${p.url()}${marker}`;
					});
					return { content: [{ type: "text", text: lines.join("\n") || "(no pages)" }], details: {} };
				}
				if (action === "select") {
					let target: Page | undefined;
					if (params.index !== undefined) target = pages[params.index];
					else if (params.urlContains) target = pages.find((p) => p.url().includes(params.urlContains!));
					if (!target) throw new Error("no matching page");
					attachedPage = target;
					attachedContext = target.context();
					wireListeners(target);
					return { content: [{ type: "text", text: `Attached to: ${target.url()}` }], details: {} };
				}
				return { content: [{ type: "text", text: "Unknown action." }], details: {}, isError: true };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {}, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("companion_pages ")) + theme.fg("dim", args.action ?? "list"),
				0,
				0,
			);
		},
	});

	// ── companion_devtools_status ──
	pi.registerTool({
		name: "companion_devtools_status",
		label: "Companion DevTools Status",
		description: "Diagnostics: CDP port, attached page URL, buffer sizes, connection health.",
		parameters: Type.Object({}),
		async execute() {
			const port = discoverCdpPort();
			const out = {
				cdpPort: port,
				companionId: activeCompanionId() ?? null,
				connected: !!browser?.isConnected(),
				attachedUrl: attachedPage?.url() ?? null,
				attachedClosed: attachedPage?.isClosed() ?? null,
				netBuffer: netBuffer.length,
				consoleBuffer: consoleBuffer.length,
				lastNetId: netBuffer.at(-1)?.id ?? 0,
				lastConsoleId: consoleBuffer.at(-1)?.id ?? 0,
			};
			return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: {} };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("companion_devtools_status")), 0, 0);
		},
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", () => {
		disconnect();
	});
}
