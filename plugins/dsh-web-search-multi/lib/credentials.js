/**
 * Credential resolution for every provider in this package.
 *
 * The Harness owns secrets: a search resolves its key through `ctx.credentials`
 * (the same store the Web Models page writes), falling back to the launcher's
 * environment snapshot and then to `process.env`. Nothing is cached except the
 * last observed *existence* of a key, which is what lets the synchronous
 * `available()` check stay cheap and network-free.
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';

/**
 * Credential references per provider id.
 *
 * Each entry lists the vendor's own documented variable first, followed by the
 * aliases its SDKs and ecosystem commonly use, so a key exported under any of
 * them is found. Resolution tries them in order and stops at the first non-empty
 * value.
 */
export const CREDENTIAL_ENV = {
  bocha: 'BOCHA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  exa: 'EXA_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

/** Alternative variable names accepted after the primary one. */
export const CREDENTIAL_ENV_ALIASES = {
  bocha: ['BOCHA_KEY'],
  brave: ['BRAVE_API_KEY'],
  zhipu: ['ZHIPUAI_API_KEY', 'GLM_API_KEY'],
};

/** Every reference name a provider accepts, primary first. */
export function credentialRefs(id) {
  const primary = CREDENTIAL_ENV[id];
  return [primary, ...(CREDENTIAL_ENV_ALIASES[id] ?? [])].filter((name) => typeof name === 'string');
}

/** Providers that need no credential at all. */
export const KEYLESS_PROVIDERS = ['ddg', 'searxng'];

/**
 * Resolve one credential reference for the next operation.
 *
 * @param ctx - the plugin context supplying the credentials and environment planes.
 * @param envVar - the reference name, e.g. `BRAVE_API_KEY`.
 * @returns the resolved value, or undefined when nothing is stored anywhere.
 */
export async function resolveCredential(ctx, envVar) {
  const fromStore = await resolveFromStore(ctx, envVar);
  if (fromStore !== undefined) return fromStore;
  const launched = readLaunchEnvironment(ctx, envVar);
  if (launched !== undefined && launched.length > 0) return launched;
  const ambient = process.env[envVar];
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
}

/**
 * Read one variable from the launcher's environment snapshot, tolerating a
 * composition (or a test double) whose `launchEnvironment` slot is present but
 * not the expected snapshot.
 */
function readLaunchEnvironment(ctx, envVar) {
  try {
    const hit = launchEnvironmentOf(ctx).get(envVar);
    return typeof hit?.value === 'string' ? hit.value : undefined;
  } catch {
    return undefined;
  }
}

/** Try every accepted reference name for one provider, primary first. */
export async function resolveFirstCredential(ctx, envVars) {
  for (const envVar of envVars) {
    const value = await resolveCredential(ctx, envVar);
    if (value !== undefined) return { value, envVar };
  }
  return undefined;
}

/** Ask the credentials service, tolerating a composition that does not mount one. */
async function resolveFromStore(ctx, envVar) {
  let credentials;
  try {
    credentials = ctx.get('credentials');
  } catch {
    return undefined;
  }
  if (credentials === undefined || credentials === null) return undefined;
  try {
    const hit = await credentials.resolve(envVar);
    const value = hit?.value;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    // A malformed reference or an unavailable store must not fail the search:
    // the environment fallbacks below are still authoritative.
    return undefined;
  }
}

/**
 * Synchronous, network-free "is this provider configured?" probe.
 *
 * `available()` cannot await, so the probe reports the last observation and is
 * refreshed in the background at every search and at mount time. A provider is
 * never advertised as usable on the strength of a stale key: the refresh runs
 * before the first search of a session, and a failed search clears the cache so
 * the next selection round sees the provider as unavailable again.
 */
export class CredentialProbe {
  #ctx;
  #envVars;
  #primary;
  #literal;
  #present = false;

  /**
   * @param ctx - plugin context for store and environment lookups.
   * @param envVars - accepted reference names, primary first.
   * @param literal - an inline key that wins over every store.
   */
  constructor(ctx, envVars, literal) {
    this.#ctx = ctx;
    this.#envVars = Array.isArray(envVars) ? envVars : [envVars];
    this.#primary = this.#envVars[0];
    this.#literal = typeof literal === 'string' && literal.length > 0 ? literal : undefined;
    if (this.#literal !== undefined) this.#present = true;
    // Seed availability from the inherited environment. The launcher merges its
    // `.env` layers into the process environment before any plugin mounts, so
    // this is authoritative on a cold start — and it keeps the first selection
    // round from reporting a configured provider as unusable before the
    // asynchronous credential-store lookup below has finished.
    else this.#present = this.#ambientVar() !== undefined;
  }

  /** @returns the first accepted variable present in the process environment. */
  #ambientVar() {
    for (const envVar of this.#envVars) {
      const value = process.env[envVar];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  /** @returns whether this provider currently looks configured. */
  get present() {
    return this.#present;
  }

  /** @returns the primary reference name, for error messages. */
  get envVar() {
    return this.#primary;
  }

  /** @returns every reference name this probe accepts. */
  get envVars() {
    return [...this.#envVars];
  }

  /** Re-read the credential and update the cached presence flag. */
  async refresh() {
    if (this.#literal !== undefined) {
      this.#present = true;
      return this.#literal;
    }
    const hit = await resolveFirstCredential(this.#ctx, this.#envVars);
    this.#present = hit !== undefined;
    return hit?.value;
  }

  /** Record that the last search was rejected as unauthenticated. */
  invalidate() {
    if (this.#literal === undefined) this.#present = false;
  }

  /** Resolve the key for one operation, refreshing the cached presence flag. */
  async resolve() {
    return this.refresh();
  }
}

/** Resolve many probes in the background without blocking the caller. */
export function refreshAll(probes) {
  return Promise.allSettled([...probes].map((probe) => probe.refresh()));
}
