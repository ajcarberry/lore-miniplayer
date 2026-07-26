# Documentation

Project documentation for Lore MiniPlayer. For build, run, and contribution
basics, start with the root [README](../README.md).

## Testing

- [E2E coverage & the feature-coverage mandate](./testing/e2e-coverage.md) — the
  requirement that every user-facing feature has a live-server e2e test, the
  capability → scenario coverage index, and how to extend it.
- [E2E architecture](./testing/e2e-architecture.md) — how the Playwright
  Electron suite runs: the `run-server` evaluation, hidden/parallel launches,
  the CI-only focus project, and the multi-worktree isolation model.
- [Real-server integration suite](./testing/integration-suite.md) — how to run
  the suite that spawns a real `loreserver`, how it works, and how to add a
  scenario.
- [Scenario catalog](./testing/scenario-catalog.md) — every scenario the
  real-server suite verifies today.

## Related references

- [Coding standards](../.claude/.code/code_standards.md) — TypeScript / React /
  Electron standards, including testing (section 5).
