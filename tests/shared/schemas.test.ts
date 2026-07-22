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
  WorkspaceSchema,
  WorkspaceBandSchema,
  WorkspaceAttentionSchema,
  AgentSessionStateSchema,
  AgentTaskSchema,
  AgentIntentionSchema,
  AgentObservabilityPushSchema,
  FileDiffResultSchema,
  CompareTargetSchema,
  MergeFileStateSchema,
  MergeStateSchema,
  ReviewWorkflowModeSchema,
  ReviewOpenRequestSchema,
  WorkspaceCardSchema,
  WorkspaceModelSnapshotSchema,
  WorkspaceProvisionRequestSchema,
  WorkspaceListRequestSchema,
  WorkspaceTeardownRequestSchema,
  WorkspaceTeardownResultSchema,
  WorkspaceMarkActiveRequestSchema,
  WorkspaceForgetRequestSchema,
  DiffRequestSchema,
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeAbortResponseSchema,
  MergeCompleteRequestSchema,
  MergeCompleteResponseSchema,
  LockEntrySchema,
  LockQueryRequestSchema,
  LockReleaseRequestSchema,
  LockReleaseResponseSchema,
  IPC_CHANNELS,
} from '../../src/shared/schemas';

const validRepository = {
  id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
  name: 'My Repo',
  url: 'lore.example.com/MyRepo',
  localPath: '/Users/dev/repos/my-repo',
  accentHue: 74,
  origin: 'attached',
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

  it.each([
    ['a slashed branch name (worktree)', 'test/WT1'],
    ['a slashed branch name with a nested prefix', 'agent/act2-balance'],
  ])('should accept %s', (_label, name) => {
    // When: parsing with a name containing a slash (a provisioned worktree
    // named for its branch)
    const result = RepositorySchema.safeParse({ ...validRepository, name });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject names with invalid characters', () => {
    // When: parsing with a name containing a disallowed character
    const result = RepositorySchema.safeParse({ ...validRepository, name: 'bad@name' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject an empty name', () => {
    // When: parsing with an empty name
    const result = RepositorySchema.safeParse({ ...validRepository, name: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a name that is only separators', () => {
    // When: parsing with a name made entirely of slashes
    const result = RepositorySchema.safeParse({ ...validRepository, name: '///' });

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

  it.each(['attached', 'cloned', 'provisioned'])('should accept the %s origin', origin => {
    // When: parsing with each valid workspace origin
    const result = RepositorySchema.safeParse({ ...validRepository, origin });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject an unknown origin', () => {
    // When: parsing with an origin outside the enum
    const result = RepositorySchema.safeParse({ ...validRepository, origin: 'imported' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a missing origin', () => {
    // Given: a repository object without the required origin field
    const { origin: _origin, ...withoutOrigin } = validRepository;

    // When: parsing it
    const result = RepositorySchema.safeParse(withoutOrigin);

    // Then: parsing fails (origin is required in the unified model)
    expect(result.success).toBe(false);
  });

  it('should accept a provisioned entry carrying branchName and provisionedAt', () => {
    // When: parsing a provisioned worktree entry
    const result = RepositorySchema.safeParse({
      ...validRepository,
      origin: 'provisioned',
      branchName: 'agent-x',
      provisionedAt: '2026-07-22T00:00:00.000Z',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should preserve a resolved loreRepositoryId', () => {
    // When: parsing an entry carrying the stable Lore repository id
    const result = RepositorySchema.safeParse({
      ...validRepository,
      loreRepositoryId: '019f6e08-1234-4abc-8def-0123456789ab',
    });

    // Then: parsing succeeds and keeps the id (grouping key survives url drift)
    expect(result.success).toBe(true);
    expect(result.success && result.data.loreRepositoryId).toBe(
      '019f6e08-1234-4abc-8def-0123456789ab'
    );
  });

  it('should accept an entry without a loreRepositoryId (optional)', () => {
    // When: parsing an entry that never resolved an id (offline attach)
    const result = RepositorySchema.safeParse(validRepository);

    // Then: parsing succeeds and the field is simply absent
    expect(result.success).toBe(true);
    expect(result.success && result.data.loreRepositoryId).toBeUndefined();
  });

  it('should reject an empty loreRepositoryId', () => {
    // When: parsing an entry with an empty-string id
    const result = RepositorySchema.safeParse({ ...validRepository, loreRepositoryId: '' });

    // Then: parsing fails (a stamped id is never blank)
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

  it('accepts a branchPushed notification carrying the pushing userId', () => {
    // When: parsing a push notification with the collaborator's userId
    const result = RepositoryNotificationSchema.safeParse({
      repositoryPath: '/repos/a',
      kind: 'branchPushed',
      userId: 'mara-voss',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('round-trips without userId (optional field omitted)', () => {
    // When: parsing a push notification without a userId
    const result = RepositoryNotificationSchema.safeParse({
      repositoryPath: '/repos/a',
      kind: 'branchPushed',
    });

    // Then: parsing succeeds and userId stays absent
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userId).toBeUndefined();
    }
  });

  it.each(['resourceLocked', 'resourceUnlocked'])(
    'accepts a %s notification with branch and paths',
    kind => {
      // When: parsing a lock notification carrying branch + paths
      const result = RepositoryNotificationSchema.safeParse({
        repositoryPath: '/repos/a',
        kind,
        userId: 'mara-voss',
        branch: 'feat/agent-1',
        paths: ['src/index.ts'],
      });

      // Then: parsing succeeds
      expect(result.success).toBe(true);
    }
  );

  it('accepts a lock notification with an empty paths array', () => {
    // When: parsing a lock notification with no locked paths
    const result = RepositoryNotificationSchema.safeParse({
      repositoryPath: '/repos/a',
      kind: 'resourceLocked',
      branch: 'feat/agent-1',
      paths: [],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an empty userId string', () => {
    // When: parsing a notification with a blank userId
    const result = RepositoryNotificationSchema.safeParse({
      repositoryPath: '/repos/a',
      kind: 'branchPushed',
      userId: '',
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
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

// ---------------------------------------------------------------------------
// Agentic development: workspaces, agent observability, diff/merge review,
// locks (P2 contracts consumed by later packets).
// ---------------------------------------------------------------------------

const validWorkspace = {
  instanceId: 'inst-1',
  path: '/repos/a/.lore-instances/inst-1',
  branchName: 'feat/agent-1',
  revision: 'a1b2c3',
  stale: false,
  repositoryId: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
};

describe('WorkspaceSchema', () => {
  it('accepts a workspace with all required fields', () => {
    // When: parsing a fully valid workspace
    const result = WorkspaceSchema.safeParse(validWorkspace);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a workspace with the optional provisionedAt populated', () => {
    // When: parsing with provisionedAt present
    const result = WorkspaceSchema.safeParse({
      ...validWorkspace,
      provisionedAt: '2026-07-19T00:00:00.000Z',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('round-trips without provisionedAt (optional field omitted)', () => {
    // When: parsing without provisionedAt
    const result = WorkspaceSchema.safeParse(validWorkspace);

    // Then: parsing succeeds and provisionedAt stays absent
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provisionedAt).toBeUndefined();
    }
  });

  it('accepts an empty revision hash (unknown/zero revision)', () => {
    // When: parsing with an empty revision
    const result = WorkspaceSchema.safeParse({ ...validWorkspace, revision: '' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid repositoryId', () => {
    // When: parsing with a malformed repositoryId
    const result = WorkspaceSchema.safeParse({ ...validWorkspace, repositoryId: 'not-a-uuid' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it.each(['instanceId', 'path', 'branchName', 'stale'])(
    'rejects a workspace missing %s',
    field => {
      // When: parsing without a required field
      const payload: Record<string, unknown> = { ...validWorkspace };
      delete payload[field];
      const result = WorkspaceSchema.safeParse(payload);

      // Then: parsing fails
      expect(result.success).toBe(false);
    }
  );
});

describe('WorkspaceBandSchema and WorkspaceAttentionSchema', () => {
  it.each(['awaitingReview', 'inProgress', 'idle'])('accepts the %s band', band => {
    // When: parsing each valid band
    const result = WorkspaceBandSchema.safeParse(band);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized band', () => {
    // When: parsing a band outside the three-state union
    const result = WorkspaceBandSchema.safeParse('blocked');

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts an attention shape with an empty reasons array', () => {
    // When: parsing an idle, unattended workspace
    const result = WorkspaceAttentionSchema.safeParse({
      band: 'idle',
      needsYou: false,
      reasons: [],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts every attention reason', () => {
    // When: parsing an attention shape carrying every known reason
    const result = WorkspaceAttentionSchema.safeParse({
      band: 'awaitingReview',
      needsYou: true,
      reasons: [
        'permissionPrompt',
        'idlePrompt',
        'reviewReady',
        'conflict',
        'diverged',
        'unpushed',
        'uncommitted',
      ],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unknown attention reason', () => {
    // When: parsing with a reason outside the defined set
    const result = WorkspaceAttentionSchema.safeParse({
      band: 'idle',
      needsYou: false,
      reasons: ['somethingElse'],
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('AgentSessionStateSchema', () => {
  const validState = {
    sessionId: 'sess-1',
    workspacePath: '/repos/a/.lore-instances/inst-1',
    status: 'active',
    lastEventAt: 1700000000000,
  };

  it.each(['active', 'waitingOnUser', 'stopped', 'ended'])('accepts the %s status', status => {
    // When: parsing each valid status
    const result = AgentSessionStateSchema.safeParse({ ...validState, status });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized status', () => {
    // When: parsing a status outside the four-state union
    const result = AgentSessionStateSchema.safeParse({ ...validState, status: 'paused' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a state with the optional costUsd populated', () => {
    // When: parsing with costUsd present
    const result = AgentSessionStateSchema.safeParse({ ...validState, costUsd: 1.23 });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('round-trips without costUsd (optional field omitted)', () => {
    // When: parsing without costUsd
    const result = AgentSessionStateSchema.safeParse(validState);

    // Then: parsing succeeds and costUsd stays absent
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costUsd).toBeUndefined();
    }
  });

  it('rejects a negative costUsd', () => {
    // When: parsing with a negative cost
    const result = AgentSessionStateSchema.safeParse({ ...validState, costUsd: -1 });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('AgentTaskSchema and AgentIntentionSchema', () => {
  it.each(['pending', 'running', 'done'])('accepts a task with %s status', status => {
    // When: parsing each valid task status
    const result = AgentTaskSchema.safeParse({ subject: 'Write tests', status });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a running task with runningElapsedMs', () => {
    // When: parsing a running task with an elapsed timer
    const result = AgentTaskSchema.safeParse({
      subject: 'Write tests',
      status: 'running',
      runningElapsedMs: 4200,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized task status', () => {
    // When: parsing a status outside the three-state union
    const result = AgentTaskSchema.safeParse({ subject: 'Write tests', status: 'blocked' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts an intention with only the required tasks/commentary arrays', () => {
    // When: parsing an intention with no optional fields populated
    const result = AgentIntentionSchema.safeParse({ tasks: [], commentary: [] });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a fully populated intention', () => {
    // When: parsing an intention with every field present
    const result = AgentIntentionSchema.safeParse({
      prompt: 'Add validation to the form',
      title: 'Form validation',
      tasks: [{ subject: 'Write tests', status: 'done' }],
      commentary: [{ at: 1700000000000, text: 'Starting with the failing test.' }],
      summary: 'Added Zod validation and tests.',
      sessionId: 'sess-1',
      costUsd: 0.42,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an intention missing the tasks array', () => {
    // When: parsing without the required tasks field
    const result = AgentIntentionSchema.safeParse({ commentary: [] });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('AgentObservabilityPushSchema', () => {
  it('accepts a sessionState push', () => {
    // When: parsing a session-state update
    const result = AgentObservabilityPushSchema.safeParse({
      kind: 'sessionState',
      state: {
        sessionId: 'sess-1',
        workspacePath: '/repos/a/.lore-instances/inst-1',
        status: 'active',
        lastEventAt: 1700000000000,
      },
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts an intention push', () => {
    // When: parsing an intention update
    const result = AgentObservabilityPushSchema.safeParse({
      kind: 'intention',
      workspacePath: '/repos/a/.lore-instances/inst-1',
      intention: { tasks: [], commentary: [] },
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized push kind', () => {
    // When: parsing a push payload with an unknown discriminant
    const result = AgentObservabilityPushSchema.safeParse({ kind: 'other' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('FileDiffResultSchema', () => {
  const base = { path: 'src/index.ts', binary: false, truncated: false };

  it.each(['added', 'modified', 'deleted', 'moved'])('accepts the %s action', action => {
    // When: parsing each valid diff action
    const result = FileDiffResultSchema.safeParse({ ...base, action });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized action', () => {
    // When: parsing an action outside the defined set
    const result = FileDiffResultSchema.safeParse({ ...base, action: 'renamed' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a modified file with a patch and lineStats', () => {
    // When: parsing a full text-diff result
    const result = FileDiffResultSchema.safeParse({
      ...base,
      action: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new',
      lineStats: { added: 1, removed: 1 },
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('round-trips a binary file without patch or lineStats', () => {
    // When: parsing a binary diff result with the optional fields omitted
    const result = FileDiffResultSchema.safeParse({
      path: 'assets/logo.png',
      action: 'added',
      binary: true,
      truncated: false,
    });

    // Then: parsing succeeds and the optional fields stay absent
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patch).toBeUndefined();
      expect(result.data.lineStats).toBeUndefined();
    }
  });

  it('rejects negative lineStats', () => {
    // When: parsing with a negative removed count
    const result = FileDiffResultSchema.safeParse({
      ...base,
      action: 'modified',
      lineStats: { added: 1, removed: -1 },
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('CompareTargetSchema', () => {
  it('accepts a revision target', () => {
    // When: parsing a revision compare target
    const result = CompareTargetSchema.safeParse({ kind: 'revision', revision: 'a1b2c3' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a workingTree target with no extra fields', () => {
    // When: parsing the working-tree compare target
    const result = CompareTargetSchema.safeParse({ kind: 'workingTree' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a branchHead target', () => {
    // When: parsing a branch-head compare target
    const result = CompareTargetSchema.safeParse({ kind: 'branchHead', branch: 'main' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a revision target missing the revision field', () => {
    // When: parsing a revision target without a revision
    const result = CompareTargetSchema.safeParse({ kind: 'revision' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized kind', () => {
    // When: parsing a compare target with an unknown discriminant
    const result = CompareTargetSchema.safeParse({ kind: 'staged' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('MergeFileStateSchema and MergeStateSchema', () => {
  it('accepts a merged file with no resolution', () => {
    // When: parsing an auto-merged file (needs no action)
    const result = MergeFileStateSchema.safeParse({ path: 'src/index.ts', state: 'merged' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it.each(['mine', 'theirs'])('accepts a conflict file resolved as %s', resolution => {
    // When: parsing a resolved conflict file
    const result = MergeFileStateSchema.safeParse({
      path: 'src/index.ts',
      state: 'conflict',
      resolution,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized file state', () => {
    // When: parsing a state outside the merged/conflict union
    const result = MergeFileStateSchema.safeParse({ path: 'src/index.ts', state: 'pending' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a merge state with an empty files array (clean merge)', () => {
    // When: parsing a merge with nothing to reconcile
    const result = MergeStateSchema.safeParse({
      sourceBranch: 'feat/agent-1',
      targetBranch: 'main',
      files: [],
      allResolved: true,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a merge state with a mix of merged and conflicted files', () => {
    // When: parsing a merge with one auto-merged and one unresolved file
    const result = MergeStateSchema.safeParse({
      sourceBranch: 'feat/agent-1',
      targetBranch: 'main',
      files: [
        { path: 'src/a.ts', state: 'merged' },
        { path: 'src/b.ts', state: 'conflict' },
      ],
      allResolved: false,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });
});

describe('ReviewWorkflowModeSchema', () => {
  it.each(['commit', 'merge'])('accepts the %s workflow mode', mode => {
    // When: parsing each valid workflow mode
    const result = ReviewWorkflowModeSchema.safeParse(mode);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized workflow mode', () => {
    // When: parsing a mode outside the commit/merge union
    const result = ReviewWorkflowModeSchema.safeParse('review');

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('ReviewOpenRequestSchema', () => {
  const repositoryId = '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b';
  const valid = {
    workspacePath: '/wt/act2-balance',
    repositoryId,
    branchName: 'agent/act2-balance',
    revision: 'r128',
    workflow: 'commit' as const,
    compare: {
      source: { kind: 'revision' as const, revision: 'r128' },
      target: { kind: 'workingTree' as const },
    },
    title: 'Balance pass on Act II encounters',
  };

  it('accepts a fully-specified commit open request', () => {
    // When: parsing a request carrying workspace, workflow, and compare picker
    const result = ReviewOpenRequestSchema.safeParse(valid);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a request without the optional title', () => {
    // Given: a request omitting the human title
    const { title: _title, ...withoutTitle } = valid;

    // When/Then: parsing still succeeds
    expect(ReviewOpenRequestSchema.safeParse(withoutTitle).success).toBe(true);
  });

  it('rejects a request with an empty workspace path', () => {
    // When: parsing a request whose workspace path is empty
    const result = ReviewOpenRequestSchema.safeParse({ ...valid, workspacePath: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('rejects a request with an unrecognized workflow', () => {
    // When: parsing a request whose workflow is outside commit/merge
    const result = ReviewOpenRequestSchema.safeParse({ ...valid, workflow: 'review' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('rejects a request whose compare target is malformed', () => {
    // When: parsing a request whose compare target lacks its discriminant
    const result = ReviewOpenRequestSchema.safeParse({
      ...valid,
      compare: { source: { kind: 'revision', revision: 'r1' }, target: { kind: 'nope' } },
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('Workspace IPC request/response schemas', () => {
  const repositoryId = '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b';

  it('accepts a valid provision request', () => {
    // When: parsing a provision request
    const result = WorkspaceProvisionRequestSchema.safeParse({
      repositoryId,
      branchName: 'feat/agent-1',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a provision request with an empty branch name', () => {
    // When: parsing a provision request with a blank branch name
    const result = WorkspaceProvisionRequestSchema.safeParse({ repositoryId, branchName: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a valid list request', () => {
    // When: parsing a workspace list request
    const result = WorkspaceListRequestSchema.safeParse({ repositoryId });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a teardown request identified by workspaceId', () => {
    // When: parsing a teardown request keyed by workspaceId
    const result = WorkspaceTeardownRequestSchema.safeParse({
      workspaceId: 'inst-1',
      force: false,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a teardown request identified by path', () => {
    // When: parsing a teardown request keyed by worktree path
    const result = WorkspaceTeardownRequestSchema.safeParse({
      path: '/repos/a/.lore-instances/inst-1',
      force: true,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a teardown request with neither workspaceId nor path', () => {
    // When: parsing a teardown request with no identifier
    const result = WorkspaceTeardownRequestSchema.safeParse({ force: true });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a teardown result carrying what was removed', () => {
    // When: parsing a full-cleanup teardown result
    const result = WorkspaceTeardownResultSchema.safeParse({
      workspaceId: 'inst-1',
      path: '/repos/a/.lore-instances/inst-1',
      directoryRemoved: true,
      localBranchRemoved: true,
      remoteBranchRemoved: false,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a valid markActive request', () => {
    // When: parsing a mark-active request
    const result = WorkspaceMarkActiveRequestSchema.safeParse({ workspaceId: 'inst-1' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a markActive request with an empty workspaceId', () => {
    // When: parsing a mark-active request with a blank id
    const result = WorkspaceMarkActiveRequestSchema.safeParse({ workspaceId: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a forget request identified by workspaceId', () => {
    // When: parsing a forget request keyed by workspaceId
    const result = WorkspaceForgetRequestSchema.safeParse({ workspaceId: 'inst-1' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a forget request identified by path', () => {
    // When: parsing a forget request keyed by worktree path
    const result = WorkspaceForgetRequestSchema.safeParse({
      path: '/repos/a/.lore-instances/inst-1',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a forget request with neither workspaceId nor path', () => {
    // When: parsing a forget request with no identifier
    const result = WorkspaceForgetRequestSchema.safeParse({});

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('WorkspaceModelSnapshotSchema', () => {
  const validCard = {
    workspace: {
      instanceId: 'inst-1',
      path: '/repos/myrepo-wt/agent-x',
      branchName: 'agent-x',
      revision: 'r1',
      stale: false,
      repositoryId: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
    },
    attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
    isActive: false,
    fileStats: { added: 5, removed: 2 },
    changedFileCount: 3,
    sessionCommits: [{ revision: 'c1', revisionNumber: 2 }],
    lastEventAt: 1000,
  };

  it('accepts a card with the required derived fields (session/intention optional)', () => {
    // When: parsing a minimal card
    const result = WorkspaceCardSchema.safeParse(validCard);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a card missing isActive (packet U3: marks the anchor workspace)', () => {
    // When: parsing a card without the isActive marker
    const { isActive: _isActive, ...withoutIsActive } = validCard;
    const result = WorkspaceCardSchema.safeParse(withoutIsActive);

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a per-repository snapshot of cards', () => {
    // When: parsing a snapshot
    const result = WorkspaceModelSnapshotSchema.safeParse({
      repositoryId: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      cards: [validCard],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a card with negative line stats', () => {
    // When: parsing a card whose stats are negative
    const result = WorkspaceCardSchema.safeParse({
      ...validCard,
      fileStats: { added: -1, removed: 0 },
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('DiffRequestSchema', () => {
  it('accepts a compare-target based diff request without explicit paths', () => {
    // When: parsing a whole-tree diff request
    const result = DiffRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      source: { kind: 'branchHead', branch: 'main' },
      target: { kind: 'workingTree' },
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a diff request scoped to specific paths', () => {
    // When: parsing a diff request limited to given paths
    const result = DiffRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      source: { kind: 'revision', revision: 'a1b2c3' },
      target: { kind: 'revision', revision: 'd4e5f6' },
      paths: ['src/index.ts'],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a diff request with an invalid target', () => {
    // When: parsing a diff request with a malformed compare target
    const result = DiffRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      source: { kind: 'workingTree' },
      target: { kind: 'revision' },
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('Merge IPC request/response schemas', () => {
  it('accepts a merge start request', () => {
    // When: parsing a merge-start request
    const result = MergeStartRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      sourceBranch: 'feat/agent-1',
      targetBranch: 'main',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it.each(['mine', 'theirs'])('accepts a merge resolve request choosing %s', resolution => {
    // When: parsing a merge-resolve request
    const result = MergeResolveRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      path: 'src/index.ts',
      resolution,
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a merge resolve request with an unrecognized resolution', () => {
    // When: parsing a merge-resolve request with an invalid resolution
    const result = MergeResolveRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      path: 'src/index.ts',
      resolution: 'ours',
    });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a merge abort request and response', () => {
    // When: parsing a merge-abort request and its response
    const requestResult = MergeAbortRequestSchema.safeParse({ repositoryPath: '/repos/a' });
    const responseResult = MergeAbortResponseSchema.safeParse({ aborted: true });

    // Then: both parse successfully
    expect(requestResult.success).toBe(true);
    expect(responseResult.success).toBe(true);
  });

  it('accepts a merge complete request and response', () => {
    // When: parsing a merge-complete request and its response
    const requestResult = MergeCompleteRequestSchema.safeParse({ repositoryPath: '/repos/a' });
    const responseResult = MergeCompleteResponseSchema.safeParse({ revision: 'a1b2c3' });

    // Then: both parse successfully
    expect(requestResult.success).toBe(true);
    expect(responseResult.success).toBe(true);
  });

  it('rejects a merge complete response with an empty revision', () => {
    // When: parsing a merge-complete response with a blank revision
    const result = MergeCompleteResponseSchema.safeParse({ revision: '' });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});

describe('Lock IPC request/response schemas', () => {
  it('accepts a lock entry', () => {
    // When: parsing a single lock entry
    const result = LockEntrySchema.safeParse({
      path: 'src/index.ts',
      userId: 'mara-voss',
      branch: 'feat/agent-1',
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a lock query request scoped to specific paths', () => {
    // When: parsing a lock query request with explicit paths
    const result = LockQueryRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      paths: ['src/index.ts'],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a lock query request with no paths (query all)', () => {
    // When: parsing a lock query request without paths
    const result = LockQueryRequestSchema.safeParse({ repositoryPath: '/repos/a' });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('accepts a lock release request', () => {
    // When: parsing a lock release request
    const result = LockReleaseRequestSchema.safeParse({
      repositoryPath: '/repos/a',
      paths: ['src/index.ts'],
    });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('rejects a lock release request with an empty paths array', () => {
    // When: parsing a lock release request with nothing to release
    const result = LockReleaseRequestSchema.safeParse({ repositoryPath: '/repos/a', paths: [] });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('accepts a lock release response', () => {
    // When: parsing a lock release response
    const result = LockReleaseResponseSchema.safeParse({ released: ['src/index.ts'] });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });
});

describe('IPC_CHANNELS', () => {
  it('declares a unique channel name for every workspace/diff/merge/lock/agent operation', () => {
    // When: flattening every declared channel name
    const names = [
      ...Object.values(IPC_CHANNELS.workspace),
      ...Object.values(IPC_CHANNELS.diff),
      ...Object.values(IPC_CHANNELS.merge),
      ...Object.values(IPC_CHANNELS.locks),
      ...Object.values(IPC_CHANNELS.agent),
      ...Object.values(IPC_CHANNELS.review),
    ];

    // Then: every name is a non-empty string and no two collide
    expect(names.every(name => typeof name === 'string' && name.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares a manual refresh channel that mirrors the watch/snapshot naming and stays unique', () => {
    // Given: the full workspaceModel channel group (watch/snapshot/refresh)
    // When: reading the manual refresh channel name
    // Then: it is colon-namespaced under workspace:model like its siblings,
    // and collides with none of them
    expect(IPC_CHANNELS.workspaceModel.refresh).toBe('workspace:model:refresh');
    const names = Object.values(IPC_CHANNELS.workspaceModel);
    expect(new Set(names).size).toBe(names.length);
  });
});
