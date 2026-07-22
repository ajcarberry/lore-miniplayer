# Agentic Development Demo Runbook

Executes the Sufficiency Demo from `.claude/mission/spec.md` (the "Done When"
script for OBJ-2 through OBJ-5) against a **real Lore server** and **real
Claude Code sessions**. Unlike the Playwright e2e suite (`tests/e2e/electron/`,
which proves what is reachable offline), every step here is meant to be run by
a human, once, in one sitting, to produce first-hand OBJ evidence. This
document is self-contained — no other doc is needed to run it.

## Prerequisites

1. **A live Lore server**, reachable from this machine, hosting a repository
   you can read and write. Note its address (`lores://host` or `lore://host`)
   and the repository's URL as it appears in the server's repository list.
   - Provisioning a workspace clones from this server (shared-store clone —
     P1 finding: this is the one path that genuinely needs a server; it
     cannot be exercised offline). If the server is unreachable, provisioning
     fails at the clone step and nothing else in this runbook is reachable.
2. **A second identity** on the same server (a colleague's account, or a
   second login you control) able to push to the same repository. Needed for
   the OBJ-3 attribution-toast step.
3. **The MiniPlayer**, built and launched:
   ```bash
   pnpm build && pnpm dev:electron
   ```
   (or run the packaged app from `dist/`, once built).
4. **Claude Code** installed and authenticated on this machine — the "agent"
   this mission implements observability for. Each provisioned workspace gets
   its own `.claude/settings.local.json` with observer hooks pre-wired; you
   run `claude` yourself in the terminal Mission Control opens.
