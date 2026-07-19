# TypeScript/React/Electron Coding Standards - Lore MiniPlayer

**Tools**: ESLint, Prettier, TypeScript strict, Jest + RTL, Playwright
**Stack**: Electron + React + TypeScript + Vite

---

## 0) Quick Reference

1. **Type everything strictly** - no `any`, no implicit types; run `tsc --strict`
2. **Validate ALL external data** - Props, IPC messages, user inputs with Zod schemas
3. **Use structured error handling** - Custom Error classes with actionable messages
4. **Test user behavior only** - What users see/do, not implementation details
5. **Keep React pure** - No side effects in render, effects only in useEffect
6. **Explicit dependency arrays** - Always declare useEffect dependencies
7. **Handle all async properly** - AbortController for cancellation, error boundaries
8. **Context isolation enforced** - No node APIs in renderer without preload
9. **Memory cleanup mandatory** - Remove listeners, cancel timers, abort requests
10. **Coverage ratchet enforced** - `coverageThreshold` in `jest.config.js` is the floor (90% is the long-term target, not the current minimum); Jest for components, Playwright for workflows
11. **Enforce with tools**: `pnpm claude:pre-commit` (types, lint, format, Jest, and Playwright in one gate)

---

## 0.5) Critical Security Checklist

### File System Access
```typescript
// ❌ NEVER use process.cwd() for config paths - attacker controlled
const configPath = path.join(process.cwd(), 'config.yaml');

// ✅ ALWAYS use app.getPath() for secure paths
import { app } from 'electron';
const configPath = path.join(app.getPath('userData'), 'config.yaml');
```

### IPC Message Validation
```typescript
// ❌ NEVER trust IPC messages without validation
ipcMain.handle('save-file', async (event, path, content) => {
  await fs.writeFile(path, content); // SECURITY HOLE!
});

// ✅ ALWAYS validate with Zod schemas
const SaveFileSchema = z.object({
  filename: z.string().regex(/^[a-zA-Z0-9-_]+\.(txt|md|json)$/),
  content: z.string().max(1_000_000),
});

ipcMain.handle('save-file', async (event, data: unknown) => {
  const { filename, content } = SaveFileSchema.parse(data);
  const safePath = path.join(app.getPath('userData'), 'files', filename);
  await fs.writeFile(safePath, content);
});
```

### Content Security Policy
```typescript
// main/index.ts - REQUIRED in production
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
      ].join('; ')
    }
  });
});
```

### Sandbox Configuration
```typescript
// ALWAYS enable sandbox in BrowserWindow
const mainWindow = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,        // NEVER true
    contextIsolation: true,         // ALWAYS true
    sandbox: true,                  // ALWAYS true in production
    webSecurity: true,              // NEVER false
    allowRunningInsecureContent: false,
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

---

## 1) TypeScript Standards

### Strict Configuration (tsconfig.json)
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Type Safety Rules
```typescript
// ALWAYS type function parameters and returns
function processUserData(data: UserInput): Promise<ProcessedData> {
  // Never use 'any' - be explicit
  return validateAndProcess(data);
}

// Use branded types for domain safety
type UserId = string & { readonly brand: unique symbol };
type RepoId = string & { readonly brand: unique symbol };

function createUserId(value: string): UserId {
  if (!value.match(/^usr_[a-zA-Z0-9]+$/)) {
    throw new ValidationError("Invalid user ID format");
  }
  return value as UserId;
}

// NEVER use assertion without validation
// BAD
const userId = userInput as UserId;

// GOOD
const userId = createUserId(userInput);
```

### Union Types Over Enums
```typescript
// PREFER union types - tree-shakeable and type-safe
type Theme = 'light' | 'dark' | 'system';
type RepositoryStatus = 'clean' | 'modified' | 'staged' | 'conflict';

// AVOID enums unless you need runtime values
enum Status { Clean, Modified } // Creates runtime object

