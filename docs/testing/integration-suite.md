# Real-server integration suite

This suite runs the app's Lore operations against a **real, locally spawned
`loreserver`** instead of mocks. It exercises the actual `@lore-vcs/sdk` native
FFI, the main-process service layer, and — for the UI subset — the running
Electron app, end to end.

Use it when you need confidence that a Lore operation behaves correctly against
a genuine server, not just against a stub. For the scenario-by-scenario list of
what it verifies today, see [Scenario catalog](./scenario-catalog.md).

## How it relates to the other test layers

| Layer | Runner | Server | Command |
|-------|--------|--------|---------|
| Unit / component | Jest | mocked | `pnpm test:jest` |
| UI end-to-end | Playwright | mocked | `pnpm test:play` |
| **Service integration** | `node:test` via `tsx` | **real `loreserver`** | `pnpm test:integration` |
| **Live-server UI e2e** | Playwright | **real `loreserver`** | `pnpm exec playwright test --project=electron-live-server` |

The service integration tests drive `LoreRepositoryService` directly in a Node
process — no Electron build required. The live-server UI subset launches the
built Electron app, so it needs a build first (`pnpm build`).

## Prerequisites

- **Platform:** macOS (Apple Silicon) or Linux (x64/arm64). The harness resolves
  Lore release binaries only for `apple-darwin` and `unknown-linux-gnu` targets;
  it throws on Windows (`tests/integration/harness/binaries.ts`, `mapOs`).
- **Network on first run only.** The harness downloads `loreserver` and `lore`
  from GitHub Releases once and caches them (see [Binary cache](#binary-cache)).
  Subsequent runs are offline.
- **Optional GitHub token.** Set `GITHUB_TOKEN` (or `LORE_GH_TOKEN`) to avoid
  unauthenticated GitHub API rate limits on a cold download. Not needed once the
  cache is warm.

## Running it

```bash
# Service integration tests (starts a real loreserver per test file)
pnpm test:integration

# Live-server UI e2e subset (needs a build; its own Playwright project)
pnpm build
pnpm exec playwright test --project=electron-live-server
```

`pnpm test:integration` runs `tsx --test 'tests/integration/**/*.test.ts'`. Each
`*.test.ts` file is its own OS process; the runner executes files concurrently.

The suite is **not** part of `pnpm claude:pre-commit` — it is a separate step
(local and in CI) because it provisions binaries and spawns servers.

## How it works

The harness lives in `tests/integration/harness/` and `tests/integration/support/`:

- **`harness/binaries.ts`** — `ensureLoreBinaries()` resolves the `loreserver`
  and `lore` binaries. It pins the version to the installed `@lore-vcs/sdk`
  package version, downloads the matching release asset
  (`<bin>-v<version>-<triple>.tar.gz`) from `EpicGames/lore`, unpacks it, and
  caches the executables. Repeated calls reuse the cache and make no network
  request.
- **`harness/server.ts`** — `startLoreServer()` spawns a hermetically isolated
  `loreserver`: it allocates free ports, writes a per-run config TOML pinning the
  store paths and ports, redirects `HOME`/`XDG_*`/`TMPDIR` to a throwaway dir,
  and resolves only after `GET /health_check` returns `200`. `stop()` shuts the
  process down (SIGTERM, then SIGKILL after a grace period) and removes the run
  directory; a process-exit safety net kills any server left tracked. The
  returned handle also exposes `createRepo()` and a `lore()` CLI runner wired to
  the server's isolated environment.
- **`support/world.ts`** — the test-facing helpers: `withServer()` (start a
  server + a fresh `LoreRepositoryService`, guaranteed teardown), `seedRepo()`
  and `seedAndClone()` (create and populate a server repo, then clone it),
  `secondClient()` (a second working copy that can move the remote), plus
  `sampleFiles()`, `writeSeedFiles()`, and `abs()`.

Tests use neutral identifiers — `user1`/`user2` for actors, `repo1`/`repo2` for
repositories — rather than named personas.

### In-process FFI isolation

`LoreRepositoryService` drives the SDK's native FFI in-process, and the FFI reads
and writes one global config file under `$HOME`. Concurrent test processes would
corrupt each other's reads of that shared file, so `withServer()` redirects
`HOME`/`XDG_*` once per process. Do not `new LoreRepositoryService()` outside
`withServer()` without that isolation.

## Binary cache

Downloaded binaries are cached at `.lore-test-cache/lore-bins/<version>/<triple>/`
(git-ignored). To force a fresh download, delete the directory:

```bash
rm -rf .lore-test-cache
```

## Continuous integration

CI runs both real-server steps on macOS only (the one platform with both a
published release asset and harness OS support). The workflow caches
`.lore-test-cache/lore-bins` keyed by version + triple and passes `GITHUB_TOKEN`,
so most CI runs restore the cache instead of downloading. See
`.github/workflows/ci.yml`.

## Adding a scenario

1. Add a `*.test.ts` under `tests/integration/workflows/` (happy-path service
   flows) or `tests/integration/edge-cases/` (failure and boundary conditions).
2. Wrap the body in `withServer()` and seed state with `seedRepo()` /
   `seedAndClone()`; use `secondClient()` when a second actor must move the
   remote.
3. Assert on the `LoreRepositoryService` result — the same seam the IPC layer
   calls. `stageFiles`/`unstageFiles` take absolute paths, so wrap repo-relative
   paths with `abs()`.
4. Add the scenario to the [Scenario catalog](./scenario-catalog.md).

For a UI-level scenario, add a test to `tests/e2e/electron/live-server.spec.ts`.
Note the ~3-real-launch ceiling per worker documented in that file.

## Troubleshooting

- **`Unsupported OS for Lore binaries` / block skips on Windows.** Expected: the
  suite runs on macOS and Linux only.
- **GitHub rate-limit or 403 on a cold run.** Set `GITHUB_TOKEN`, or warm the
  cache from a machine that has network access.
- **`loreserver did not become healthy`.** The harness prints the server log
  tail with the error. A stale cache can cause this — `rm -rf .lore-test-cache`
  and retry.
- **A test hangs on the first UI launch.** The Electron app's real FFI launch is
  occasionally slow to produce the first window; the live-server specs use
  `retries: 1` for this. See `tests/e2e/electron/live-server.spec.ts`.
