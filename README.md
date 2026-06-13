# cairn-extensions

Pi extensions that integrate the [pi coding agent](https://github.com/badlogic/pi-mono) with [Cairn](https://p10q.com/cairn) (a fork of [Ghostty](https://ghostty.org/) with an HTTP apps daemon, companion browser pane, and tab-status awareness).

These extensions are pure-extension code; they work against upstream `pi-mono` with no fork required. They no-op when Cairn isn't running, so it's safe to leave them installed in `~/.pi/agent/extensions/` even when you're using `pi` outside Cairn.

## What's in here

| Extension | What it does |
|---|---|
| **cairn-tab-status** | Emits OSC 7727 escape sequences during pi sessions. Cairn's terminal reads them and shows live "streaming…", "tool: Bash", "compacting", "error" status in the tab title. No-op outside Cairn (gated on `TERM_PROGRAM=ghostty`, which Cairn preserves for upstream-rebase compatibility). |
| **cairn-apps-workflows** | Author, run, observe, and iterate on workflows hosted by Cairn's apps daemon (HTTP server on `127.0.0.1:8765`, SQLite-backed). Adds `apps_workflow_*` and `apps_run_*` tools. |
| **cairn-companion** | Drive Cairn's companion browser pane: open URLs, take screenshots, click, fill forms, capture network/console, run JS via CDP. Adds `companion_*` tools. |
| **cairn-spawn** | Spawn new pi sessions in Cairn tabs/splits via OSC 7727. Adds `/st`, `/sd`, `/sr` slash commands. |

## Install

```sh
# 1. Install upstream pi (any of: bun, npm, pnpm, yarn — pi's own README
#    is the source of truth; cairn-extensions has no opinion).
npm install -g @earendil-works/pi-coding-agent

# 2. Clone this repo somewhere stable.
git clone https://github.com/p10q/cairn-extensions.git ~/.cairn-extensions

# 3. Drop the extensions into ~/.pi/agent/extensions/ (idempotent).
~/.cairn-extensions/bin/cairn-extensions install

# 4. (Optional) Add an alias so `cairn-extensions` works from anywhere.
ln -s ~/.cairn-extensions/bin/cairn-extensions ~/.local/bin/cairn-extensions
```

`cairn-extensions install` is idempotent. To upgrade:

```sh
git -C ~/.cairn-extensions pull && ~/.cairn-extensions/bin/cairn-extensions install
```

Existing installs at the same version skip; upgrades archive the prior copy into `~/.pi/agent/extensions-archive/<name>.pre-upgrade.<timestamp>/` so nothing is lost. Legacy dirs from earlier names (`tab-status`, `apps-workflows`, `ghostty-companion`, `ghostty-spawn`) are auto-archived to the same `extensions-archive/` dir on first install of v0.2+ so the new `cairn-*` dirs don't race with them. The archive is a sibling of `extensions/` (NOT inside it) because pi tries to load every subdir of `extensions/` and would otherwise see the archived copy and conflict on tool/flag names.

### npm dependencies

Some extensions (currently `cairn-companion`, which uses `playwright-core`) declare `dependencies` in their `package.json`. The installer runs `npm install` inside each such extension dir after copying. Skip via `CAIRN_EXTENSIONS_SKIP_NPM=1` if your npm config is fighting you (e.g. private registry auth) and run `npm install` manually when ready:

```sh
cd ~/.pi/agent/extensions/cairn-companion && npm install
```

Cairn's first-run wizard runs the install for you. Outside Cairn, run it manually.

> **Note**: this repo is **not** published to npm. Distribution is git-only — clone the repo and run the bundled CLI. There's no `@p10q/cairn-extensions` package on the npm registry; ignore any tooling that asks for one.

## Uninstall

```sh
~/.cairn-extensions/bin/cairn-extensions uninstall
```

Archives the four extension dirs as `<name>.pre-uninstall.<timestamp>/` under `~/.pi/agent/extensions-archive/`. Then `rm -rf ~/.cairn-extensions` to remove the repo itself.

## Versioning

Versions are git tags (e.g. `v0.1.0`). Each installed extension carries a `.cairn-extensions-version` marker stamped from `package.json` at install time. The installer detects drift and prompts before overwriting user-edited copies.

## License

MIT. See [LICENSE](./LICENSE).