// Use const assertions for readonly data
const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'] as const;
type Language = typeof SUPPORTED_LANGUAGES[number];
```

---

## 2) React Component Standards

### Size and Complexity Limits (ESLint-enforced)
These are enforced as errors in `eslint.config.js` — do not disable them; decompose instead:

- **`max-lines`: 400** per file (blank lines and comments excluded)
- **`max-lines-per-function`: 200** — this is the effective component-size ceiling
- **`complexity`: 15** cyclomatic complexity per function
- **`max-depth`: 4** nesting levels

When a component approaches the limits, extract along these seams (in order of preference):
1. **Custom hooks** for stateful logic (`src/renderer/hooks/`) — data fetching, derived state, operation handlers
2. **Child components** for distinct UI regions (selectors, views, modals)
3. **Module-level helper functions** for pure branching logic (button text, validation, formatting)

**Data-fetching hooks must not call setState synchronously in effects**
(`react-hooks/set-state-in-effect` is an error). Derive loading state by
comparing loaded data's identity with the current input (e.g.
`isLoading = data?.repoId !== repo.id`), set state only after `await`, and
use during-render state adjustment (the `prev`-tracking pattern from
react.dev "You Might Not Need an Effect") to sync state with props.

### Component Structure
```typescript
// ALWAYS use this exact pattern
interface ComponentProps {
  readonly title: string;
  readonly onAction: (data: ActionData) => void;
  readonly isLoading?: boolean;
}

export function Component({ title, onAction, isLoading = false }: ComponentProps): JSX.Element {
  // 1. Hooks first (in order: state, effects, custom)
  const [data, setData] = useState<Data | null>(null);

  // 2. Event handlers
  const handleClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onAction({ type: 'click', timestamp: Date.now() });
  }, [onAction]);

  // 3. Effects last
  useEffect(() => {
    // ALWAYS specify dependencies explicitly
    if (title) {
      document.title = title;
    }
  }, [title]); // Never empty array unless truly no dependencies

  // 4. Early returns for loading/error states
  if (isLoading) {
    return <LoadingSpinner />;
  }

  // 5. Main render
  return (
    <div>
      <h1>{title}</h1>
      <button onClick={handleClick} type="button">
        Action
      </button>
    </div>
  );
}
```

### Hook Rules (Critical for Memory Safety)
```typescript
// ALWAYS cleanup in useEffect
useEffect(() => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    // Work here
  }, 1000);

  // MANDATORY cleanup
  return () => {
    controller.abort();
    clearTimeout(timeoutId);
  };
}, []);

// NEVER create objects in render - use useMemo/useCallback
// BAD - New object every render
function Component() {
  const style = { color: 'red' }; // New object each render!
  return <div style={style} />;
}

// GOOD - Stable references
function Component() {
  const style = useMemo(() => ({ color: 'red' }), []);
  return <div style={style} />;
}
```

### Error Boundaries (Required)
```typescript
// EVERY route must have error boundary
interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error?: Error;
}

export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  constructor(props: PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to telemetry service
    console.error('React Error Boundary:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorDisplay
          message="Something went wrong"
          details={this.state.error?.message}
          onRetry={() => this.setState({ hasError: false })}
        />
      );
    }

    return this.props.children;
  }
}
```

---

## 3) Electron IPC Security

### Preload Script (Security Critical)
```typescript
// preload.ts - ONLY expose what renderer needs
import { contextBridge, ipcRenderer } from 'electron';

// Define strict API surface
interface ElectronAPI {
  readonly repo: {
    readonly getStatus: () => Promise<RepositoryStatus>;
    readonly commitChanges: (message: string) => Promise<CommitResult>;
  };
  readonly file: {
    readonly openDialog: () => Promise<string[]>;
    readonly readFile: (path: string) => Promise<string>;
  };
}

// NEVER expose entire ipcRenderer - security risk
contextBridge.exposeInMainWorld('electronAPI', {
  repo: {
    getStatus: (): Promise<RepositoryStatus> =>
      ipcRenderer.invoke('repo:get-status'),
    commitChanges: (message: string): Promise<CommitResult> =>
      ipcRenderer.invoke('repo:commit', message),
  },
  file: {
    openDialog: (): Promise<string[]> =>
      ipcRenderer.invoke('file:open-dialog'),
    readFile: (path: string): Promise<string> =>
      ipcRenderer.invoke('file:read', path),
  },
} satisfies ElectronAPI);