5. **`LORE_MINIPLAYER_TRANSCRIPT_ENRICHMENT`** — leave unset. Enrichment
   (the intention panel's prompt/task-list/narrative, OBJ-5) defaults **ON**;
   only `off`/`0`/`false` disables it. If you want to see the honest
   degradation instead (diff-only review, no intention panel), set it to
   `0` before launching and skip straight to the review step.

Add the repository to the MiniPlayer first (footer's Workspaces icon →
"Add workspace…") if it isn't there already — either clone-and-add or point
at an existing local checkout. Confirm the card shows "On branch" before
continuing.

## The demo

Each step names its **expected observable outcome** and the **OBJ** it is
evidence for. Screenshot or note the outcome as you go — that note *is* the
mission's OBJ-2..5 evidence.

### 1. Provision two workspaces

From the card's footer, click the target-shaped **Mission Control** icon (or
the pill/card's attention chip, once one exists). Mission Control already
shows one **Idle** row — the anchor workspace, i.e. the checkout the card
itself is on, marked **active** (since the workspace unification, Mission
Control composes the anchor as a listed member, not just provisioned
worktrees). Click **+ Provision workspace** twice, giving each a distinct
branch name (e.g. `agent/changelog-summary`, `agent/util-refactor`). Confirm
each.

- **Observable:** each provision streams clone progress, then lands a new row
  in the **Idle** band — three idle rows total once both land (the anchor,
  still marked active, plus the two new workspaces). Hovering a card's
  branch name reveals the worktree path (a sibling `<repo>-wt/<branch>`
  directory). Check disk: each new path exists and contains a real Lore
  checkout plus `.claude/settings.local.json` with an injected `http` hook
  pointing at `127.0.0.1:<observer port>`.
- **Evidences:** OBJ-2 (workspace lifecycle — provisioning, hooks installed).

### 2. Dispatch

For each idle workspace, click **Open terminal** (from the row, or from
Mission Control's card once it activates). In each terminal, `cd` is already
the workspace directory — run `claude` and give each a real task, e.g.:

- Workspace A: a task that needs a permission prompt Claude Code will stop
  and ask about (a shell command, a destructive edit, or anything outside an
  allowlisted tool) — this is the one that will block.
- Workspace B: a small, self-contained task it can complete without asking
  (or pre-approve its tools) — this is the one that will finish.

- **Observable:** shortly after each session starts, the pill's attention
  chip shows a quiet hairline "play" chip with a count (agents working,
  nothing needs you yet).
- **Evidences:** OBJ-2 (dispatch), OBJ-4 (the quiet-working chip state).

### 3. One agent blocks — attention triages to it

When workspace A's session hits its permission prompt, Claude Code emits the
`Notification` hook (waiting-on-you).

- **Observable:** within ~2 seconds, the pill's chip flips to the amber
  pulsing "1" state and the whole pill breathes; in Mission Control, workspace
  A's card rises into **In progress** ahead of any other card, showing the
  live "waiting" state. Click the chip (or the card) — it opens/focuses
  Mission Control on the right repo.
- **Evidences:** OBJ-4 (attention triage, ordering, ~2s latency, chip state).

Go to workspace A's terminal and answer the prompt so the session continues.

### 4. The other agent finishes

Workspace B's session stops after completing its task (`Stop` hook).

- **Observable:** its card now leads **Awaiting review**, showing the agent's
  own summary, file stats (+/−), and the session's commits since
  provisioning.
- **Evidences:** OBJ-4 (banding: a finished agent with something to review
  lands in *Awaiting review*, ahead of idle workspaces).

### 5. Review: diffs beside what was asked

Click **Review** on workspace B's card.

- **Observable:** the review window opens three panes — files (stage
  checkboxes) on the left, a unified diff in the center, and on the right the
  **intention panel**: Asked (the first prompt), Task list, the agent's own
  account/commentary, and session + cost. The compare picker defaults to the
  workspace's revision → working tree.
- **Evidences:** OBJ-5 (intention alongside diff, sourced from the real
  transcript — confirm the Asked/task text matches what you actually typed).

### 6. Stage, commit, push

In the review window, stage the changed files, write a commit message, click
**Commit**, then **Push**.

- **Observable:** the working set clears (staged → committed); the push
  succeeds against the live server.
- **Evidences:** OBJ-2 (integrate — commit/push stage of the loop).

### 7. Merge into main — a real conflict, accept mine

Before merging, from a second checkout (or ask your collaborator) make a
small edit to the **same line** of a file workspace B also touched, and push
it to `main`, so the merge has something to resolve. Back in Mission Control,
click **Merge → main** on workspace B's card.

- **Observable:** the merge view opens; the merge starts automatically.
  Files with no overlap show as auto-merged (inert). The conflicting file
  shows a conflict block with **Accept theirs (main @ rN)** / **Accept mine
  (branch)** side by side. Click **Accept mine**. The Merge button enables
  once every conflict is resolved; click it.
- **Observable (land):** the merge commit lands on `main` (check the
  server/branch history — main's tip advances); the workspace's own checkout
  and branch are restored intact afterward.
- **Evidences:** OBJ-2 (integrate — merge with conflict resolution, landing
  on main; the spec's biggest scope addition over the pre-mission app).

### 8. A collaborator's push toasts by name

Have your second identity push a small commit to the repository (any branch
the MiniPlayer is currently watching, or `main`).

- **Observable:** within a few seconds, a toast appears at the top of the
  card: `"<name> pushed r<N> to <branch>"`, auto-dismissing after 5 seconds.
- **Evidences:** OBJ-3 (collaborators visible, attributed by name).
- **If the toast shows a raw id instead of a name:** see "Degradations" below
  — this is the expected, honest fallback when name resolution isn't
  available.

*(Optional, same OBJ)* While a conflict is unresolved, open the card's
working set — the conflicted file's row shows a **⚠** in place of its stage
checkbox and refuses to be staged until the conflict clears.

### 9. Close the workspace

Back in Mission Control, click **✕** on workspace B's card (now idle again
post-merge, or wherever it landed). This is teardown — the destructive,
guarded removal; **Forget** (the untrack-only alternative next to it) would
instead stop tracking the workspace without touching its files, and needs no
confirmation since nothing is destroyed.

- **Observable:** a confirm modal states exactly what will be removed — the
  worktree directory and the local branch (archived) — and that the remote
  branch is **not** removed (see "Degradations"). If the workspace has
  uncommitted/unpushed work, a red alert requires an explicit "force close"
  checkbox before the confirm button enables. Confirm.
- **Observable (result):** the worktree directory is gone from disk; Mission
  Control drops to two members (the anchor, always present, plus workspace A,
  if not also closed).
- **Evidences:** OBJ-2 (workspace lifecycle close), the destructive-operation
  confirmation gate (mission stakes rule — teardown deletes a directory and
  a branch).

Repeat step 9 for workspace A once you're done with it.

## Degradations (honest, by design)

- **Raw `userId` in toasts/locks when no auth endpoint is reachable.** Lore-
  side authorship (`revisionTreeInfo.authorIdentity`) is empty on a purely
  local/offline commit and `authUserInfo` needs a server auth endpoint (P1
  finding c). Attribution therefore rides the notification's own `userId`,
  resolved to a display name only when the server's auth endpoint answers;
  otherwise the toast/lock UI shows the raw id verbatim rather than
  fabricating a name.
- **Hookless (or not-yet-started) workspaces never claim agent state they
  don't have.** If Claude Code isn't run in a workspace (or its hook write
  was refused — e.g., a symlinked `.claude`, blocked as a security guard),
  Mission Control still bands it correctly from Lore signals alone
  (uncommitted/unpushed → *Awaiting review*, otherwise *Idle*) but never
  shows a task ticker, commentary, or "review ready" reason that would imply
  agent involvement that didn't happen.
- **Remote branch removal is a server ask, not an app operation.** Workspace
  close removes the worktree directory and archives the *local* branch
  (`branchArchive` — the SDK has no branch-delete op, P1 finding d). The
  remote branch is left in place; removing it is a server-side operation
  outside this app's scope.
- **Binary-file diffs use an empty-patch heuristic, not an SDK flag.** The
  diff service infers "binary" from an empty patch on a changed file (no
  native binary indicator exists in the SDK's `fileDiff` output). If you
  include a binary file in the demo, confirm the file list shows it as
  binary + size rather than an empty/garbled diff — this is the expected
  fallback, not a bug.
- **Merge conflict resolution is per-file, not per-hunk.** `branchMergeResolveMine`/
  `Theirs` operate on the whole file (P1 finding e); if a file has multiple
  conflicting hunks, accepting "mine" or "theirs" applies to all of them at
  once. This matches the design's shown case (one conflict per file) but is
  worth calling out if your conflict file happens to have more than one
  hunk.
- **Assisted review is out of scope entirely** (design decision, not a
  degradation) — nothing in this demo exercises a reviewer agent attaching
  to the diff; the intention panel and diff pipeline are simply built so that
  could attach later.
