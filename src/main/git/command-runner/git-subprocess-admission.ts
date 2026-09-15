import { GitAdmissionScheduler } from './git-admission-scheduler'
import type { GitAdmissionGrant, GitAdmissionRequest } from './git-admission-state'
import { GitCommandTimeoutError, gitCommandTimeoutMs } from './git-command-timeout'
import { currentGitOperationPolicy, resolveGitAdmissionTier } from './git-operation-executor'

export { GitAdmissionScheduler } from './git-admission-scheduler'
export type {
  GitAdmissionEvent,
  GitAdmissionGrant,
  GitAdmissionRequest
} from './git-admission-state'
export {
  GENERAL_CAP,
  GENERAL_HEADROOM,
  GIT_ADMISSION_AGING_MS,
  MAX_GIT_CHILDREN,
  NETWORK_CAP,
  NETWORK_HEADROOM,
  ROUTE_CAP,
  ROUTE_HEADROOM
} from './git-admission-state'

let scheduler = new GitAdmissionScheduler()

export async function acquireGitAdmission(
  request: GitAdmissionRequest
): Promise<GitAdmissionGrant> {
  if (process.env.ORCA_GIT_ADMISSION_DISABLED === '1') {
    return { queueWaitMs: 0, release: () => {} }
  }
  const tier = resolveGitAdmissionTier(request.tier)
  const timeoutMs =
    gitCommandTimeoutMs(request.args, request.timeoutMs) ??
    currentGitOperationPolicy()?.queueTimeoutMs
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return scheduler.acquire({ ...request, tier })
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = request.signal
    ? AbortSignal.any([request.signal, deadline.signal])
    : deadline.signal
  try {
    return await scheduler.acquire({ ...request, tier, signal })
  } catch (error) {
    throw deadline.signal.aborted && !request.signal?.aborted
      ? new GitCommandTimeoutError(timeoutMs)
      : error
  } finally {
    clearTimeout(timer)
  }
}

export function _resetGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export function _gitAdmissionSnapshotForTests(): ReturnType<GitAdmissionScheduler['snapshot']> {
  return scheduler.snapshot()
}
