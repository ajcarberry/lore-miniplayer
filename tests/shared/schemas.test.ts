import {
  RepositorySchema,
  RepositoryCreateInputSchema,
  RepositoryUpdateInputSchema,
  LoreBranchSchema,
  LoreRepositoryStatusSchema,
  LoreSyncOptionsSchema,
  BranchDivergenceSchema,
  RevisionSummarySchema,
  RepositoryNotificationSchema,
  CloneProgressSchema,
} from '../../src/shared/schemas';

const validRepository = {
  id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
  name: 'My Repo',
  url: 'lore.example.com/MyRepo',
  localPath: '/Users/dev/repos/my-repo',
  accentHue: 74,
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('RepositorySchema', () => {
  it('should accept a valid repository', () => {
    // When: parsing a fully valid repository
    const result = RepositorySchema.safeParse(validRepository);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it.each([
    ['Lore server path', 'lore.example.com/Some/Repo'],
    ['lore scheme (plaintext local server)', 'lore://127.0.0.1:41337/MyRepo'],
    ['lores scheme (TLS)', 'lores://lore.example.com/MyRepo'],
    ['local placeholder', 'local://existing'],
  ])('should accept a %s URL', (_label, url) => {
    // When: parsing with the given URL form
    const result = RepositorySchema.safeParse({ ...validRepository, url });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it.each([
    ['ftp scheme', 'ftp://127.0.0.1:41337/MyRepo'],
    ['unknown scheme', 'foo://lore.example.com/MyRepo'],
    ['https git URL', 'https://github.com/org/repo.git'],
    ['ssh git URL', 'git@github.com:org/repo.git'],
  ])('should reject an unsupported %s URL', (_label, url) => {
    // When: parsing with an unsupported scheme URL
    const result = RepositorySchema.safeParse({ ...validRepository, url });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a URL that matches no supported form', () => {
    // When: parsing with a bare word URL
    const result = RepositorySchema.safeParse({ ...validRepository, url: 'not a url' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject names with invalid characters', () => {
    // When: parsing with a name containing a slash
    const result = RepositorySchema.safeParse({ ...validRepository, name: 'bad/name' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject an empty name', () => {
    // When: parsing with an empty name
    const result = RepositorySchema.safeParse({ ...validRepository, name: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject path traversal in localPath', () => {
    // When: parsing with a traversal path
    const result = RepositorySchema.safeParse({
      ...validRepository,
      localPath: '/Users/dev/../../etc',
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject relative local paths', () => {
    // When: parsing with a relative path
    const result = RepositorySchema.safeParse({ ...validRepository, localPath: 'repos/my-repo' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should accept Windows drive-letter paths', () => {
    // When: parsing with a Windows-style absolute path
    const result = RepositorySchema.safeParse({
      ...validRepository,
      localPath: 'C:\\repos\\my-repo',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it.each([172, 296, 38])('should accept the named accent hue %i', hue => {
    // When: parsing with each defined accent hue
    const result = RepositorySchema.safeParse({ ...validRepository, accentHue: hue });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject an accentHue outside the defined set', () => {
    // When: parsing with a hue that is not one of the four accents
    const result = RepositorySchema.safeParse({ ...validRepository, accentHue: 999 });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('RepositoryCreateInputSchema', () => {
  it('should accept valid create input', () => {
    // When: parsing name/url/localPath only
    const result = RepositoryCreateInputSchema.safeParse({
      name: 'New Repo',
      url: 'lore.example.com/NewRepo',
      localPath: '/tmp/new-repo',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject missing fields', () => {
    // When: parsing without a localPath
    const result = RepositoryCreateInputSchema.safeParse({
      name: 'New Repo',
      url: 'lore.example.com/NewRepo',
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('RepositoryUpdateInputSchema', () => {
  it('should accept a partial update with only the id', () => {
    // When: parsing an update carrying just the id
    const result = RepositoryUpdateInputSchema.safeParse({ id: validRepository.id });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject a non-uuid id', () => {
    // When: parsing with a malformed id
    const result = RepositoryUpdateInputSchema.safeParse({ id: 'not-a-uuid', name: 'x' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should accept a valid accentHue update', () => {
    // When: parsing an update carrying a defined accent hue
    const result = RepositoryUpdateInputSchema.safeParse({
      id: validRepository.id,
      accentHue: 296,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject an invalid accentHue update', () => {
    // When: parsing an update carrying a hue outside the defined set
    const result = RepositoryUpdateInputSchema.safeParse({
      id: validRepository.id,
      accentHue: 999,
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('Lore schemas', () => {
  it('should validate a branch entry', () => {
    // When: parsing a branch shape
    const result = LoreBranchSchema.safeParse({ name: 'main', isDefault: true, isCurrent: true });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject a branch entry with missing flags', () => {
    // When: parsing without isCurrent
    const result = LoreBranchSchema.safeParse({ name: 'main', isDefault: true });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should validate a repository status shape', () => {
    // When: parsing a status result
    const result = LoreRepositoryStatusSchema.safeParse({ exists: true, isLoreRepo: false });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });
});

describe('LoreSyncOptionsSchema', () => {
  it('should strip unrecognized keys and keep the known options', () => {
    // When: parsing options with an unknown key mixed in
    const result = LoreSyncOptionsSchema.parse({
      revision: 'abc123',
      reset: true,
      bogus: 'ignored',
    });

    // Then: only the recognized options survive
    expect(result).toEqual({ revision: 'abc123', reset: true });
  });

  it('should reject a wrongly typed option', () => {
    // When: parsing a numeric revision
    const result = LoreSyncOptionsSchema.safeParse({ revision: 42 });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('BranchDivergenceSchema', () => {
  it.each(['inSync', 'ahead', 'behindOrDiverged', 'unknown'])(
    'should accept the %s state',
    state => {
      // When: parsing a divergence shape with each valid state
      const result = BranchDivergenceSchema.safeParse({
        state,
        latest: 'abc123',
        latestRemote: 'def456',
      });

      // Then: parsing succeeds
      expect(result.success).toBe(true);
    }
  );

  it('should reject an unrecognized state', () => {
    // When: parsing with a state outside the four-state union
    const result = BranchDivergenceSchema.safeParse({
      state: 'diverged',
      latest: 'abc123',
      latestRemote: 'def456',
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a shape missing the hash fields', () => {
    // When: parsing without latestRemote
    const result = BranchDivergenceSchema.safeParse({ state: 'unknown', latest: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('RevisionSummarySchema', () => {
  it('should accept a summary with only the required fields', () => {
    // When: parsing without the optional enrichment fields
    const result = RevisionSummarySchema.safeParse({
      revision: 'a1b2c3',
      revisionNumber: 42,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should accept a summary with the optional enrichment fields populated', () => {
    // When: parsing with message/timestamp present
    const result = RevisionSummarySchema.safeParse({
      revision: 'a1b2c3',
      revisionNumber: 42,
      message: 'Fix the thing',
      timestamp: 1700000000,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject a shape missing revisionNumber', () => {
    // When: parsing without revisionNumber
    const result = RevisionSummarySchema.safeParse({ revision: 'a1b2c3' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a non-numeric revisionNumber', () => {
    // When: parsing with revisionNumber as a string
    const result = RevisionSummarySchema.safeParse({ revision: 'a1b2c3', revisionNumber: '42' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('RepositoryNotificationSchema', () => {
  it('accepts every notification kind with a repository path', () => {
    // When: parsing payloads for each push-notification kind
    for (const kind of ['branchPushed', 'branchCreated', 'branchDeleted']) {
      const result = RepositoryNotificationSchema.safeParse({
        repositoryPath: '/repos/a',
        kind,
      });

      // Then: parsing succeeds
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown kinds and missing or empty paths', () => {
    // When/Then: malformed payloads are rejected
    expect(
      RepositoryNotificationSchema.safeParse({ repositoryPath: '/repos/a', kind: 'other' }).success
    ).toBe(false);
    expect(RepositoryNotificationSchema.safeParse({ kind: 'branchPushed' }).success).toBe(false);
    expect(
      RepositoryNotificationSchema.safeParse({ repositoryPath: '', kind: 'branchPushed' }).success
    ).toBe(false);
  });
});

describe('CloneProgressSchema', () => {
  it('accepts a destination path with an in-range percent', () => {
    // When: parsing progress payloads at the range edges
    for (const percent of [0, 42, 100]) {
      const result = CloneProgressSchema.safeParse({ localPath: '/repos/a', percent });

      // Then: parsing succeeds
      expect(result.success).toBe(true);
    }
  });

  it('rejects out-of-range percents and missing or empty paths', () => {
    // When/Then: malformed payloads are rejected
    expect(CloneProgressSchema.safeParse({ localPath: '/repos/a', percent: -1 }).success).toBe(
      false
    );
    expect(CloneProgressSchema.safeParse({ localPath: '/repos/a', percent: 101 }).success).toBe(
      false
    );
    expect(CloneProgressSchema.safeParse({ percent: 50 }).success).toBe(false);
    expect(CloneProgressSchema.safeParse({ localPath: '', percent: 50 }).success).toBe(false);
  });
});
