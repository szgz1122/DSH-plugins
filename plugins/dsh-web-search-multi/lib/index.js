/**
 * dsh-web-search-multi — extra web-search providers for the Harness `ctx.web` seam.
 *
 * Registers one search provider per configured source. Exactly one provider is
 * advertised as *usable* at a time — the one named by `provider` — because the
 * seam throws `WEB_PROVIDER_AMBIGUOUS` when several usable providers are
 * registered and none is pinned. That single-usable-at-a-time rule is what makes
 * this package safe to mount next to the shipped `deepseek-official` provider:
 * every source here stays dark until the user names it.
 *
 * Switching sources is a configuration change, not a code change:
 *   Settings > Plugins > Plugin configuration > Web search > Provider
 * or the same value in the profile's `cordis.patch.yml`.
 *
 * @module dsh-web-search-multi
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { CredentialProbe, KEYLESS_PROVIDERS, refreshAll } from './credentials.js';
import { Config, credentialRefsFor, clampCount, DEFAULT_PROVIDER, primaryEnvFor, readRef, resolveConfig } from './config.js';
import {
  bocha,
  brave,
  ddg,
  exa,
  minimax,
  perplexity,
  runJsonAdapter,
  searxng,
  tavily,
  zhipu,
} from './providers.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-multi';

/** The web seam this provider family registers into. */
export const inject = ['web'];

/** Which providers this package can serve, and how to reach each one. */
const CATALOG = {
  bocha: { adapter: bocha, keyless: false },
  tavily: { adapter: tavily, keyless: false },
  brave: { adapter: brave, keyless: false },
  exa: { adapter: exa, keyless: false },
  perplexity: { adapter: perplexity, keyless: false },
  zhipu: { adapter: zhipu, keyless: false },
  minimax: { adapter: minimax, keyless: false },
  searxng: { adapter: searxng, keyless: true },
  ddg: { adapter: ddg, keyless: true },
};

/** Remove duplicate sources by URL, keeping the first occurrence. */
function dedupe(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    if (source === undefined || typeof source.url !== 'string' || source.url.length === 0) continue;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}

/** Resolve the per-call source count from the section and the caller's bound. */
function resolveCount(options, maxResults) {
  const configured = clampCount(options.count);
  const bounded = clampCount(maxResults);
  if (configured === undefined && bounded === undefined) return 10;
  if (configured === undefined) return bounded;
  if (bounded === undefined) return configured;
  return Math.min(configured, bounded);
}

/** Whether `selected` names this provider id, tolerating an unset value. */
function isSelectedBy(selected, id) {
  const value = typeof selected === 'string' && selected.length > 0 ? selected : DEFAULT_PROVIDER;
  return value === id;
}

/**
 * The provider registered with `ctx.web`.
 *
 * One instance exists per provider id; only the selected instance reports
 * `available() === true`, which keeps the seam's selection deterministic.
 */
export class MultiSearchProvider {
  /** @type {string} */
  id;
  #label;
  #adapter;
  #probe;
  #keyless;
  #isSelected;
  #snapshot;

  /**
   * @param options - id, label, adapter, credential probe, selection predicate and snapshot.
   */
  constructor(options) {
    this.id = options.id;
    this.#label = options.label;
    this.#adapter = options.adapter;
    this.#probe = options.probe;
    this.#keyless = options.keyless === true;
    this.#isSelected = options.isSelected;
    this.#snapshot = options.snapshot;
  }

  /**
   * Cheap, network-free availability. A provider is usable only while it is the
   * selected one and (for key-backed sources) has a resolvable credential.
   */
  available() {
    if (!this.#isSelected()) return false;
    const options = this.#snapshot();
    if (typeof options.baseURL !== 'string' || !URL.canParse(options.baseURL)) return false;
    if (this.#keyless) return true;
    return this.#probe.present;
  }

  /**
   * Run one search through this source.
   *
   * @param request - the seam's `{ query, maxResults }`.
   * @param signal - optional cancellation signal forwarded to the transport.
   * @returns normalized sources, capped by this provider's own count.
   */
  async search(request, signal) {
    const options = this.#snapshot();
    const count = resolveCount(options, request.maxResults);
    const query = typeof request.query === 'string' ? request.query : '';
    if (this.#keyless) {
      const result = await this.#adapter.search({ ...options, query, count, signal });
      return this.#finish(result, count);
    }
    const key = await this.#resolveKey();
    try {
      const result = await runJsonAdapter(this.#adapter, { ...options, query, count, key, signal });
      return this.#finish(result, count);
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /** Apply deduplication, the result cap and the truncation flag. */
  #finish(result, count) {
    const sources = dedupe(result.sources ?? []);
    return {
      ...(typeof result.content === 'string' && result.content.length > 0 ? { content: result.content } : {}),
      sources: sources.slice(0, count),
      truncated: result.truncated === true || sources.length > count,
    };
  }

  /** Resolve the credential for this operation, refreshing the availability cache. */
  async #resolveKey() {
    const key = await this.#probe.resolve();
    if (typeof key !== 'string' || key.length === 0) {
      throw new WebError(
        `${this.#label} search has no API key for "${this.#probe.envVar}" (also accepts ${this.#probe.envVars.slice(1).join(', ') || 'no aliases'}); store it through the credentials service (the Web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the web-search-multi config. To use a keyless source instead, select ddg or searxng under Settings > Plugins > Plugin configuration > Web search.`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }
    return key;
  }

  /** Turn an authentication rejection into guidance and drop the cached credential. */
  #translate(error) {
    if (!(error instanceof WebError)) throw error;
    if (/\bHTTP (?:401|403)\b/u.test(error.message)) {
      this.#probe.invalidate();
      throw new WebError(
        `${error.message}\n\nThe ${this.#label} credential was rejected. Guide the user to store a valid key for "${this.#probe.envVar}" and, if they want a different source, to change Provider under Settings > Plugins > Plugin configuration > Web search.`,
        error.code,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Register one search provider per catalog entry.
 *
 * @param ctx - the plugin context; `ctx.web` is injected.
 * @param config - the raw plugin config from the loader.
 */
export function apply(ctx, config) {
  const probes = [];
  // Resolve once at mount to seed the credential probes; each provider then
  // re-resolves per read so an edited config reaches the next search without
  // re-registering (which would flicker the seam's selection).
  const initial = resolveConfig(config);

  for (const [id, entry] of Object.entries(CATALOG)) {
    const probe = entry.keyless
      ? undefined
      : new CredentialProbe(ctx, credentialRefsFor(id, initial[id].apiKeyEnv), initial[id].apiKey);
    const provider = new MultiSearchProvider({
      id,
      label: entry.adapter.label,
      adapter: entry.adapter,
      probe,
      keyless: entry.keyless,
      isSelected: () => isSelectedBy(readRef(config?.provider), id),
      snapshot: () => {
        const section = resolveConfig(config)[id];
        return { ...section, apiKeyEnv: probe?.envVar ?? primaryEnvFor(id, section.apiKeyEnv) };
      },
    });
    ctx.web.registerSearchProvider(provider);
    if (probe !== undefined) probes.push(probe);
  }

  // Refresh availability in the background: `available()` is synchronous and
  // network-free, so the first selection round uses the cached observation.
  void refreshAll(probes);
}

export { Config, DEFAULT_PROVIDER, KEYLESS_PROVIDERS, resolveConfig };