// Extend global Window interface
declare global {
  interface Window {
    readonly electronAPI: ElectronAPI;
  }
}
```

### Main Process IPC Handlers — the single Result<T> contract

Every invoke-style channel returns `Result<T>` (`src/shared/types.ts`):

```typescript
type Result<T> = { success: true; data: T } | { success: false; error: string };
```

Handlers never throw across the IPC boundary — Electron strips the fields of
thrown errors crossing `ipcMain.handle`, so a structured throw degrades into
an opaque message on the renderer side. Instead, register every handler with
the `handleResult` helper (`src/main/ipc/result-helpers.ts`), which owns the
whole boundary pattern:

- validates the channel's positional arguments as one Zod tuple
  (`safeParse` — an invalid payload becomes a failure result carrying the
  first issue's message, without reaching the operation)
- wraps the operation's return value in `success()`
- logs failures with the channel name as the `operation` key and maps thrown
  errors to `failure()`

```typescript
// main/ipc/validators.ts — one args schema per channel
export const LoreCommitArgsSchema = z.tuple([
  z.string('Invalid repository path'),
  z
    .string('Invalid commit message')
    .refine(message => message.trim().length > 0, 'Invalid commit message'),
]);

// main/ipc/lore-handlers.ts — registration is one declarative call
handleResult(log, 'lore:repository:commit', LoreCommitArgsSchema, (repositoryPath, message) =>
  loreRepositoryService.commit(repositoryPath, message)
);
```

Rules:
- ALWAYS validate IPC messages with a Zod args schema in
  `src/main/ipc/validators.ts` — never `typeof` guards or `as` casts
- NEVER throw from a handler; the only IPC failure surface is the failure
  result (`window:setExpanded` is the one deliberate exception: it never
  fails and returns its `{ anchor }` payload directly)
- Give schema fields user-facing messages — the renderer surfaces
  `result.error` verbatim

### Renderer IPC Usage
```typescript
// hooks/useRepository.ts
import { useState, useCallback } from 'react';

interface RepositoryHook {
  readonly status: RepositoryStatus | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refreshStatus: () => Promise<void>;
}

export function useRepository(): RepositoryHook {
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);

    // Result-based calls don't throw: check `success` instead of catching
    const result = await window.electronAPI.repo.getStatus();
    if (result.success) {
      setStatus(result.data);
    } else {
      setError(result.error);
    }
    setIsLoading(false);
  }, []);

  return { status, isLoading, error, refreshStatus };
}
```

---

## 4) Input Validation & Security

### Zod Schemas (Mandatory for All External Data)
```typescript
// schemas/validation.ts
import { z } from 'zod';

// ALWAYS create schemas for external data
export const UserInputSchema = z.object({
  name: z.string()
    .min(1, 'Name required')
    .max(100, 'Name too long')
    .regex(/^[a-zA-Z0-9\s-]+$/, 'Invalid characters in name'),
  email: z.string().email('Invalid email format'),
  age: z.number().int().min(13).max(120),
});

export const FilePathSchema = z.string()
  .min(1, 'Path required')
  .refine(path => !path.includes('..'), 'Path traversal not allowed')
  .refine(path => path.startsWith('/'), 'Must be absolute path');

// Use branded types with validation
export type ValidatedUserInput = z.infer<typeof UserInputSchema>;

export function validateUserInput(data: unknown): ValidatedUserInput {
  return UserInputSchema.parse(data);
}
```

### Form Validation Pattern
```typescript
// components/UserForm.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

interface UserFormProps {
  readonly onSubmit: (data: ValidatedUserInput) => void;
}

export function UserForm({ onSubmit }: UserFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ValidatedUserInput>({
    resolver: zodResolver(UserInputSchema),
    mode: 'onBlur', // Validate on blur for immediate feedback
  });

  const onSubmitHandler = useCallback(async (data: ValidatedUserInput): Promise<void> => {
    try {
      await onSubmit(data);
    } catch (error) {
      // Form-level error handling
      console.error('Form submission failed:', error);
    }
  }, [onSubmit]);

  return (
    <form onSubmit={handleSubmit(onSubmitHandler)} noValidate>
      <div>
        <label htmlFor="name">Name</label>
        <input
          {...register('name')}
          id="name"
          type="text"
          aria-invalid={errors.name ? 'true' : 'false'}
          aria-describedby={errors.name ? 'name-error' : undefined}
        />
        {errors.name && (
          <span id="name-error" role="alert">
            {errors.name.message}
          </span>
        )}
      </div>

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  );
}
```

---

## 5) Testing Standards

### Test Structure (User-Focused)
```typescript
// tests/components/UserForm.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserForm } from '../../src/components/UserForm';

