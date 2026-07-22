import { RepositorySchema } from '../../src/shared/schemas';
import type { Repository } from '../../src/shared/types';

// Canonical Repository test fixture. Every produced value is parsed against
// RepositorySchema, so test data can never drift from the production shape
// (overrides that would not validate fail the test immediately).
export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return RepositorySchema.parse({
    id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
    name: 'MyRepo',
    url: 'lore.example.com/MyRepo',
    localPath: '/tmp/my-repo',
    accentHue: 74,
    origin: 'attached',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  });
}
