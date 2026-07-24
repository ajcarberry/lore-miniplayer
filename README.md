# Lore MiniPlayer

**An unofficial desktop client for the Lore revision control system** ([disclaimer](#disclaimer))

This is a minimal visual interface for managing Lore repositories. It provides basic repository management capabilities with a simple, user-friendly interface for teams adopting Lore.

## Quick Start

```bash
# Prerequisites: Node.js 20.19+ or 22.12+ required

# Install pnpm (if not already installed)
npm install -g pnpm

# Clone and setup
pnpm install

# Run the desktop app
pnpm dev:electron

# Build distributable package
pnpm dist
```

## Key Features

**Getting Started**
- 🔌 **Connect** to any Lore server by entering its address
- 📁 **Add repositories** by cloning from remote repos (with live clone progress) OR connecting to existing local folders
- 📂 **Manage multiple projects** in one interface

**Daily Workflow**
- 🔄 **Quick sync** to latest revision on your current branch
- 🌿 **Switch branches** and automatically sync to latest
- 📝 **View modified files** in your working directory
- ✅ **Stage/unstage files** for commit with simple UI
- 📋 **Write commit messages** with formatting guidance
- 💾 **Commit and Push changes** directly to Lore

**Daily Workflow (continued)**
- 📊 **Branch sync status** at a glance — see whether your branch matches the remote
- 🕐 **Revision history** for the current branch, right in the player

**Advanced Operations**
- 🎯 **Sync to specific revisions** using @123 notation or commit hashes
- 🔄 **Reset repository** to clean state (discards local changes)

**Interface**
- 💊 **Ambient pill player** — collapses to a compact, always-on-top pill; click to expand the full card (hover shows a quick peek), drag to move it anywhere on screen
- 🎨 **Light and dark themes** — follows your OS appearance, with a manual override in the player footer
- 🌈 **Per-repository accent colors** — each repository gets its own accent so you always know which one you're on

**Convenience Features**
- 📂 **Open in file explorer** - quickly browse local repository files
- 💻 **Open terminal** - start command line at repository location

## For Developers

### Prerequisites
- Node.js 20.19+ or 22.12+
- pnpm package manager
- A supported platform/architecture — the Lore SDK ships native binaries for:
  - macOS: Apple Silicon (arm64) only
  - Windows: x64
  - Linux: x64 and arm64

### Architecture Overview (+tooling)
- **Electron** app with main/renderer process separation
- **React + TypeScript** for the UI
- **Mantine UI** - Modern React components library for the interface
- **Lore SDK** (`@lore-vcs/sdk`) integration for repository operations
- **Secure IPC** communication with validation
- **Vite** - Fast build tool and development server
- **pnpm** - Efficient package manager
- **Jest** - Unit testing framework
- **Playwright** - End-to-end testing framework
- **ESLint** - Code linting and style enforcement
- **Prettier** - Code formatting

#### Mantine UI Framework
The application uses [Mantine](https://mantine.dev/) as the primary UI component library, providing a modern, accessible, and feature-rich interface.

**Resources:**
- 📚 [Documentation](https://mantine.dev/core/package/) - Complete component API and usage guides
- 🎨 [Examples](https://ui.mantine.dev/) - Interactive component demos and templates
- 📦 [Source Code](https://github.com/mantinedev/mantine) - Main Mantine repository
- 🔧 [Examples Source](https://github.com/mantinedev/ui.mantine.dev) - Source code for examples website

Mantine provides comprehensive components for forms, navigation, data display, and layout, with built-in dark/light theme support and TypeScript integration.

### Code Quality Standards
This project enforces strict standards for maintainable, secure code:
- **TypeScript Ultra-Strict** - No `any` types, explicit typing required
- **Automated Checks** - ESLint, Prettier, type checking on every commit
- **Lore SDK Reference** - See the [`@lore-vcs/sdk`](https://www.npmjs.com/package/@lore-vcs/sdk) package (README and bundled type declarations) for the SDK API

📖 Full details: [Coding Standards](.claude/.code/code_standards.md)

### Development Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start web version (port 5173) |
| `pnpm dev:electron` | Start electron desktop app with hot reload |
| `pnpm lint` | Check code quality |
| `pnpm lint:fix` | Auto-fix ESLint issues |
| `pnpm type-check` | Verify TypeScript types |
| `pnpm format` | Check code formatting with Prettier |
| `pnpm format:fix` | Auto-format code |

### Project Structure
```
src/
├── main/           # Electron main process
│   ├── index.ts    # Entry point, window creation
│   ├── preload.ts  # Secure bridge between main and renderer
│   ├── security.ts # Deny-by-default navigation/window-open/permission guards
│   ├── ipc/        # IPC handlers and validators
│   └── services/   # Business logic (repository store, Lore SDK, branch graph)
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
│   └── electron/   # Playwright Electron end-to-end tests (incl. live-server against a real loreserver)
├── integration/    # Real-server integration suite (tsx + node:test): harness/ + support/ + workflows/ + edge-cases/
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

### Claude Code Integration
The repository tracks a minimal [Claude Code](https://claude.com/claude-code) setup (optional — nothing here is required to build or contribute):

- `.claude/settings.json` - Permissions allowlist for common project commands
- `.claude/.code/code_standards.md` - The coding standards followed by AI and human contributors alike

## Testing

### Testing Philosophy
- Always write tests from the user's perspective - test what users see and do, not implementation details
- Focus on behavior, not internals

### Testing Tools
- **Jest**: Fast feedback loops, component testing, mocking, and testing JavaScript/TypeScript logic. 
- **Playwright**: Testing real user workflows across the entire application.
- **Real-server integration suite**: Runs the app's Lore operations against a real, locally spawned `loreserver` instead of mocks — service-layer flows plus a UI subset. See [docs/testing/integration-suite.md](docs/testing/integration-suite.md) and the [scenario catalog](docs/testing/scenario-catalog.md).

> **Note:** The Playwright E2E suite launches the built Electron app from `out/`, so it needs a build (`pnpm build`) — the e2e scripts run one automatically. `pnpm test:play:codegen` records against a Vite dev server for authoring new tests.

> **Note:** The real-server integration suite (`pnpm test:integration`) runs on **macOS and Linux only** and downloads the pinned `loreserver`/`lore` binaries from GitHub Releases on first run (cached under `.lore-test-cache/`, so later runs are offline). Set `GITHUB_TOKEN` to avoid API rate limits on a cold download. It is a separate step from `pnpm claude:pre-commit`.

### Testing Commands
| Command | Description |
|---------|-------------|
| `pnpm test` | Run all Jest and Playwright tests |
| `pnpm test:integration` | Run the real-server integration suite (spawns a local `loreserver`; macOS/Linux) |
| `pnpm pre-commit` | Run all checks before committing |
| `pnpm test:jest` | Run Jest unit tests (silent mode, only shows failures) |
| `pnpm test:play` | Run Playwright E2E tests in headed mode (see browser) |
| `pnpm test:jest:coverage` | Run tests with coverage report (prints the HTML report path) |
| `pnpm test:jest:verbose` | Debug mode with detailed output for each test |
| `pnpm test:play:ui` | Interactive UI mode (explore and run specific tests) |
| `pnpm test:play:debug` | Step-through debugging with Playwright Inspector |
| `pnpm test:play:codegen` | Record browser actions to generate test code |

### Build & Distribution Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build code for testing production behavior (use before `preview`) |
| `pnpm preview` | Test the built app locally without creating installer packages |
| `pnpm dist` | Create the installer package for the current platform |
| `pnpm dist:mac` | Clean, build, and package for macOS |
| `pnpm dist:mac:dev` | Build macOS package without compression (faster) |
| `pnpm dist:win` | Build and package for Windows |
| `pnpm dist:linux` | Build and package for Linux |

## Troubleshooting

### Log Files
The application automatically logs errors and debug information to help diagnose issues:

**Log Locations:**
- **macOS**: `~/Library/Application Support/lore-miniplayer/logs/main.log`
- **Windows**: `%APPDATA%\lore-miniplayer\logs\main.log`
- **Linux**: `~/.config/lore-miniplayer/logs/main.log`

**Log Features:**
- Automatic rotation (5MB max file size)
- Structured error context (operation, repository, paths)
- Both main process and renderer errors
- Lore SDK operation details

### Common Issues

**Connection Problems:**
- Check network connectivity to your Lore server
- Look for connection errors in logs

**Repository Clone/Sync Failures:**
- Ensure target directory has proper permissions
- Check available disk space
- Verify repository URL is accessible
- Review Lore SDK error messages in logs

**Performance Issues:**
- Large repositories require more time for initial sync
- Check system resources during operations

### Getting Help
When reporting issues, please include:
1. Log file contents from the time of the error
2. Steps to reproduce the problem
3. Repository information (if relevant)
4. Operating system and version

## Contributing

Before committing:
1. Run `pnpm pre-commit` (must pass)
2. Follow standards in `.claude/.code/code_standards.md`

These development gates are enforced:
- **Test-driven development** - Write the failing test first; no feature is complete without tests
- **Coverage ratchet** - `coverageThreshold` in `jest.config.js` is the source of truth; never lower it
- **Zod validation** - All IPC messages are validated with Zod schemas at the boundary
- **Mantine-only UI** - Use [Mantine](https://mantine.dev/) components; no custom equivalents where one exists

## Resources

- [Detailed Coding Standards](.claude/.code/code_standards.md)

## Disclaimer

Lore MiniPlayer is an unofficial, community-built desktop client for [Lore](https://github.com/EpicGames/lore). This project is not associated with, endorsed by, or affiliated with Epic Games, Inc. "Lore" and the Lore logo are trademarks of Epic Games, Inc., used here only to identify the software this client works with.

One of the maintainers of this project is also a maintainer on the upstream Lore project and contributes to Lore MiniPlayer in a personal capacity, on their own time. This work is independent of Epic Games and of the official Lore project.