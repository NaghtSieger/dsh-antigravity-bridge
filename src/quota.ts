
/**
 * Per-account model quota reader using the official `agy /usage` command.
 * @module dsh-llm-antigravity-acp/quota
 */

import type { CatalogModel } from './catalog.ts'
import type { Effort } from './config.ts'
import type { CommandRunner } from './preflight.ts'

/** One quota window. */
export interface QuotaBucket {
  id: string
  name: string
  window: string
  remainingFraction: number
  resetTime: string
  /** The CLI or upstream says this window does not apply right now, such as a 5-hour window paused after the weekly window is spent. */
  disabled?: boolean
}

/**
 * Whether one window is the weekly (7-day) bucket. Upstream either names the
 * window `weekly` or encodes it in the bucket id (`gemini-weekly`, `3p-7d`), so
 * both fields are matched. A bucket upstream marked disabled is still the
 * weekly bucket; each caller decides what an inactive window means for it.
 * @param bucket - quota window.
 * @returns true when the bucket is the weekly window.
 */
export function isWeeklyBucket(bucket: Pick<QuotaBucket, 'id' | 'window'>): boolean {
  return /week|7d/i.test(`${bucket.window} ${bucket.id}`)
}

/** One model group sharing its windows. */
export interface QuotaGroup {
  kind?: 'gemini' | 'argon' | 'claude'
  name: string
  description: string
  buckets: QuotaBucket[]
}

export type SubscriptionTier = 'ULTRA' | 'PRO' | 'FREE' | 'ENTERPRISE'

/** Quota and entitlement snapshot of one account. */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  updatedAt: string
  groups: QuotaGroup[]
  error?: string
  /** Known subscription tier. */
  subscriptionTier?: SubscriptionTier
  /** Human-readable subscription plan name (e.g. `Google AI Ultra`, `Google AI Pro`). */
  subscriptionName?: string
  /** Active ACP models actually entitled on this account. */
  availableModels?: CatalogModel[]
  /** Per-model offered efforts discovered from upstream. */
  effortsByModel?: Record<string, Effort[]>
  /** Per-model context window ceiling discovered from upstream. */
  maxTokensByModel?: Record<string, number>
  /** Models explicitly marked disabled for this account (e.g. `gemini-4-argon`). */
  disabledModels?: string[]
  /** True on Ultra/Enterprise where Argon shares the Gemini pool instead of a split bucket. */
  argonSharedWithGemini?: boolean
  /**
   * Account this snapshot was read from. Set by the runtime so a caller can
   * tell which subscription a number belongs to instead of assuming the account
   * that happened to serve the previous step.
   */
  accountId?: string
  /** Display name or address of that account. */
  accountLabel?: string
  /**
   * Model the caller asked about, echoed back. A client keeps a response only
   * while it still matches the model on screen, so a slow read for the previous
   * model can never overwrite the new one.
   */
  model?: string
  /** Windows that govern `model` on this account, resolved against its entitlements. */
  focus?: ModelQuotaFocus
}

/** Quota family that governs one model. */
export type QuotaFamily = 'gemini' | 'argon' | 'claude'

/**
 * Resolution of the windows that govern one model on one account.
 *
 * `entitled: false` means this account cannot serve the model at all — Argon on
 * a Pro plan, for example — and the caller must not substitute another family's
 * windows: a Pro account's untouched Gemini pool is not Argon capacity.
 */
export interface ModelQuotaFocus {
  model: string
  family: QuotaFamily
  /** Whether this account may spend the model. */
  entitled: boolean
  /** Why the model has no windows here. */
  reason?: 'model-not-entitled' | 'no-groups'
  /** Windows that govern the model; absent unless `entitled`. */
  group?: QuotaGroup
}

/**
 * Parse `agy -p /usage --output-format json` output.
 * @param stdout - command stdout.
 * @returns the quota groups.
 */
