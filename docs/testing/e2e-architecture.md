# E2E architecture: silent, parallel, and worktree-safe

This records the decisions behind how `tests/e2e/electron` boots, hides, and
parallelizes the app, and closes a specific open question: whether
`playwright run-server` (or its Electron equivalent) could replace per-test
`_electron.launch()`. It does not restate the coverage mandate — see
[E2E coverage](./e2e-coverage.md) for what is tested; this is about how the
suite runs.

## The run-server question

Playwright's browser types (`chromium`, `firefox`, `webkit`) support a
client/server split: `browserType.launchServer()` starts a browser and returns a
`BrowserServer` with a `wsEndpoint()`; a separate process attaches to it with
`browserType.connect()` (the `npx playwright run-server` CLI wraps the same
launch-and-listen pattern for out-of-process or cross-language clients). That
split is documented only for the three browser types
([`class-electron`](https://playwright.dev/docs/api/class-electron) lists
exactly one method on the `Electron` fixture: `launch()` — no `connect()`, no
`launchServer()`).

**Verdict: not applicable to this suite.** This was tested upstream, not just
read off the docs:
[playwright#10369](https://github.com/microsoft/playwright/issues/10369) is a
user trying to attach Playwright to an already-running Electron app over its CDP
endpoint; it was closed **not planned** (2026-05). Electron's own tracker has
the same ask from the other direction —
[playwright#13288](https://github.com/microsoft/playwright/issues/13288) asks
for headless Electron support parity with browser `launch({headless: true})` —
also unresolved. There is no supported "start once, attach many times" mode for
Electron in Playwright; every test gets its own `_electron.launch()` process,
full stop.

### The degraded alternative, and why it's out of scope

A workaround exists: launch Electron with `--remote-debugging-port`, then use
`playwright.chromium.connectOverCDP()` to attach to the renderer as a plain
Chromium page — which is effectively what the reporter in #10369 was trying to
do. It's a real option, but a strictly worse one for this codebase: attaching
over CDP gets you a `Page`, not an `ElectronApplication`
([pages](https://playwright.dev/docs/pages) documents the generic
`BrowserContext`/`Page` model that's all a CDP attach exposes) — you lose
`app.evaluate()` (main-process code execution, which `support/ui.ts` and the
live-server specs rely on for state assertions) and `app.firstWindow()` (the
window-ready handshake every spec's launch fixture depends on). This suite needs
the main-process surface, so CDP-attach was ruled explicitly out of scope.

**Conclusion:** per-test `_electron.launch()` is not a stopgap waiting on a
better primitive — it is the only primitive Playwright offers for Electron. The
architecture below works within that constraint instead of around it.

## The chosen architecture

### Hidden by default

The product window is `alwaysOnTop` by design (it's an ambient pill), so a
visible test launch steals real macOS focus on every boot — Electron's own
tracker has the general version of this complaint
([electron#30904](https://github.com/electron/electron/issues/30904):
`activateIgnoringOtherApps:YES` fires unconditionally when a window shows).
Electron's headless-CI guidance
([testing-on-headless-ci](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci))
solves a different problem — no display driver at all, via Xvfb — which doesn't
fit here: local runs have a real display and still need real Chromium rendering
(screenshots, animation assertions), just no visible window or dock icon.

Two mechanisms were considered:

- **Harness-owned wrapper** (preferred going in): patch `BrowserWindow`'s
  defaults to `show: false` and call `app.dock.hide()` from a Playwright-side
  module, before importing the built `out/main/index.js` — no `src/` changes.
  **Ruled out during a spike**: electron-vite's CJS output re-exports
  `electron`'s named exports as non-configurable getters, so nothing in the
  harness can intercept or override `BrowserWindow` before the app's own
  `createWindow()` reads it. Separately, even a post-hoc hide (calling
  `win.hide()` right after creation) is too late — native `show()` already lands
  before the app's `browser-window-created` event fires, so a visible frame
  flashes for one paint.
- **Env-gated branch in `createWindow()`** (the pre-approved fallback): a
  `LORE_MINIPLAYER_E2E_HIDDEN` check beside the existing
  `LORE_MINIPLAYER_USER_DATA` override, passing `show: false` at `BrowserWindow`
  construction and calling `app.dock.hide()` — the window is never shown, so
  there's no flash to suppress. This is what shipped: a handful of inert lines
  in `src/main/index.ts`, on by default from `tests/e2e/electron/launch.ts`,
  restorable with `LORE_MINIPLAYER_E2E_SHOW=1`. Hidden mode also sets
  `backgroundThrottling: false` on the window's webPreferences: Chromium
  throttles timers and rAF for never-shown windows, so without it the suite
  would exercise a degraded mode no user (whose window is visible) ever runs —
  asserted by `hidden-mode.spec.ts`.

### Parallel per-test launches

`workers: 1` used to exist solely to keep concurrent _visible_ windows from
racing each other for OS focus. With every launch hidden, that race is gone —
each launch is still its own throwaway universe (own temp `userData`, own env),
so `fullyParallel: true` was safe to turn on for the `electron` and
`electron-live-server` projects. Measured (clean env, this repo):

| Run                            | Wall-clock                   |
| ------------------------------ | ---------------------------- |
| Serial baseline (`workers: 1`) | 97.75s                       |
| Parallel, 5 consecutive runs   | 49.6–67.7s (avg ~57.6s)      |
| Follow-up confirmation run     | 42.8s, 25 passed, no retries |

About a 1.7× average speedup, no flakes introduced across the sampled runs.
`electron-diag` (sequential-launch reliability check) and `electron-focus`
(below) stay serial by design — see the per-project comments in
`playwright.config.ts`.

### CI-only visible focus project

Two tests assert real OS focus/blur behavior (the unfocused-window dim, the
notice-suspends-dim override), which needs a window that can actually receive
focus — a hidden window can't. (A third, partial assertion — the dim-suspension
half of the live sync-notice scenario — stays in `live-server.spec.ts` behind
its own self-skip.) Rather than let them silently self-skip forever in an
all-hidden future, they live in their own `electron-focus` project: excluded
from a bare `playwright test` by an explicit `--project` argv gate (Playwright
has no "excluded by default" project flag), run visibly via
`LORE_MINIPLAYER_E2E_SHOW=1`, and executed as a named CI step on every non-Linux
runner. The opacity decision logic itself (`computeFocusOpacity`) also has a
fast Jest matrix so a regression is caught locally without a visible window at
all.

## Multi-worktree isolation model

Two checkouts running `playwright test` at once must not interfere. Per launch
and per repo, that already held before this change:

- **Temp `userData` and `HOME`-scoped state** — every `launchApp()` call gets
  its own `fs.mkdtempSync` directory (`tests/e2e/electron/launch.ts`), so two
  worktrees never share a profile.
- **OS-assigned ports** — the live-server harness lets the OS pick free ports
  per spawn rather than hardcoding one; two loreservers from two worktrees never
  collide.
- **Path-scoped reaper** — `reapSuiteElectron()` (`support/reaper.ts`) matches
  processes by `pgrep -f APP_MAIN`, where `APP_MAIN` is this worktree's own
  `out/main/index.js` absolute path. A reaper run from worktree A can never see,
  let alone kill, worktree B's Electron trees — no scope change was needed here,
  it was already correct.

One piece wasn't worktree-safe: the macOS `defaults` key
(`com.github.Electron ApplePersistenceIgnoreState`) that suppresses the
"unexpectedly quit" dialog after a reaper force-kill. That key is global to the
machine — keyed by bundle id, not pid or path — so the old
set-in-setup/delete-in-teardown pair let one worktree's teardown clear the key
while a sibling worktree's suite was still relying on it being set. **Fixed
here**: `support/macos-restore.ts` now tracks a refcount via sentinel files (one
per active run, named for its pid) in a shared lock directory under
`os.tmpdir()`. Teardown deletes only its own sentinel and checks whether any
others remain (pruning any whose owning process has already died, so a crashed
run can't wedge the key set forever); only the last finisher deletes the
`defaults` key. The reporter's HTML auto-open was also disabled by default
(`open: 'never'`, opt back in with `LORE_MINIPLAYER_E2E_OPEN_REPORT=1`) so a
background or concurrent run never pops a browser tab over whatever else is on
screen; failure artifacts (trace/video/screenshot) are unaffected.

## Citations

- <https://playwright.dev/docs/api/class-electron> — `Electron` fixture API
  surface (`launch()` only).
- <https://github.com/microsoft/playwright/issues/10369> — attach-to-running-
  Electron request, closed not-planned (2026-05).
- <https://playwright.dev/docs/pages> — the `Page`/`BrowserContext` model a CDP
  attach degrades to.
- <https://github.com/microsoft/playwright/issues/13288> — headless-Electron
  parity request, open/unresolved.
- <https://github.com/electron/electron/issues/30904> — unconditional
  focus-steal on window show.
- <https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci> —
  Electron's own headless-CI guidance (Xvfb), and why it doesn't fit this
  suite's requirements.
