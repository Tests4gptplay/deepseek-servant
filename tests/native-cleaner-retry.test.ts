import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error The reviewed production cleaner is intentionally maintained as native ESM JavaScript.
import { NativeCleanerCoordinator } from '../src/native-cleaner/coordinator.mjs'

interface FakeTimer {
  at: number
  cleared: boolean
  callback: () => void
  unref(): FakeTimer
}

async function withFakeClock(run: (clock: {
  active(): FakeTimer[]
  fireNext(): Promise<number>
  nextDelay(): number
}) => Promise<void>): Promise<void> {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalNow = Date.now
  let now = 0
  const timers: FakeTimer[] = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer: FakeTimer = {
      at: now + Number(delay),
      cleared: false,
      callback: () => callback(...args),
      unref: () => timer,
    }
    timers.push(timer)
    return timer
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer: FakeTimer | undefined) => {
    if (timer) timer.cleared = true
  }) as unknown as typeof clearTimeout
  Date.now = () => now
  const active = () => timers.filter(timer => !timer.cleared).sort((left, right) => left.at - right.at)
  try {
    await run({
      active,
      nextDelay: () => {
        const pending = active()
        assert.equal(pending.length, 1)
        return pending[0]!.at - now
      },
      fireNext: async () => {
        const pending = active()
        assert.equal(pending.length, 1)
        const timer = pending[0]!, delay = timer.at - now
        timer.cleared = true
        now = timer.at
        timer.callback()
        await Promise.resolve()
        await Promise.resolve()
        return delay
      },
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    Date.now = originalNow
  }
}

function coordinatorFixture() {
  const coordinator = new NativeCleanerCoordinator(
    { agents: new Map(), sessions: new Map() },
    { lifecycles: new Map() },
    {},
  )
  const retries: Array<{ automatic?: boolean }> = []
  coordinator.recoveryNeeded = false
  coordinator.retry = async (options: { automatic?: boolean } = {}) => { retries.push(options) }
  return { coordinator, retries }
}

function retainRetryable(coordinator: any, life: { id: string }): void {
  coordinator.retained.set(life.id, life)
  coordinator.retryable.add(life)
  coordinator.settleRetry('log', life, true)
}

test('continuous cleaner failures back off at 1, 2, 4 through the 60 second cap', async () => {
  await withFakeClock(async clock => {
    const { coordinator, retries } = coordinatorFixture()
    const life = { id: 'continuous-duty' }
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      retainRetryable(coordinator, life)
      assert.equal(clock.nextDelay(), expected)
      assert.equal(await clock.fireNext(), expected)
    }
    assert.equal(coordinator.retryDelayMs, 60_000)
    assert.equal(retries.length, 8)
    assert.ok(retries.every(retry => retry.automatic === true))
  })
})

test('only the last settled duty clears its timer and resets backoff', async () => {
  await withFakeClock(async clock => {
    const first = coordinatorFixture().coordinator
    const successful = { id: 'successful-duty' }
    retainRetryable(first, successful)
    first.retained.delete(successful.id)
    first.retryable.delete(successful)
    first.settleRetry('log', successful, false)
    assert.equal(clock.active().length, 0)
    assert.equal(first.retryDelayMs, 1_000)
    assert.equal(first.retryKnown.size, 0)
    assert.equal(first.retryTimer, undefined)
    assert.equal(first.retryDueAt, undefined)

    const second = coordinatorFixture().coordinator
    const settled = { id: 'settled-duty' }, remaining = { id: 'remaining-duty' }
    retainRetryable(second, settled)
    retainRetryable(second, remaining)
    second.retained.delete(settled.id)
    second.retryable.delete(settled)
    second.settleRetry('log', settled, false)
    assert.equal(clock.active().length, 1)
    assert.equal(second.retryDelayMs, 2_000)

    second.retain(remaining, { retryable: false })
    second.settleRetry('log', remaining, false)
    assert.equal(clock.active().length, 0)
    assert.equal(second.retryDelayMs, 1_000)
    assert.equal(second.retryKnown.size, 0)
    assert.equal(second.retryTimer, undefined)
    assert.equal(second.retryDueAt, undefined)
  })
})

test('a new duty preempts an old 60 second retry with its own one second retry', async () => {
  await withFakeClock(async clock => {
    const { coordinator } = coordinatorFixture()
    const oldDuty = { id: 'old-duty' }
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
      retainRetryable(coordinator, oldDuty)
      assert.equal(await clock.fireNext(), expected)
    }
    retainRetryable(coordinator, oldDuty)
    assert.equal(clock.nextDelay(), 60_000)
    const oldTimer = clock.active()[0]!

    const newDuty = { id: 'new-duty' }
    retainRetryable(coordinator, newDuty)
    assert.equal(oldTimer.cleared, true)
    assert.equal(clock.nextDelay(), 1_000)
    assert.equal(coordinator.retryDueAt, 64_000)
  })
})

test('dispose clears retry timing and late settlement cannot schedule more work', async () => {
  await withFakeClock(async clock => {
    const { coordinator, retries } = coordinatorFixture()
    const life = { id: 'disposed-duty' }
    retainRetryable(coordinator, life)
    assert.equal(clock.nextDelay(), 1_000)

    await coordinator.dispose()
    assert.equal(clock.active().length, 0)
    assert.equal(coordinator.retryTimer, undefined)
    assert.equal(coordinator.retryDueAt, undefined)
    assert.deepEqual(retries, [])

    coordinator.settleRetry('log', life, true)
    assert.equal(clock.active().length, 0)
    assert.deepEqual(retries, [])
  })
})
