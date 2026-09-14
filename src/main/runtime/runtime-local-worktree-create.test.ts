import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  rearm: vi.fn(),
  resolveShared: vi.fn<() => Promise<string[]>>(),
  resolveInclude: vi.fn<() => Promise<string[]>>(),
  copyPaths: vi.fn<() => Promise<string[]>>(),
  created: {
    path: '/worktrees/app',
    head: 'abc123',
    branch: 'app',
    isBare: false,
    isMainWorktree: false
  }
}))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({ cwd: '/repo' }),
  getLocalProjectWorktreeGitOptions: () => ({}),
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('../git/repo', () => ({
  getBaseRefDefault: async () => 'main',
  resolveDefaultBaseRefWithLocalGit: async () => 'main'
}))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: async () => '' }))
vi.mock('../git/worktree-base-ref-probe', () => ({ hasLocalWorktreeBaseRef: async () => true }))
vi.mock('./runtime-local-worktree-create-candidate', () => ({
  resolveRuntimeLocalWorktreeCreateCandidate: async () => ({
    branchName: 'app',
    worktreePath: mocks.created.path,
    effectiveRequestedName: 'app',
    effectiveSanitizedName: 'app',
    checkoutExistingBranch: false
  })
}))
vi.mock('../worktree-create-preparation', () => ({
  consumePreparedWorktreeCreate: async () => ({
    status: 'hit',
    result: {},
    rearm: mocks.rearm
  })
}))
vi.mock('../git/worktree', () => ({ addWorktree: vi.fn(), addSparseWorktree: vi.fn() }))
vi.mock('../ipc/worktree-remote', () => ({ configureCreatedWorktreePushTarget: vi.fn() }))
vi.mock('../ipc/created-worktree-reconciliation', () => ({
  resolveCreatedWorktree: async () => ({ created: mocks.created })
}))
vi.mock('../worktree-name-retirement', () => ({
  failedWorktreeCreationNeedsRetirement: vi.fn(),
  retireGeneratedWorktreeName: vi.fn()
}))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveShared
}))
vi.mock('../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveInclude
}))
vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.copyPaths,
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn()
}))

import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'

function createWorktree() {
  const store = {
    getSettings: () => ({
      workspaceDir: '/worktrees',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false
    }),
    setWorktreeMeta: (_id: string, updates: object) => updates
  }
  return createRuntimeLocalManagedWorktree({
    request: { repoSelector: 'repo-1', name: 'app', baseBranch: 'main' },
    repo: { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '#000000', addedAt: 0 },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All store methods reached by this isolated create path are supplied above.
    store: store as Store,
    createdWithAgent: undefined,
    resolveRemoteTrackingBase: async () => null,
    hasRemoteTrackingRef: async () => false,
    refreshRemoteTrackingBase: async () => ({ ok: true }),
    fetchRemote: async () => {},
    onWorktreeMetadataPersisted: () => undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveShared.mockResolvedValue([])
  mocks.resolveInclude.mockResolvedValue(['.env'])
  mocks.copyPaths.mockResolvedValue([])
})

describe('runtime prepared-worktree replenishment', () => {
  it('waits for materialization probes and include copies before starting another checkout', async () => {
    let finishProbe!: (paths: string[]) => void
    mocks.resolveShared.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishProbe = resolve
        })
    )
    let finishCopy!: (paths: string[]) => void
    mocks.copyPaths.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishCopy = resolve
        })
    )
    const creation = createWorktree()
    await vi.waitFor(() => expect(mocks.resolveShared).toHaveBeenCalledOnce())
    expect(mocks.rearm).not.toHaveBeenCalled()
    finishProbe([])
    await vi.waitFor(() => expect(mocks.copyPaths).toHaveBeenCalledOnce())
    expect(mocks.rearm).not.toHaveBeenCalled()
    finishCopy([])
    await creation
    expect(mocks.rearm).toHaveBeenCalledOnce()
  })

  it('leaves replenishment to a later prefetch when materialization fails', async () => {
    mocks.copyPaths.mockRejectedValue(new Error('copy failed'))
    await expect(createWorktree()).rejects.toThrow('copy failed')
    expect(mocks.rearm).not.toHaveBeenCalled()
  })
})
