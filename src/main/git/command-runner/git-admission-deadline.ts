import { GitCommandTimeoutError } from './git-command-timeout'
import {
  acquireGitAdmission,
  type GitAdmissionGrant,
  type GitAdmissionRequest
} from './git-subprocess-admission'

/**
 * Admission wait bounded by the command's own timeout.
 *
 * Why: the timeout used to arm only once the child spawned, so a command with a 1s deadline could
 * sit in a saturated queue for tens of seconds with nothing to stop it. The child still gets its
 * full budget after admission — the worst case is 2x, which keeps the accounting simple.
 */
export async function acquireGitAdmissionWithinTimeout(
  request: GitAdmissionRequest,
  timeoutMs: number | undefined
): Promise<GitAdmissionGrant> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return acquireGitAdmission(request)
  }
  // Own controller: a deadline abort must stay distinguishable from the caller's.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = request.signal
    ? AbortSignal.any([request.signal, deadline.signal])
    : deadline.signal
  try {
    return await acquireGitAdmission({ ...request, signal })
  } catch (error) {
    // A caller abort keeps its own AbortError; only the deadline reads as the command timing out.
    throw deadline.signal.aborted && !request.signal?.aborted
      ? new GitCommandTimeoutError(timeoutMs)
      : error
  } finally {
    clearTimeout(timer)
  }
}
