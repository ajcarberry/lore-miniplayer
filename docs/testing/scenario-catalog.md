# Scenario catalog

What the [real-server integration suite](./integration-suite.md) verifies today,
grouped by area. Actors are `user1` (the primary operator) and `user2` (a second
working copy); repositories are `repo1`/`repo2`.

To run everything: `pnpm test:integration` (service layer) and
`pnpm exec playwright test --project=electron-live-server` (UI, after `pnpm build`).

## Harness self-tests

These prove the harness itself is sound before the service scenarios rely on it.

`tests/integration/harness/binaries.test.ts`

- **Cold call downloads and caches the binaries** — a first call with an empty
  cache downloads and unpacks executable `loreserver` and `lore` binaries.
- **Warm call reuses the cache and makes no network access** — a second call
  returns the cached paths without calling the network.

`tests/integration/harness/server.test.ts`

- **Health gate** — `startLoreServer()` resolves only after `GET /health_check`
  returns `200`.
- **Create + list** — a repo created via `createRepo()` appears in a server-side
  repository list.
- **Hermetic isolation** — a second server does not see the first server's repos.
- **No orphans** — `stop()` leaves no `loreserver` process behind.

## Service workflows

The happy-path flows a user runs, driven through `LoreRepositoryService` against
a live server.

`tests/integration/smoke.test.ts`

- **Clone + list against a live server** — the service clones a seeded repo, then
  `listRemoteRepositories` and `listBranches` reflect it.

`tests/integration/workflows/connect-clone.test.ts`

- **Connect, list, and clone a seeded repository** — `repo1` appears in the
  remote list, the clone lands on disk (`checkRepositoryStatus` → `isLoreRepo`),
  and at least one `cloneProgress` event fires.

`tests/integration/workflows/status-stage-commit-push.test.ts`

- **Edit, review, stage, commit, push leaves a clean status** — a new file reads
  as untracked and an edited file as unstaged; both read staged after
  `stageFiles`; status is clean after commit + push.
- **Unstage one file before commit, the rest still land** — an unstaged file
  moves back out of the commit while the rest still commit.

`tests/integration/workflows/branches-and-sync.test.ts`

- **Switch to a teammate-created branch** — after switching, `listBranches` marks
  the feature branch current and `main` still `isDefault`.
- **Catch up with a teammate via sync** — `user2` pushes to `main`; after
  `user1` syncs, the current revision advances to `user2`'s revision.
- **Divergence reads inSync / ahead / behindOrDiverged across the arc** —
  `getBranchDivergence` reports each state in turn as `user1` commits, pushes,
  and `user2` pushes.

## Edge cases

Failure modes and boundary conditions.

`tests/integration/edge-cases/divergence-and-conflict.test.ts`

- **Diverged (non-overlapping) histories read behindOrDiverged and a plain sync
  merges both sides** — `user1`'s unpushed commit and `user2`'s unrelated pushed
  commit auto-merge; both edits survive.
- **An overlapping conflict must be visibly surfaced, not reported as a plain
  staged file** — marked `todo`: it documents a known bug. The SDK surfaces the
  pending merge (`flagConflict` / `flagConflictUnresolved`, plus
  `~mine`/`~theirs`/`~base` siblings), but `getFileStatus()` and
  `LoreFileStatus` drop that flag, so a conflicted file is indistinguishable from
  an ordinary staged file. The test stays non-blocking until that is fixed.

`tests/integration/edge-cases/sync-reset-force.test.ts`

- **Reset sync discards a dirty working copy and matches the remote** — a reset
  sync throws away never-staged local edits.
- **A plain sync refuses over dirty local edits; force completes it** — a plain
  sync rejects with "Local modifications prevent synchronization"; a forced sync
  completes and lands on the remote content.

`tests/integration/edge-cases/empty-and-awkward.test.ts`

- **An empty repository degrades gracefully across every read** — status,
  branches, current revision, branch graph, and divergence all handle a
  zero-revision repo without throwing.
- **Awkward filenames round-trip through stage/commit/push and a fresh clone** —
  filenames with spaces, unicode, and accents survive stage, commit, push, and a
  fresh clone intact.

`tests/integration/edge-cases/heavy-and-concurrent.test.ts`

- **Heavy-asset clone progress advances by bytes, not file count** — cloning a
  48MB payload reports progress by byte ratio, not a naive file-count ratio.
