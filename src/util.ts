/**
 * Small async primitives shared by the adapter: deferred values, an
 * unbounded event queue with abortable waits, and a keyed mutex.
 * @module dsh-llm-antigravity-acp/util
 */

import { createHash } from 'node:crypto'
import { LlmError, type BuiltinLlmFailureCode, type LlmFailure } from '@deepseek-ai/dsh-llm'

/** A promise with externally exposed settlement. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
  settled: boolean
}

/**
 * Create a deferred value.
 * @returns the deferred handle.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // A rejection nobody awaits is expected when a parked call is abandoned.
  promise.catch(() => undefined)
  const handle: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value) => { if (!handle.settled) { handle.settled = true; resolve(value) } },
    reject: (error) => { if (!handle.settled) { handle.settled = true; reject(error) } },
  }
  return handle
}

/** Unbounded FIFO with one consumer that can wait with a deadline or abort signal. */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined

  /**
   * Append one item.
   * @param item - the queued value.
   */
  push(item: T): void {
    this.items.push(item)
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Number of queued items. */
  get size(): number {
    return this.items.length
  }

  /**
   * Inspect the head without removing it.
   * @returns the head item.
   */
  peek(): T | undefined {
    return this.items[0]
  }

  /**
   * Remove the head item.
   * @returns the head item.
   */
  shift(): T | undefined {
    return this.items.shift()
  }

  /**
   * Wait until an item is available.
   * @param signal - aborts the wait.
   * @param timeoutMs - resolve false after this delay.
   * @returns whether an item is available.
   */
  async wait(signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (this.items.length > 0) return true
    if (signal?.aborted === true) return false
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.waiter === wake) this.waiter = undefined
        resolve(value)
      }
      const wake = (): void => finish(true)
      const onAbort = (): void => finish(false)
      this.waiter = wake
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(this.items.length > 0), timeoutMs)
    })
  }
}

/** Serializes async sections per key. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Acquire the lock for one key.
   * @param key - lock key.
   * @returns the release function.
   */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    return () => {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

/**
 * Stable short digest of a JSON-serializable value.
 * @param value - hashed value.
 * @returns hex digest prefix.
 */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}

/**
 * Sleep for a duration.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Construct an `LlmError` with a plugin-defined failure code across DSH SDK
 * versions (`0.2.2-rc.3+` restricts the `LlmError` constructor to built-in codes
 * and uses `LlmError.fromFailure` for custom codes).
 */
export function customLlmError(
  message: string,
  code: string,
  options?: { status?: number; providerRetryAfterMs?: number; requestId?: Exclude<LlmFailure['requestId'], undefined>; cause?: unknown },
): LlmError {
  if (typeof LlmError.fromFailure === 'function') {
    const failure: LlmFailure = {
      code,
      message,
      ...(options?.status !== undefined ? { status: options.status } : {}),
      ...(options?.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}),
      ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
    }
    return LlmError.fromFailure(failure, options?.cause !== undefined ? { cause: options.cause } : undefined)
  }
  return new LlmError(message, code as BuiltinLlmFailureCode, options)
}