describe('UserForm', () => {
  it('allows user to submit valid form data', async () => {
    // Arrange
    const user = userEvent.setup();
    const mockSubmit = jest.fn().mockResolvedValue(undefined);
    render(<UserForm onSubmit={mockSubmit} />);

    // Act - simulate real user behavior
    await user.type(screen.getByLabelText(/name/i), 'John Doe');
    await user.type(screen.getByLabelText(/email/i), 'john@example.com');
    await user.type(screen.getByLabelText(/age/i), '25');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Assert - verify user-visible behavior
    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith({
        name: 'John Doe',
        email: 'john@example.com',
        age: 25,
      });
    });
  });

  it('shows validation errors when user submits invalid data', async () => {
    // Arrange
    const user = userEvent.setup();
    const mockSubmit = jest.fn();
    render(<UserForm onSubmit={mockSubmit} />);

    // Act - user submits empty form
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Assert - user sees error messages
    expect(screen.getByText(/name required/i)).toBeInTheDocument();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
```

### Mock Electron APIs
```typescript
// tests/setup/electron-mocks.ts
interface MockElectronAPI {
  repo: {
    getStatus: jest.MockedFunction<() => Promise<RepositoryStatus>>;
    commitChanges: jest.MockedFunction<(message: string) => Promise<CommitResult>>;
  };
}

export const mockElectronAPI: MockElectronAPI = {
  repo: {
    getStatus: jest.fn(),
    commitChanges: jest.fn(),
  },
};

// Mock the global electronAPI
Object.defineProperty(global.window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true,
});
```

### E2E Testing Pattern
```typescript
// tests/e2e/commit-workflow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Commit Workflow', () => {
  test('user can commit changes with message', async ({ page }) => {
    // Navigate to app
    await page.goto('/');

    // User sees uncommitted changes
    await expect(page.getByText('2 files modified')).toBeVisible();

    // User writes commit message
    await page.getByLabel('Commit message').fill('Fix authentication bug');

    // User commits changes
    await page.getByRole('button', { name: 'Commit Changes' }).click();

    // User sees success confirmation
    await expect(page.getByText('Changes committed successfully')).toBeVisible();

    // Repository status updates
    await expect(page.getByText('Working directory clean')).toBeVisible();
  });

  test('prevents empty commit messages', async ({ page }) => {
    await page.goto('/');

    // User tries to commit without message
    await page.getByRole('button', { name: 'Commit Changes' }).click();

    // User sees validation error
    await expect(page.getByText('Commit message required')).toBeVisible();
  });
});
```

---

## 6) State Management

### Context Pattern (Prefer over Redux for simplicity)
```typescript
// contexts/RepositoryContext.tsx
interface RepositoryState {
  readonly status: RepositoryStatus | null;
  readonly branches: Branch[];
  readonly currentBranch: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

interface RepositoryActions {
  readonly refreshStatus: () => Promise<void>;
  readonly switchBranch: (name: string) => Promise<void>;
  readonly createBranch: (name: string) => Promise<void>;
}

type RepositoryContextValue = RepositoryState & RepositoryActions;

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function useRepository(): RepositoryContextValue {
  const context = useContext(RepositoryContext);
  if (!context) {
    throw new Error('useRepository must be used within RepositoryProvider');
  }
  return context;
}

// Reducer pattern for complex state
type RepositoryAction =
  | { type: 'LOADING' }
  | { type: 'STATUS_LOADED'; payload: RepositoryStatus }
  | { type: 'ERROR'; payload: string }
  | { type: 'BRANCH_SWITCHED'; payload: string };

function repositoryReducer(state: RepositoryState, action: RepositoryAction): RepositoryState {
  switch (action.type) {
    case 'LOADING':
      return { ...state, isLoading: true, error: null };
    case 'STATUS_LOADED':
      return { ...state, isLoading: false, status: action.payload };
    case 'ERROR':
      return { ...state, isLoading: false, error: action.payload };
    case 'BRANCH_SWITCHED':
      return { ...state, currentBranch: action.payload };
    default:
      return state;
  }
}
```

---

## 7) Performance Guidelines

### Prevent Unnecessary Re-renders
```typescript
// ALWAYS memoize expensive components
const ExpensiveComponent = memo(({ data, onAction }: Props): JSX.Element => {
  const processedData = useMemo(() => {
    return expensiveProcessing(data);
  }, [data]);

  return <div>{processedData.result}</div>;
});

// ALWAYS use useCallback for passed functions
function Parent(): JSX.Element {
  const [count, setCount] = useState(0);

  // BAD - New function every render
  const handleClick = () => setCount(c => c + 1);

  // GOOD - Stable function reference
  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []);

