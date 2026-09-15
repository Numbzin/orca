import { AsyncLocalStorage } from 'node:async_hooks'
import type { GitAdmissionTier } from './git-exec-options'

type GitOperationPolicy = {
  admissionTier: GitAdmissionTier
  queueTimeoutMs: number
}

const operations = new AsyncLocalStorage<{ policy: GitOperationPolicy; active: boolean }>()

/** Async context keeps concurrent operations isolated without forwarding policy through routing options. */
export function createGitOperationExecutor(policy: GitOperationPolicy) {
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const scope = { policy, active: true }
      return operations.run(scope, async () => {
        try {
          return await operation()
        } finally {
          // Timers and detached work must not retain a completed create's priority.
          scope.active = false
        }
      })
    }
  }
}

export function currentGitOperationPolicy(): Readonly<GitOperationPolicy> | undefined {
  const scope = operations.getStore()
  return scope?.active ? scope.policy : undefined
}

export function resolveGitAdmissionTier(tier?: GitAdmissionTier): GitAdmissionTier {
  return tier ?? currentGitOperationPolicy()?.admissionTier ?? 'status'
}
