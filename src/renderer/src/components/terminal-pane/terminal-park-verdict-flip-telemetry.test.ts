import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS,
  TERMINAL_TAB_PARK_FLIP_COMMIT_COST,
  TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
  TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
  getParkVerdictUnparkPinUntilMs,
  recordParkVerdictFlips,
  selectParkVerdictPinnedTabIds,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const TAB = 'tab-1'
/** Slower than the burst window, so only the notice limit can fire. */
const SLOW_CHURN_STEP_MS = TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS * 4

function observe(args: {
  records: Map<string, ParkVerdictFlipRecord>
  parked: boolean
  nowMs: number
  liveTabIds?: ReadonlySet<string>
}): void {
  recordParkVerdictFlips({
    records: args.records,
    liveTabIds: args.liveTabIds ?? new Set([TAB]),
    nextParkedTabIds: args.parked ? new Set([TAB]) : new Set(),
    nowMs: args.nowMs
  })
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
})

// Why asserted: the whole point of the burst trigger is that it is derived from
// React's 50-commit bail, not copied from the breadcrumb notice limit. If the
// two ever converge again the damping stops firing before React throws #185.
describe('burst damping threshold', () => {
  it('stays under React NESTED_UPDATE_LIMIT at the assumed commits-per-flip cost', () => {
    expect(TERMINAL_TAB_PARK_FLIP_BURST_LIMIT * TERMINAL_TAB_PARK_FLIP_COMMIT_COST).toBeLessThan(50)
    expect(TERMINAL_TAB_PARK_FLIP_BURST_LIMIT).toBeLessThan(TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT)
  })
})

