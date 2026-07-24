/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/tests/integration/',
  ],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    // uuid v14+ is ESM-only; see tests/mocks/uuidMock.js
    '^uuid$': '<rootDir>/tests/mocks/uuidMock.js',
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/mocks/styleMock.js',
    '\\.(png|jpg|jpeg|gif|svg)$': '<rootDir>/tests/mocks/fileMock.js',
    '^/assets/(.*)$': '<rootDir>/assets/$1',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // Electron bootstrap and contextBridge passthrough are exercised by the
    // Playwright e2e suite, not Jest
    '!src/main/index.ts',
    '!src/main/preload.ts',
    '!src/renderer/index.tsx',
  ],
  coverageReporters: ['text-summary', 'lcov', 'html'],
  // Don't bail - run all tests to see full state
  bail: false,
  // Clear mocks between tests (prevents weird failures)
  clearMocks: true,
  restoreMocks: true,
  // Enforced ratchet: set just below current coverage so regressions fail.
  // Raise these as coverage improves; the long-term target is 90%.
  // Note: files matched by a path-specific threshold below are excluded from
  // the "global" bucket, so "global" covers the IPC + renderer remainder.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 76,
      functions: 85,
      lines: 85,
    },
    'src/main/services/': {
      statements: 93,
      branches: 84,
      functions: 93,
      lines: 93,
    },
    'src/shared/': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  testEnvironmentOptions: {
    customExportConditions: [''],
  },
};