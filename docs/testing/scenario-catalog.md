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

The UI subset drives the real Electron app (renderer → IPC → main-process service
→ live `loreserver`). Runs on macOS/Linux; see
`tests/e2e/electron/live-server.spec.ts`.

- **Clone a real repository into the card, then open an empty one** — cloning a
  seeded repo and a brand-new empty repo both land in the card with the right
  transport row and history state.
- **A teammate push surfaces the sync-needed pill, and clears on sync** — a
  `user2` push drives the collapsed pill's notice pulse through the full
  divergence → notification → pill pipeline, and syncing clears it.
- **Cloning a heavy asset streams real progress events to completion** — the
  clone-progress channel delivers multiple real ticks to the renderer, ending
  at 100%.
