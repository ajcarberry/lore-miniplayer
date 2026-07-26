# End-to-end coverage & the feature-coverage mandate

## The mandate

**Every user-facing feature and every UI capability must have an end-to-end test
that drives the real app against a live Lore server.** A user-facing feature is
not complete until its e2e scenario exists and passes.

"Through the real app" means: the Playwright test launches the built Electron
application and exercises the capability the way a user would — clicking real
controls, reading real rendered state — so the renderer → IPC → main-process
service → live `loreserver` path is proven, not mocked. Unit tests (Jest) and the
service-layer integration suite still carry their own load; this mandate is
specifically about the **UI a user touches**.

Cosmetic or window-shell behaviour that does not depend on a live server (theme
toggle, the pill ↔ card morph, window transparency/position) is covered by the
mocked Electron e2e specs instead — it does not need the live-server stack.

## How it's tested

- **Real app, live server.** The live-server e2e is the Playwright
  `electron-live-server` project (`tests/e2e/electron/live-*.spec.ts`). Each spec
  file starts its own hermetic `loreserver` in `beforeAll` via `useLiveServer()`
  and launches the built app (`out/main/index.js`) per test.
- **A page-object helper layer.** `tests/e2e/electron/support/ui.ts` exposes one
  helper per capability (connect, add/clone, add-existing, switch repo/branch,
  working set + stage, commit, push, sync latest/revision, reset, history, and
  pill/card signal + caption readers) plus the launch fixture. Scenarios compose
  these; they don't hand-write selectors.
- **Hermetic & idempotent.** One server per file, a unique repo name per test
  (`repo1`, `repo2`, …), isolated per-launch HOME/userData, bounded teardown, and
  an orphan reaper. Results are identical run to run.
- **A note on retries.** The live-* specs set `retries: 1` for a documented,
  residual Electron-level launch stall — see the Scenario catalog's
  [Known findings](./scenario-catalog.md#known-findings). Retries are for that
  known flake only, never to paper over a real assertion failure.

Run it:

```bash
pnpm build
pnpm exec playwright test --project=electron-live-server
```

It also runs as part of `pnpm test:play` and `pnpm claude:pre-commit` (macOS/Linux;
it skips on Windows). Full how-to: [integration-suite.md](./integration-suite.md).

## What it's testing — coverage index

Every capability below maps to a live e2e scenario. Scenario IDs (UA–UL) and their
detailed assertions live in the [Scenario catalog](./scenario-catalog.md).

| User-facing capability | Scenario | Spec file |
|------------------------|----------|-----------|
| Connect to a server | UA (+ every scenario's setup) | `live-repositories.spec.ts` |
| Add a workspace by cloning from the remote list | UA | `live-repositories.spec.ts` |
| Add a workspace already on disk (tracked) | UB | `live-repositories.spec.ts` |
| Switch between multiple workspaces | UC | `live-repositories.spec.ts` |
| See modified files (added 'A' / edited 'M') | UD | `live-working-set.spec.ts` |
| Stage / unstage files | UD, UE | `live-working-set.spec.ts` |
| Commit | UD, UE | `live-working-set.spec.ts` |
| Push | UD | `live-working-set.spec.ts` |
| Revision history reflects the new commit | UD (+ UH history select) | `live-working-set.spec.ts`, `live-sync-branches.spec.ts` |
| Switch branches | UG | `live-sync-branches.spec.ts` |
| Sync to latest | UF | `live-sync-branches.spec.ts` |
| Sync to a specific revision (`@N`) | UH | `live-sync-branches.spec.ts` |
| Reset the workspace (discard local changes) | UI | `live-reset-and-mgmt.spec.ts` |
| Remove a repository from the app | UK | `live-reset-and-mgmt.spec.ts` |
| Open in file explorer / open terminal | UL | `live-reset-and-mgmt.spec.ts` |
| Behind-remote notifier (pill **and** card) | UF | `live-sync-branches.spec.ts` |
| Uncommitted-changes notifier (pill **and** card) | UD | `live-working-set.spec.ts` |
| Unpushed-commits notifier (pill **and** card) | UD | `live-working-set.spec.ts` |
| Sync notice suspends the unfocused window dim | dim-suspension | `live-server.spec.ts` |
| Empty repository shows a clean no-history state | empty-repo | `live-server.spec.ts` |
| Clone progress streams to completion | clone-progress | `live-server.spec.ts` |
| Open the review window from the card (Review / Merge) | review-commit, merge-mine | `live-review.spec.ts`, `live-merge.spec.ts` |
| Review entry only while the working set is dirty; Merge only with revisions to land (withdrawn after landing) | review-commit, merge-mine | `live-review.spec.ts`, `live-merge.spec.ts` |
| Review compare picker (revision ↔ working tree) | review-commit | `live-review.spec.ts` |
| Review file rows (badges, binary), stage/unstage, commit, push | review-commit | `live-review.spec.ts` |
| Conflicted files blocked from staging (card ⚠ + review file list) | review-conflict | `live-review.spec.ts` |
| Merge with per-file mine/theirs resolution lands on main | merge-mine, merge-theirs | `live-merge.spec.ts` |
| Abort a merge, restoring the working tree | merge-abort | `live-merge.spec.ts` |

Cosmetic / window-shell (mocked e2e, no live server): theme toggle and card
anatomy (`card-anatomy.spec.ts`), pill ↔ card morph (`morph.spec.ts`), window
transparency / opacity / position and the notice-dim plumbing
(`window-behavior.spec.ts`), the connect page (`connect-page.spec.ts`), and the
review window's commit/merge workflow routing (`review-workflow.spec.ts`).

## Adding coverage for a new feature

When you add or change a user-facing feature:

1. Add a scenario to the matching `tests/e2e/electron/live-*.spec.ts` (or a new
   `live-<area>.spec.ts`) using the `support/ui.ts` helpers; add a helper there if
   the feature needs a new control. Give each test a unique repo name.
2. Assert the observable UI a user relies on — rendered state, transport captions,
   working-set rows, pill/card signals — not internal calls.
3. Add the scenario to this coverage index and to the
   [Scenario catalog](./scenario-catalog.md).
4. If the real behaviour differs from what you expected, assert the actual
   behaviour and record it as a finding / `todo` (as the suite already does for the
   conflict-visibility and notifier-mismatch findings) rather than forcing a green.

If a capability genuinely can't be observed end to end (it launches an external
app, or depends on OS state a test can't grant), stub at the IPC boundary and
assert the invocation — see UL (explorer/terminal) — and say so, rather than
leaving it uncovered silently.