describe('recordParkVerdictFlips', () => {
  it('stays silent for a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 100; i += 1) {
      observe({ records, parked: true, nowMs: 1_000 + i * 1_000 })
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(records.get(TAB)?.flips).toBe(0)
  })

  it('emits one burst breadcrumb once the verdict churns at render cadence', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        tabId: TAB,
        trigger: 'burst',
        flips: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS
      })
    )
  })

  // Why: the two triggers answer different questions — 'burst' means damping
  // engaged before React could bail, 'window' means churn too slow to loop.
  it('separates a damped burst from slow churn', () => {
    const tightRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records: tightRecords, parked: i % 2 === 0, nowMs: 1_000 + i })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'burst',
        flips: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        elapsedMs: TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
        windowMs: TERMINAL_TAB_PARK_FLIP_BURST_WINDOW_MS
      })
    )

    recordBreadcrumb.mockClear()

    const slowRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records: slowRecords, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'window',
        flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
        elapsedMs: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT * SLOW_CHURN_STEP_MS,
        windowMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS
      })
    )
  })

  // Why this replaced "does not pin churn spread past the burst window": that
  // rule read the pin as purely a React #185 guard, so slow churn was left to
  // run rather than spend a mounted pane's memory on it. The field disagreed —
  // slow churn remounts the pane every ~3s for as long as it lasts, and a
  // remount re-establishes a remote terminal. Memory is the cheaper side.
  it('pins churn that is too slow to burst but reaches the notice limit', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
    }

    const noticeMs = 1_000 + TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT * SLOW_CHURN_STEP_MS
    expect(records.get(TAB)?.pinnedUntilMs).toBe(noticeMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({
        trigger: 'window',
        pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
        sustainedPinCount: 1
      })
    )
  })

  // Why this cadence and not a round number: it is the field's. Bundle
  // Nz4kzIG_NwLd8KObgjJDKA (v1.4.201, win32) carries 51 'window' churn crumbs,
  // flips exactly 12 at a median elapsedMs of ~35s => one flip every ~2.9s, one
  // tab churning without pause from 02:03 to 02:50. Across 308 field bundles
  // that install is the ONLY one whose churn is slow enough to evade the burst
  // window; the other 22 churning installs all burst, and all got damped.
  describe('sustained field-cadence churn', () => {
    const FIELD_FLIP_INTERVAL_MS = 2_930
    const FIELD_CHURN_FLIPS = 960

    function runFieldChurn(): { pinnedPasses: number; crumbs: number } {
      const records = new Map<string, ParkVerdictFlipRecord>()
      let pinnedPasses = 0
      for (let i = 0; i < FIELD_CHURN_FLIPS; i += 1) {
        const nowMs = 1_000 + i * FIELD_FLIP_INTERVAL_MS
        observe({ records, parked: i % 2 === 0, nowMs })
        const { pinnedTabIds } = selectParkVerdictPinnedTabIds({
          records,
          tabIds: [TAB],
          nowMs
        })
        if (pinnedTabIds.size > 0) {
          pinnedPasses += 1
        }
      }
      return {
        pinnedPasses,
        crumbs: recordBreadcrumb.mock.calls.filter(
          (call) => call[0] === 'terminal_park_verdict_churn'
        ).length
      }
    }

    it('damps the churn instead of letting it run for the whole session', () => {
      const { pinnedPasses, crumbs } = runFieldChurn()

      // Before this fix both numbers were 0 pinned passes and 46 crumbs over
      // the same 47 simulated minutes — damping never engaged even once.
      expect(pinnedPasses).toBeGreaterThan(FIELD_CHURN_FLIPS / 2)
      expect(crumbs).toBeLessThan(10)
    })

    it('backs the pin off to the ceiling while the churn persists', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      for (let i = 0; i < FIELD_CHURN_FLIPS; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * FIELD_FLIP_INTERVAL_MS })
      }

      const pinnedForMs = recordBreadcrumb.mock.calls
        .filter((call) => call[0] === 'terminal_park_verdict_churn')
        .map((call) => (call[1] as { pinnedForMs: number }).pinnedForMs)
      expect(pinnedForMs[0]).toBe(TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
      expect(pinnedForMs.at(-1)).toBe(TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS)
    })

    // Why: without this the back-off is a ratchet — a tab that churned once at
    // launch would still be carrying an 8-minute pin hours later.
    it('starts over at one window after a quiet window', () => {
      const records = new Map<string, ParkVerdictFlipRecord>()
      for (let i = 0; i < TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT + 1; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * SLOW_CHURN_STEP_MS })
      }
      expect(records.get(TAB)?.sustainedPinCount).toBe(1)

      const quietMs = 1_000 + TERMINAL_TAB_PARK_FLIP_SUSTAINED_PIN_MAX_MS * 4
      observe({ records, parked: true, nowMs: quietMs })
      expect(records.get(TAB)?.sustainedPinCount).toBe(0)

      recordBreadcrumb.mockClear()
      for (let i = 1; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
        observe({ records, parked: i % 2 === 0, nowMs: quietMs + i * SLOW_CHURN_STEP_MS })
      }
      expect(recordBreadcrumb).toHaveBeenCalledWith(
        'terminal_park_verdict_churn',
        expect.objectContaining({
          pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
          sustainedPinCount: 1
        })
      )
    })
  })

  it('re-arms after the window elapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)

    const laterMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: laterMs + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
  })

  // Why: an unclamped backwards jump would freeze the window and suppress the
  // very signal this module exists to capture.
  it('treats a backwards clock jump as a fresh window', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 10_000_000 })
    observe({ records, parked: false, nowMs: 1_000 })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  // Why: >= is the boundary operator; a > regression would silently stretch the
  // window and delay every notice by one full period.
  it('treats an exactly-elapsed window as expired', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })
    observe({ records, parked: false, nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  it('honours the window, notice, burst-window and burst-limit overrides', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 10; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB]),
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB]) : new Set(),
        nowMs: 1_000 + i * 100,
        flipWindowMs: 5_000,
        noticeLimit: 3,
        burstWindowMs: 10,
        burstLimit: 2
      })
    }

    // Why 'window': the 100ms step outruns the 10ms burst window, so the burst
    // counter resets on every flip and only the notice limit can fire.
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window', flips: 3, windowMs: 5_000 })
    )
  })

  it('keeps per-tab windows and notices independent', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const other = 'tab-2'
    for (let i = 0; i < 40; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB, other]),
        // Why: TAB churns every call, other stays parked throughout.
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB, other]) : new Set([other]),
        nowMs: 1_000 + i * 10
      })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ tabId: TAB })
    )
    expect(records.get(other)?.flips).toBe(0)
  })

  it('drops records for tabs that no longer exist', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })

    recordParkVerdictFlips({
      records,
      liveTabIds: new Set(),
      nextParkedTabIds: new Set(),
      nowMs: 2_000
    })

    expect(records.size).toBe(0)
  })
})