export function parseUsage(stdout: string): QuotaGroup[] {
  const parsed = JSON.parse(stdout) as { command?: { data?: { groups?: unknown[] } } }
  const groups = parsed.command?.data?.groups
  if (!Array.isArray(groups)) throw new Error('agy /usage returned no quota groups')
  return groups.map((raw) => {
    const group = raw as { name?: string; description?: string; buckets?: unknown[] }
    const name = String(group.name ?? '')
    const lower = name.toLowerCase()
    const kind: QuotaGroup['kind'] = lower.includes('argon')
      ? 'argon'
      : (lower.includes('claude') || lower.includes('gpt') || lower.includes('3p') ? 'claude' : 'gemini')
    return {
      kind,
      name,
      description: String(group.description ?? ''),
      buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((b) => {
        const bucket = b as Record<string, unknown>
        return {
          id: String(bucket.id ?? ''),
          name: String(bucket.name ?? ''),
          window: String(bucket.window ?? ''),
          remainingFraction: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0,
          resetTime: String(bucket.reset_time ?? ''),
          ...(bucket.disabled === true ? { disabled: true } : {}),
        }
      }),
    }
  })
}

/**
 * Pick the quota group that serves one model family.
 * Checks dedicated Argon groups first (`gemini-4-argon` on Pro), then falls
 * back to Gemini (shared pool on Ultra) or Claude/GPT.
 * @param groups - quota groups.
 * @param model - model family id.
 * @returns the matching group.
 */
export function groupForModel(groups: readonly QuotaGroup[], model: string): QuotaGroup | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('argon')) {
    const argonGroup = groups.find(g => g.kind === 'argon' || (/\bargon\b/i.test(g.name) && g.kind !== 'gemini'))
    if (argonGroup !== undefined) return argonGroup
    return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && !/claude|gpt|3p/i.test(g.name))) ?? groups[0]
  }
  const gemini = lower.includes('gemini')
  if (gemini) {
    return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && g.kind !== 'argon')) ?? groups[0]
  }
  return groups.find(g => g.kind === 'claude' || /claude|gpt|3p/i.test(g.name)) ?? groups[0]
}

/**
 * Quota family that governs one model id.
 * Argon keeps its own bucket on Pro, so it is not folded into `gemini` here.
 * @param model - model id.
 * @returns the family.
 */
export function quotaFamilyFor(model: string): QuotaFamily {
  if (/argon/i.test(model)) return 'argon'
  if (/claude|gpt|oss/i.test(model)) return 'claude'
  return 'gemini'
}

/** Kind of one group, deriving it from the name when upstream omitted it. */
function groupKindOf(group: QuotaGroup): QuotaFamily {
  return group.kind ?? (/argon/i.test(group.name) ? 'argon' : (/claude|gpt|3p/i.test(group.name) ? 'claude' : 'gemini'))
}

/**
 * Whether this account positively cannot serve Argon. Only evidence counts, so
 * a snapshot that reports no entitlements at all keeps the historic behaviour
 * of trusting the group list; a plan that lists its models, disables Argon by
 * name, or is a Pro/Free plan never borrows the Gemini pool for it.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns true when Argon is known to be unavailable.
 */
function argonUnavailable(snapshot: QuotaSnapshot, model: string): boolean {
  if ((snapshot.disabledModels ?? []).some(entry => entry === model || /argon/i.test(entry))) return true
  const entitled = snapshot.availableModels
  if (Array.isArray(entitled) && entitled.length > 0 && !entitled.some(entry => entry.id === model || /argon/i.test(entry.id))) return true
  const tier = snapshot.subscriptionTier
  return tier === 'PRO' || tier === 'FREE'
}

/**
 * Resolve the windows that govern one model on one account.
 *
 * The families do not fall back into each other: a missing Argon bucket on a
 * Pro plan is reported as `model-not-entitled` instead of borrowing the Gemini
 * pool, which is what made an untouched Pro plan read as 100% Argon capacity.
 * Ultra shares one pool between Argon and Gemini, and upstream flags that with
 * `argonSharedWithGemini`, so only that case reuses the Gemini windows.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns the focus, including the group when the account may spend the model.
 */