  return <Child onClick={handleClick} />;
}
```

### Memory Leak Prevention
```typescript
// CRITICAL: Always cleanup subscriptions
useEffect(() => {
  const subscription = eventEmitter.on('data', handleData);
  const timeoutId = setTimeout(doWork, 1000);
  const controller = new AbortController();

  // MANDATORY cleanup
  return () => {
    subscription.unsubscribe();
    clearTimeout(timeoutId);
    controller.abort();
  };
}, []);

// NEVER forget to remove event listeners
useEffect(() => {
  const handleResize = () => setWindowSize(window.innerWidth);

  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);
```

---

## 8) Development Workflow

### Tool Configuration

#### ESLint Config (.eslintrc.js)
```javascript
module.exports = {
  extends: [
    '@typescript-eslint/recommended',
    '@typescript-eslint/recommended-requiring-type-checking',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  rules: {
    // Enforce strict typing
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',

    // React safety
    'react-hooks/exhaustive-deps': 'error',
    'react/jsx-key': 'error',
    'react/no-array-index-key': 'error',

    // Security
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',

    // Prevent common mistakes
    'no-console': 'warn',
    'prefer-const': 'error',
    'no-var': 'error',
  },
};
```

### Pre-commit Checks (Required)
```bash
# Run the full gate before marking any task complete — it validates types,
# formatting, linting, Jest (with coverage thresholds), and Playwright e2e.
pnpm claude:pre-commit

# Faster inner-loop variants (see package.json for the full script list):
pnpm claude:quick-check   # types, format, lint, Jest — no Playwright
pnpm claude:test:jest     # Jest only
```

---

## 9) Common Anti-Patterns (Critical for Junior Engineers)

### Bad → Good Examples

1. **Don't use any** - Be explicit about types
```typescript
// BAD
function process(data: any): any {
  return data.value;
}

// GOOD
interface InputData {
  readonly value: string;
}
function process(data: InputData): string {
  return data.value;
}
```

2. **Don't mutate props/state** - Always immutable updates
```typescript
// BAD
function updateUser(user: User): User {
  user.lastModified = new Date(); // Mutation!
  return user;
}

// GOOD
function updateUser(user: User): User {
  return {
    ...user,
    lastModified: new Date(),
  };
}
```

3. **Don't use inline objects in JSX** - Breaks memoization
```typescript
// BAD - New object every render
<Component style={{ marginTop: 10 }} />

// GOOD - Stable reference
const componentStyle = { marginTop: 10 };
<Component style={componentStyle} />
```

4. **Don't forget error boundaries** - Always catch React errors
```typescript
// BAD - Unhandled errors crash app
function App() {
  return <UnstableComponent />;
}

// GOOD - Graceful error handling
function App() {
  return (
    <ErrorBoundary>
      <UnstableComponent />
    </ErrorBoundary>
  );
}
```

5. **Don't access DOM directly** - Use refs properly
```typescript
// BAD - Direct DOM manipulation
useEffect(() => {
  document.getElementById('input').focus();
}, []);

// GOOD - React refs
const inputRef = useRef<HTMLInputElement>(null);
useEffect(() => {
  inputRef.current?.focus();
}, []);
```

6. **Don't use useEffect for data transformation** - Use useMemo
```typescript
// BAD - Expensive operation every render
function Component({ items }: { items: Item[] }) {
  const [sortedItems, setSortedItems] = useState<Item[]>([]);

  useEffect(() => {
    setSortedItems(items.sort(...));
  }, [items]);

  return <List items={sortedItems} />;
}

// GOOD - Memoized computation
function Component({ items }: { items: Item[] }) {
  const sortedItems = useMemo(() => {
    return items.sort(...);
  }, [items]);

  return <List items={sortedItems} />;
}
```

---

## 10) Development Workflow

### Test-Driven Development (MANDATORY)
```bash
# REQUIRED workflow for EVERY feature:
1. Write failing test first
2. Run test to verify it fails
3. Write minimal code to pass
4. Run test to verify it passes
5. Refactor if needed
6. Run pnpm pre-commit before marking complete
```

### Pre-commit Validation
```bash
# MUST pass before ANY task is marked complete:
pnpm pre-commit
# This runs:
# - TypeScript type checking (no errors allowed)
# - ESLint (no warnings allowed)
# - Prettier formatting check
# - Jest tests (the coverage ratchet lives in jest.config.js)
```

---

## 11) Project Structure Requirements

### Mandatory Directory Layout
```
src/
├── main/                    # Electron main process
│   ├── index.ts            # Entry point ONLY - no business logic
│   ├── preload.ts          # Versioned API exposure
│   ├── services/           # Business logic modules
│   │   ├── config.ts       # Configuration service
│   │   ├── repository.ts   # Git operations service
│   │   └── window.ts       # Window management service
│   ├── ipc/                # IPC handlers
│   │   ├── handlers.ts     # Route registrations only
│   │   └── validators.ts   # Zod schemas for IPC
│   └── utils/              # Shared utilities
├── renderer/               # React application
│   ├── index.tsx          # Entry point only
│   ├── App.tsx            # Root component with ErrorBoundary
│   ├── components/        # Reusable components
│   ├── features/          # Feature modules
│   │   └── [feature]/
│   │       ├── components/
│   │       ├── hooks/
│   │       └── index.tsx
│   ├── contexts/          # React contexts (state management)
│   ├── hooks/             # Shared hooks
│   └── utils/             # Renderer utilities
├── shared/                # Shared between main/renderer
│   ├── types.ts           # TypeScript types
│   └── schemas.ts         # Zod validation schemas
└── types/                 # Global type definitions
    └── electron.d.ts      # Window.electronAPI types
```

### Service Layer Architecture
```typescript
// main/services/config.ts - Service pattern
export class ConfigService {
  private configPath: string;

  constructor() {
    // NEVER use process.cwd()
    this.configPath = path.join(app.getPath('userData'), 'config.yaml');
  }

  async load(): Promise<Config> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      return ConfigSchema.parse(yaml.load(raw));
    } catch (error) {
      // Return defaults with error logging
      logger.error('Config load failed:', error);
      return DEFAULT_CONFIG;
    }
  }
}

