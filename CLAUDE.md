# Claude Code Instructions

## Project Context
**Lore MiniPlayer** - Desktop client for the Lore revision control system. Electron + React + TypeScript application. 

## Architecture & Technology Stack

### Core Technologies
- **Electron** - Cross-platform desktop framework with main/renderer process separation
- **React + TypeScript** - UI framework with strict typing (ultra-strict mode, no `any` types)
- **Mantine UI** - Primary component library for all UI elements
- **Lore SDK** - `@lore-vcs/sdk` for repository operations
- **Vite** - Build tool and development server with hot reload
- **Secure IPC** - All main/renderer communication through validated IPC handlers
- **electron-log** - Structured error logging with file rotation for debugging and diagnostics

### UI Development Guidelines
**Mantine UI is the ONLY UI framework to use:**
- **NEVER create custom UI components** when Mantine equivalents exist
- **ALWAYS check Mantine docs first** before implementing any UI element
- Use [Mantine examples](https://ui.mantine.dev/) for implementation patterns
- Leverage built-in theming, validation, and accessibility features
- All forms, buttons, inputs, layouts, modals, etc. should use Mantine components

### Electron Architecture Patterns
- **Main Process**: Window management, file system access, Lore SDK operations
- **Renderer Process**: React UI in sandboxed environment with context isolation
- **Preload Script**: Secure bridge exposing only necessary APIs via contextBridge
- **IPC Communication**: All messages validated with Zod schemas
- **Security**: Context isolation enabled, node integration disabled, CSP enforced

## Coding Standards & Reference Files
📖 **CRITICAL**: Follow defined patterns in `.claude/.code/code_standards.md`
- `./.claude/.code/code_standards.md` - Comprehensive TypeScript/React/Electron standards
- `node_modules/@lore-vcs/sdk/README.md` - Canonical fluent-API usage of `@lore-vcs/sdk`
- `node_modules/@lore-vcs/sdk/dist/index.d.ts` and `dist/types/` - Full SDK type surface (args, enums, events)

### Context7 Documentation Sources
**ALWAYS use Context7 MCP for up-to-date library documentation.** Use these specific library IDs:

**Electron**:
- `/electron/electron` - Official Electron code repository
- `/websites/electronjs` - Official Electron documentation

**Mantine UI**: `/llmstxt/mantine_dev_llms_txt` - Comprehensive Mantine docs

**Electron-vite**: `/websites/electron-vite` - Electron-vite documentation

**When to use Context7:**
- Before implementing any Electron IPC patterns
- When working with Mantine components you're unfamiliar with
- When setting up build configuration with electron-vite
- For best practices and security patterns

## Required Practices & TDD Workflow

**Test-Driven Development is MANDATORY.** Follow this exact workflow for every feature:

### TDD Red-Green-Refactor Cycle
1. **🔴 RED**: Write a failing test that describes the desired functionality
   - Write test first, before any implementation
   - Test should fail for the right reason (feature doesn't exist yet)
   - Focus on user behavior, not implementation details
   - Structure tests using Given-When-Then format in comments
   - No false, artificial, or mocked successful test results

2. **🟢 GREEN**: Write the minimal code necessary to make the test pass
   - Implement only what's needed to pass the test
   - Don't add extra features or optimizations yet
   - Get to green as quickly as possible

3. **♻️ REFACTOR**: Improve code structure while keeping all tests green
   - Clean up code without changing behavior
   - Extract functions, improve naming, remove duplication
   - Run tests continuously to ensure nothing breaks

### Testing Strategy
**Prefer integration testing over mocks.** Use mocks sparingly for external services and slow operations. Focus on testing real component interactions and business logic flows.

**Test data guidelines:**
- When mock data is required: 
  - Use realistic data that matches production schemas
  - Validate all test data against Zod schemas to ensure accuracy
  - Capture real Lore SDK event streams as test fixtures
- Use mock data to test with edge cases (empty arrays, long strings, special characters)
- Test component integration within our codebase WITHOUT mocks

### Additional Requirements
- **Coverage is enforced** via `coverageThreshold` in `jest.config.js` — that file is the single source of truth (ratchet currently: 93% statements / 84% branches for `src/main/services/`, 100% for `src/shared/`, 85% statements / 76% branches for the IPC + renderer remainder). Never lower the ratchet; raise it as coverage improves
- Run `pnpm claude:pre-commit` before marking any task complete
- ALWAYS validate external inputs with Zod schemas
- ALWAYS cleanup resources (listeners, timers, abort controllers)
- No feature is complete without comprehensive test coverage

## Essential Commands

### REQUIRED before task completion:
```bash
pnpm claude:pre-commit  # Validates types, formatting, linting, and tests (Jest + Playwright)
```

### Development workflow:
```bash
pnpm dev:electron        # Start desktop app with hot reload
pnpm claude:quick-check  # Fast validation: types, format, lint, Jest (no Playwright)
pnpm claude:type-check   # After any TypeScript changes
pnpm claude:lint         # Check for code issues (JSON output for parsing)
pnpm claude:test:jest    # Fast unit test feedback
pnpm claude:test:play    # E2E validation
pnpm format:fix          # Auto-fix formatting issues
```

## Project Structure
```
src/
├── main/           # Electron main process
│   ├── index.ts    # Entry point, window creation
│   ├── preload.ts  # Secure bridge between main and renderer
│   ├── security.ts # Deny-by-default navigation/window-open/permission guards
│   ├── ipc/        # IPC handlers and validators
│   └── services/   # Business logic (repository store, Lore SDK, branch graph,
│                   #   workspaces + teardown, diff, merge, locks, workspace model,
│                   #   agent observer [localhost hook listener], agent transcript)
├── renderer/       # React UI application
│   ├── App.tsx     # Root component
│   ├── components/ # UI components
│   └── styles/     # CSS and animations
├── shared/         # Shared between main and renderer
│   ├── types.ts    # TypeScript interfaces
│   └── schemas.ts  # Zod validation schemas
└── types/          # Global type definitions

tests/
├── e2e/
│   └── electron/   # Playwright Electron end-to-end tests
├── main/           # Main process tests
├── renderer/       # React component tests
├── mocks/          # Test mocks and fixtures
└── setup.ts        # Jest configuration

assets/             # Static assets (logos, icons)
build/              # Electron-builder resources
out/                # Built application (dev/prod)
dist/               # Distribution packages (.dmg, .exe, etc.)
coverage/           # Test coverage reports
```

## Electron Security Patterns
- **NEVER** use `process.cwd()` for config paths - use `app.getPath('userData')`
- **ALWAYS** validate IPC messages with Zod schemas before processing
- **NEVER** expose Node APIs directly to renderer - use contextBridge in preload
- **ALWAYS** enable context isolation and disable node integration
- **ALWAYS** keep the deny-by-default guards in `src/main/security.ts` wired to new windows/sessions: `window.open` denied, navigation restricted to the app bundle and dev server, permission requests denied
- **NEVER** build a shell command string from a user-controlled path — pass paths as argv elements or `cwd` (see the terminal launcher in `window-handlers.ts`)

## Error Handling & Logging

The application uses **electron-log** for structured error logging with automatic file rotation and comprehensive error context. All errors must be logged - no silent failures allowed.

**Key Principles:**
- **Log every error** with structured context (operation, error object, relevant data)
- **Preserve user experience** - Lore SDK error messages are passed through as-is
- **Complement Result pattern** - logging provides debugging context while Result<T> handles IPC contracts
- **Never use empty catch blocks** - all errors must be logged or explicitly handled

**Implementation Details:**
📖 See comprehensive patterns and examples in `.claude/.code/code_standards.md` section 13

## Lore Integration Notes
- Uses `@lore-vcs/sdk` (fluent API) for repository operations; the SDK lives in the main process only
- Every operation is `lore.<op>(globalArgs, args)` returning a fluent executor: `.callback(fn).waitAsync()`, `.collectAsync()`, or `.asyncIter()`
- The repository is addressed per call via `globalArgs.repositoryPath` — there is no client/repository instance
- Failures throw `LoreError`; results and progress stream as events (`LoreEventTag`) through the callback
- Any event payload retained past the callback tick must be detached with `event.clone()` (FFI memory)
- Supports branch switching, revision sync (specific revisions, reset, force), cloning
- **Commit operations**: File staging/unstaging (`fileStage`, `fileUnstage`), commit + push
- **Working directory status**: `repositoryStatus` streams `REPOSITORY_STATUS_FILE` events with staged/dirty/conflict flags
- **Push channels to the renderer**: server notifications (`lore:notification`), clone progress (`lore:repository:clone-progress`), agent observability events, and workspace-model snapshots (`workspace:model:snapshot`) are one-way `webContents.send` pushes forwarded from service EventEmitter events; payloads cross the bridge as `unknown` and are Zod-validated in the renderer before use
- **Agent observability**: provisioning writes fire-and-forget observer hooks into each workspace's `.claude/settings.local.json` targeting a loopback-only, token-authenticated HTTP listener (`agent-observer.ts`); transcript enrichment (`agent-transcript.ts`, flag `LORE_MINIPLAYER_TRANSCRIPT_ENRICHMENT`) reads only under `~/.claude/projects` — see `docs/agentic-demo-runbook.md` for the live demo script
- **Unified workspace registry**: a workspace is a local directory + Lore repo pairing, tracked in one `workspaces.json` registry (migrated from the legacy repositories/instances files); the card-view footer selector and Mission Control fully interop (provisioned workspaces selectable from the footer, the anchor card-view checkout listed as an active member in Mission Control); removal offers `workspace:forget` (untrack only) vs. guarded teardown (destructive); Mission Control's header refresh button (`workspace:model:refresh`) supplements the automatic triggers
- **Notice channel to main**: `window:setNoticeActive` is a one-way renderer→main send (Zod-validated boolean) reporting the sync-needed signal; while active, the window skips its unfocused 70% dim so the collapsed pill's notice pulse stays visible (see `attachFocusDimming` in `window-handlers.ts`)

## Cross-Platform Support
- **Windows compatibility**: Full support with platform-specific path validation (MAX_PATH limits, reserved names, invalid characters)
- **Path handling**: Secure cross-platform IPC handlers for file system operations
- **Terminal integration**: PowerShell on Windows, `open -a Terminal` on macOS, gnome-terminal/xterm on Linux — the directory is always passed as an argv element or `cwd`, never inside a shell string
- **Build targets**: macOS (arm64 DMG), Windows (x64 NSIS), Linux (x64 AppImage)