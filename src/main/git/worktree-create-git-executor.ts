import { createGitOperationExecutor } from './command-runner/git-operation-executor'
import { GIT_READ_TIMEOUT_MS } from './command-runner/git-command-timeout'

export const worktreeCreateGit = createGitOperationExecutor({
  admissionTier: 'interactive',
  queueTimeoutMs: GIT_READ_TIMEOUT_MS
})

export const worktreePreparationGit = createGitOperationExecutor({
  admissionTier: 'background',
  queueTimeoutMs: GIT_READ_TIMEOUT_MS
})