// main/index.ts - Dependency injection
const configService = new ConfigService();
const repoService = new RepositoryService(configService);

registerIpcHandlers({ configService, repoService });
```

### State Management Requirements
```typescript
// DO NOT use direct useState for app-wide state
// REQUIRED: Use Context or state management library from day 1

// contexts/AppContext.tsx
interface AppState {
  user: User | null;
  repository: Repository | null;
  theme: Theme;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  // Centralized state management
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <ErrorBoundary>
        {children}
      </ErrorBoundary>
    </AppContext.Provider>
  );
}
```

---

## 12) Common Failures to Avoid

### From Our Previous Implementation

#### 1. Config Path Security Vulnerability
```typescript
// ❌ FAILURE: Used process.cwd() for config
const CONFIG_FILE = path.join(process.cwd(), 'lore-config.yaml');
// PROBLEM: Attacker can change working directory to load malicious config

// ✅ CORRECT: Use app.getPath()
const CONFIG_FILE = path.join(app.getPath('userData'), 'lore-config.yaml');
```

#### 2. Missing IPC Validation
```typescript
// ❌ FAILURE: Direct data passing without validation
ipcMain.handle('config:get', async () => {
  return await loadConfig(); // No validation!
});

// ✅ CORRECT: Validate both input and output
ipcMain.handle('config:get', async (event) => {
  validateEventSource(event.sender);
  const config = await loadConfig();
  return ConfigSchema.parse(config); // Validate output
});
```

#### 3. No Error Boundaries
```typescript
// ❌ FAILURE: App crashes on any React error
function App() {
  return <MainComponent />;
}

// ✅ CORRECT: Wrap with error boundary
function App() {
  return (
    <ErrorBoundary fallback={<ErrorFallback />}>
      <MainComponent />
    </ErrorBoundary>
  );
}
```

#### 4. Silent Failures
```typescript
// ❌ FAILURE: Errors hidden from user
catch (error) {
  console.error(error);
  return DEFAULT_VALUE; // User never knows it failed!
}

// ✅ CORRECT: Inform user and provide recovery
catch (error) {
  logger.error('Operation failed:', error);
  showUserNotification({
    type: 'error',
    message: 'Failed to load configuration',
    action: { label: 'Retry', onClick: retry }
  });
  return DEFAULT_VALUE;
}
```

#### 5. Poor Test Coverage
```typescript
// ❌ FAILURE: Tests written after code
// Result: 59% coverage, failing tests

// ✅ CORRECT: TDD approach
// 1. Write test first:
it('validates config path for security', () => {
  expect(() => loadConfig('../../../etc/passwd')).toThrow();
});