- **Rapid-fire stage/commit/push cycles leave no stale state between them** —
  back-to-back cycles each read only their own state, with no leaked entries or
  stale divergence.

`tests/integration/edge-cases/errors.test.ts`

- **An unreachable server address rejects fast as a clean LoreOperationError** —
  an address with nothing listening fails quickly with a useful message and no
  raw FFI leakage.
- **Cloning a repository that doesn't exist rejects as a clean
  LoreOperationError** — a missing repository fails the same clean way.

## Live-server UI end-to-end

These drive the **real Electron app** (renderer → IPC → main-process service →
live `loreserver`), asserting what a user sees. Run on macOS/Linux via the
`electron-live-server` Playwright project (needs `pnpm build`):

```bash
pnpm build
pnpm exec playwright test --project=electron-live-server
```

The suite runs one worker with `retries: 1` — see [Known findings](#known-findings)
for the residual app-launch flake the retry absorbs. A separate
`launch-isolation.diag.spec.ts` (project `electron-diag`) is an on-demand launch
reliability check.

Repositories & workspaces (`live-repositories.spec.ts`)
- **Clone from the remote list** — connect, pick a repo from the live list, clone;
  the card shows the repo, a normal transport row, and history.
- **Add an existing on-disk workspace** — pick a directory that is already a Lore
  repo; the modal flips to existing-mode and tracks it without cloning.
- **List and switch between multiple workspaces** — add two repos, the picker lists
  both, selecting one makes it the active card.

Working set & the commit → push loop (`live-working-set.spec.ts`)
- **Edit, add, stage, commit, push** — an edited file shows 'M' and a new file 'A',
  both unstaged; the pill/card uncommitted notifiers fire; staging + commit then
  raise the unpushed notifiers (pill glyph + card Push "To push"); push leaves a
  clean status, "Up to date", and a new history revision.
- **Unstage one file before commit** — only the still-staged file lands; the
  unstaged one stays in the working set.

Sync, branches, revisions (`live-sync-branches.spec.ts`)
- **Behind remote → sync** — a `user2` push raises the collapsed pill's sync notice
  AND the card's accented "Behind remote" Sync cell; syncing clears both to
  "Current".
- **Switch branches** — the branch switcher lists a published feature branch;
  switching moves the header to it.
- **Sync to a specific revision** — with several revisions, syncing to `@1` moves
  the working copy off the tip and the Sync caption reads "Older revision".

Reset, repo management, shortcuts (`live-reset-and-mgmt.spec.ts`)
- **Reset a dirty workspace** — a scratch edit shows dirty (working-set row + pill
  uncommitted glyph); Reset → confirm clears it and discards the on-disk edit.
- **Remove a repository from the app** — deleting via the edit modal removes it
  from the repo picker (the server repo is untouched).
- **Open-in-explorer / open-terminal shortcuts** — each footer shortcut invokes its
  IPC (`repository:open-in-explorer` / `window:open-terminal`) with the repo path
  (stubbed — asserts the invocation, no external app launches).

Notices & progress (`live-server.spec.ts`)
- **Empty repository shows a clean no-history state** — a zero-revision repo lands
  with "No history yet" and no stuck loader.
- **An active sync notice suspends the window unfocused dim** — through the full
  live pipeline (the pill notice basics are covered above; the mocked plumbing is
  in `window-behavior.spec.ts`).
- **Heavy-asset clone streams real progress to completion** — multiple real clone
  ticks reach the renderer, ending at 100%.

## Known findings

Behaviors the suite documents but does not paper over (assert actual behavior, or
mark `todo`, and file a follow-up):

- **Intermittent app-launch hang.** The app's main process occasionally does not
  emit its window within 30s on launch (`firstWindow()` timeout), independent of
  the test harness — a product-side `src/main` issue (SDK/FFI init). Absorbed for
  now by `retries: 1`; filed as a follow-up.
- **Notifier surfaces disagree pre-stage.** The pill's "uncommitted" glyph fires on
  the total dirty-file count, but the card's Commit cell accents only when
  something is *staged* — so with unstaged changes the pill signals and the card
  does not (`live-working-set.spec.ts` asserts the actual behavior).
- **Slow blocking shutdown.** `will-quit` runs a synchronous unbounded
  `lore.shutdown()` that can make app quit slow; the e2e harness bounds close
  (`closeAppBounded`) so it can't hang teardown.
- **Conflict visibility** (service-layer) — see the E4 `todo` above.