describe('getParkVerdictUnparkPinUntilMs', () => {
  function churnToBurst(records: Map<string, ParkVerdictFlipRecord>, startMs = 1_000): number {
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: startMs + i * 10 })
    }
    // The first observation only seeds the record, so flip N lands one step later.
    return startMs + TERMINAL_TAB_PARK_FLIP_BURST_LIMIT * 10
  }

  it('does not pin a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: 2_000 })).toBeNull()
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: 'missing', nowMs: 2_000 })).toBeNull()
  })

  // Why the deadline and not a boolean: the caller has to schedule a recheck at
  // it, or the pin never lifts once it has stopped the churn that woke the
  // verdict effect.
  it('reports the pin deadline one window out, then re-arms', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const pinnedAtMs = churnToBurst(records)
    const pinUntilMs = pinnedAtMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinnedAtMs + 1 })).toBe(
      pinUntilMs
    )
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinUntilMs })).toBeNull()
    expect(records.get(TAB)?.flips).toBe(0)
    expect(records.get(TAB)?.burstFlips).toBe(0)

    recordBreadcrumb.mockClear()
    churnToBurst(records, pinUntilMs)
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: pinUntilMs + 1 })).not.toBe(
      null
    )
  })

  // Why: a backwards clock jump must release the pin, not strand it for a window.
  it('releases the pin when the clock jumps backwards', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    churnToBurst(records)

    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: 5 })).toBeNull()
  })

  // Why: the notice window starts at the first flip and the pin starts one
  // burst later, so the notice window always lapses first. Resetting it must
  // not hand the pane back to the parking policy mid-damping.
  it('survives a notice-window expiry that lands mid-pin', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const pinnedAtMs = churnToBurst(records)
    const pinUntilMs = pinnedAtMs + TERMINAL_TAB_PARK_FLIP_WINDOW_MS
    const windowLapseMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS

    // An exogenous flip (visibility change, tab removal) after the notice
    // window lapsed but before the pin deadline.
    expect(windowLapseMs).toBeLessThan(pinUntilMs)
    observe({ records, parked: true, nowMs: windowLapseMs })

    expect(records.get(TAB)?.flips).toBe(1)
    expect(getParkVerdictUnparkPinUntilMs({ records, tabId: TAB, nowMs: windowLapseMs })).toBe(
      pinUntilMs
    )
  })
})

// Why liveness and not presence: a pinned tab can stop being cold-park eligible
// before its deadline, and nothing consults getParkVerdictUnparkPinUntilMs for
// it again. A stale deadline must not silence churn telemetry forever.
describe('expired pins stop gating breadcrumbs', () => {
  it('re-arms damping and notices without a getParkVerdictUnparkPinUntilMs call', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'burst' })
    )

    // Churn resumes past the pin deadline; the pin was never read back.
    const afterPinMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: afterPinMs + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
    expect(recordBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'burst' })
    )
    expect(records.get(TAB)?.pinnedUntilMs).toBeGreaterThan(afterPinMs)
  })

  it('still reports slow churn after a pin lapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    recordBreadcrumb.mockClear()

    // Slow churn only: each step outruns the burst window, so the notice limit
    // is the only trigger left. It must not stay gated by the lapsed pin.
    const afterPinMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i <= TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: afterPinMs + i * SLOW_CHURN_STEP_MS })
    }

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window' })
    )
  })

  // Why: the pin is set from flips on the rendered verdict, so it has to be
  // readable — and expirable — for any live tab, not only cold-park candidates
  // (issue #15136: the driver was the worktree-level park prop).
  it('selects and expires pins for tabs the cold-park selector never proposed', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }

    const pinned = selectParkVerdictPinnedTabIds({ records, tabIds: [TAB], nowMs: 1_500 })
    expect(pinned.pinnedTabIds).toEqual(new Set([TAB]))
    expect(pinned.earliestPinExpiryMs).toBe(records.get(TAB)?.pinnedUntilMs)

    // Past the deadline the pin lapses in place, so damping never latches on.
    const lapsed = selectParkVerdictPinnedTabIds({
      records,
      tabIds: [TAB],
      nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 3
    })
    expect(lapsed.pinnedTabIds.size).toBe(0)
    expect(lapsed.earliestPinExpiryMs).toBeNull()
    expect(records.get(TAB)?.pinnedUntilMs).toBeNull()
  })
})