// 2. Then write implementation:
function loadConfig(path: string) {
  if (path.includes('..')) throw new SecurityError('Path traversal');
  // ...
}
```

#### 6. Monolithic Main Process
```typescript
// ❌ FAILURE: Everything in main/index.ts
// 200+ lines of mixed concerns

// ✅ CORRECT: Modular services
// main/index.ts - 30 lines, just initialization
// main/services/*.ts - Focused services
// main/ipc/*.ts - IPC handling
```

---

## 13) Error Handling & Logging Standards

### Logging Architecture
The application uses **electron-log** for structured error logging:
- **Main Process**: Logs to `app.getPath('userData')/logs/main.log`
- **Renderer Process**: Uses `electron-log/renderer` import
- **Automatic Rotation**: 5MB max file size with cleanup
- **Structured Context**: All errors logged with operation context

### Required Error Handling Pattern
**EVERY error must be logged with context.** Use these consistent patterns:

#### Main Process (with Result Pattern)
```typescript
import log from 'electron-log/main';
import { success, failure } from './result-helpers';

try {
  const result = await someOperation();
  return success(result);
} catch (error) {
  log.error('Operation failed', {
    error,
    context: { userId, repositoryId, filePath },
    operation: 'operationName'
  });
  return failure(error);  // Result pattern preserved
}
```

#### Renderer Process (with Notifications)
```typescript
import log from 'electron-log/renderer';
import { notifications } from '@mantine/notifications';

// IPC calls return Result<T> and never throw — check `success`
const result = await window.electronAPI.someOperation();
if (!result.success) {
  log.error('Operation failed', {
    error: result.error,
    context: { repositoryName, branchName },
    operation: 'operationName'
  });
  notifications.show({
    title: 'Operation Failed',
    message: result.error,
    color: 'red'
  });
  return;
}
// Handle result.data...
```

#### Silent Operations (Previously Empty Catch Blocks)
```typescript
// ❌ NEVER do this - silent failures
try {
  await optionalOperation();
} catch {
  // Silent failure - debugging nightmare
}

// ✅ ALWAYS do this - log with context
try {
  await optionalOperation();
} catch (error) {
  log.error('Optional operation failed', {
    error,
    operation: 'operationName'
  });
  // Continue execution
}
```

### Error Context Requirements
**Always include relevant context in log statements:**
- **operation**: Name of the function/operation that failed
- **error**: The original error object (preserves full stack trace)
- **User data**: Repository info, paths, branch names, user IDs
- **System context**: Platform, file paths, network URLs, timestamps

### Lore SDK Error Handling
- **Pass through Lore SDK error messages** - they are already clear and user-friendly
- **Log full error context** for debugging while showing clean messages to users
- **Never suppress Lore SDK errors** - they contain vital troubleshooting information

### Complementary with Result Pattern
Error logging works alongside the existing `Result<T>` pattern:
- **Result pattern**: Clean error contracts for IPC communication
- **Error logging**: Detailed diagnostics for debugging and support
- **Both together**: Production-ready error handling with full traceability

### No Silent Failures Policy
**NEVER use empty catch blocks.** Every error must be logged or handled explicitly:
```typescript
// ❌ BAD - Silent failure
} catch {
  // Error ignored - impossible to debug
}

// ✅ GOOD - Logged failure
} catch (error) {
  log.error('Operation failed', { error, operation: 'functionName' });
  // Optional: continue execution or handle gracefully
}
```

---

## 14) Code Review Checklist

**Verify ALL items before considering code complete:**

- [ ] TypeScript strict mode passes with no errors
- [ ] All functions have explicit return types
- [ ] No usage of `any` type anywhere
- [ ] All external data validated with Zod schemas
- [ ] React components follow hooks rules (ESLint passes)
- [ ] All useEffect dependencies specified correctly
- [ ] Error boundaries wrap all route components
- [ ] IPC communications use structured error handling
- [ ] All errors logged with structured context (no silent failures)
- [ ] electron-log used consistently across main and renderer
- [ ] No direct DOM manipulation (use refs)
- [ ] All event listeners cleaned up in useEffect
- [ ] All async operations handle cancellation
- [ ] Tests focus on user behavior, not implementation
- [ ] Coverage meets the ratchet in `jest.config.js` (never lower it)
- [ ] E2E tests cover critical user journeys
- [ ] All tools pass: `pnpm pre-commit`