export function resolveModelQuota(snapshot: QuotaSnapshot, model: string): ModelQuotaFocus {
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : []
  const family = quotaFamilyFor(model)
  const pick = (kind: QuotaFamily): QuotaGroup | undefined => groups.find(group => groupKindOf(group) === kind)

  if (family === 'argon') {
    const argon = pick('argon')
    if (argon !== undefined) return { model, family, entitled: true, group: argon }
    const gemini = pick('gemini')
    const shared = snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE'
    if (gemini !== undefined && (shared || !argonUnavailable(snapshot, model))) {
      return { model, family, entitled: true, group: gemini }
    }
    return {
      model,
      family,
      entitled: false,
      reason: argonUnavailable(snapshot, model) ? 'model-not-entitled' : 'no-groups',
    }
  }
  if (family === 'claude') {
    const claude = pick('claude')
    return claude !== undefined
      ? { model, family, entitled: true, group: claude }
      : { model, family, entitled: false, reason: 'no-groups' }
  }
  const gemini = pick('gemini') ?? (snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE' ? pick('argon') : undefined)
  return gemini !== undefined
    ? { model, family, entitled: true, group: gemini }
    : { model, family, entitled: false, reason: 'no-groups' }
}

/**
 * Cached quota reader. Every account keeps its own cache entry and in-flight
 * request so one account's windows and entitlements never bleed into another.
 */
export class QuotaReader {
  private readonly cached = new Map<string, { snapshot: QuotaSnapshot; at: number }>()
  private readonly inflight = new Map<string, Promise<QuotaSnapshot>>()

  /**
   * @param binary - resolves the official agy executable.
   * @param run - helper command runner.
   * @param ttlMs - cache lifetime.
   */
  constructor(
    private readonly binary: () => string,
    private readonly run: CommandRunner,
    private readonly ttlMs: number,
  ) {}

  /**
   * Return the cached snapshot of one account without triggering I/O.
   * @param accountId - account key.
   * @returns cached snapshot, if any.
   */
  peekFor(accountId: string): QuotaSnapshot | undefined {
    return this.cached.get(accountId)?.snapshot
  }

  /**
   * Read the quota and entitlement snapshot of one account.
   * @param accountId - account the snapshot belongs to.
   * @param env - environment that selects that account's credential store.
   * @param force - bypass the cache.
   * @returns the snapshot; failures resolve as `status: 'error'`.
   */
  async readFor(accountId: string, env: NodeJS.ProcessEnv, force = false): Promise<QuotaSnapshot> {
    const hit = this.cached.get(accountId)
    if (!force && hit !== undefined && Date.now() - hit.at < this.ttlMs) return hit.snapshot
    const running = this.inflight.get(accountId)
    if (!force && running !== undefined) return running
    const pending = this.fetch(accountId, env).finally(() => {
      if (this.inflight.get(accountId) === pending) this.inflight.delete(accountId)
    })
    this.inflight.set(accountId, pending)
    return pending
  }

  /** Forget every cached snapshot, for example after the account list changed. */
  clear(): void {
    this.cached.clear()
  }

  private async fetch(accountId: string, env: NodeJS.ProcessEnv): Promise<QuotaSnapshot> {
    try {
      const result = await this.run([this.binary(), '-p', '/usage', '--output-format', 'json'], 45_000, env)
      if (result.code !== 0) throw new Error(`agy /usage failed (${result.code === null ? 'no exit code' : `exit ${result.code}`})`)
      const snapshot: QuotaSnapshot = {
        status: 'ok',
        updatedAt: new Date().toISOString(),
        groups: parseUsage(result.stdout),
      }
      this.cached.set(accountId, { snapshot, at: Date.now() })
      return snapshot
    } catch (error) {
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: this.cached.get(accountId)?.snapshot.groups ?? [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
