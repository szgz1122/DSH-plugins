/**
 * Configuration handling for the provider family.
 *
 * The plugin owns its defaults and validation directly instead of leaning on the
 * Harness schema library. Two reasons: this package then has no import that the
 * loader must inject, so a mis-installed plugin degrades to "no extra sources"
 * rather than breaking composition; and the whole config surface stays testable
 * outside the app.
 *
 * Cordis may hand a plugin either plain values or volatile *references* (each
 * field an object with `get()`), so every read goes through {@link readRef}.
 */
import { CREDENTIAL_ENV, credentialRefs } from './credentials.js';

/** Provider selected when the user has not chosen one. */
export const DEFAULT_PROVIDER = 'none';

/** Cap on sources requested from any provider. */
export const ABSOLUTE_MAX_COUNT = 50;

const PROVIDER_IDS = [
  'none',
  'bocha',
  'tavily',
  'brave',
  'exa',
  'perplexity',
  'zhipu',
  'minimax',
  'searxng',
  'ddg',
];

/** Base URL, default count and extra writable fields per provider. */
const SECTIONS = {
  bocha: { baseURL: 'https://api.bochaai.com', count: 10, fields: ['freshness'] },
  tavily: { baseURL: 'https://api.tavily.com', count: 8, fields: ['searchDepth', 'topic'] },
  brave: { baseURL: 'https://api.search.brave.com', count: 10, fields: ['country', 'searchLang', 'freshness', 'extraSnippets'] },
  exa: { baseURL: 'https://api.exa.ai', count: 8, fields: ['searchType'] },
  perplexity: { baseURL: 'https://api.perplexity.ai', count: 10, fields: ['searchType', 'country'] },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', count: 10, fields: ['engine'] },
  minimax: { baseURL: 'https://api.minimax.chat/anthropic/v1', count: 10, fields: ['model'] },
  searxng: { baseURL: 'http://127.0.0.1:8080', count: 10, fields: ['engines', 'language', 'timeRange'] },
  ddg: { baseURL: 'https://html.duckduckgo.com', count: 10, fields: ['region'] },
};

/** Default value for one extra field; `undefined` means "genuinely optional". */
const FIELD_DEFAULTS = {
  tavily: { searchDepth: 'basic' },
  exa: { searchType: 'auto' },
  zhipu: { engine: 'search_std' },
  minimax: { model: 'MiniMax-Text-01' },
};

/** Read one value that may be a volatile reference or already plain. */
export function readRef(value) {
  if (value === null || value === undefined) return undefined;
  return typeof value.get === 'function' ? value.get() : value;
}

/** Read one field of a group that may itself be a reference. */
function readGroupField(group, key) {
  const direct = readRef(group?.[key]);
  if (direct !== undefined) return direct;
  const plain = readRef(group);
  return plain !== null && typeof plain === 'object' ? plain[key] : undefined;
}

/** Clamp a candidate count into `1..ABSOLUTE_MAX_COUNT`. */
export function clampCount(count) {
  const numeric = typeof count === 'string' ? Number(count) : count;
  if (!Number.isInteger(numeric) || numeric < 1) return undefined;
  return Math.min(numeric, ABSOLUTE_MAX_COUNT);
}

/** Coerce a YAML-supplied list of engine names into a clean string array. */
function readStringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
  if (typeof value === 'string' && value.length > 0) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

/**
 * Resolve the effective plugin configuration.
 *
 * @param raw - the config the loader supplied; plain, a reference tree, or absent.
 * @returns a fully defaulted, validated plain config.
 */
export function resolveConfig(raw) {
  const providerRaw = readRef(raw?.provider);
  const provider = typeof providerRaw === 'string' && PROVIDER_IDS.includes(providerRaw) ? providerRaw : DEFAULT_PROVIDER;

  const sections = {};
  for (const [id, spec] of Object.entries(SECTIONS)) {
    const group = raw?.[id];
    const section = {
      apiKey: readGroupField(group, 'apiKey'),
      apiKeyEnv: readGroupField(group, 'apiKeyEnv'),
      baseURL: readGroupField(group, 'baseURL') ?? spec.baseURL,
      count: clampCount(readGroupField(group, 'count')) ?? spec.count,
    };
    for (const field of spec.fields) {
      const value = readGroupField(group, field);
      const fallback = FIELD_DEFAULTS[id]?.[field];
      if (value === undefined && fallback !== undefined) {
        section[field] = fallback;
        continue;
      }
      if (field === 'engines') {
        section[field] = readStringList(value);
        continue;
      }
      if (field === 'extraSnippets') {
        section[field] = value === true;
        continue;
      }
      section[field] = value;
    }
    sections[id] = section;
  }

  return { provider, ...sections };
}

/**
 * Credential reference names to try for one provider.
 *
 * A configured `apiKeyEnv` replaces the primary name but keeps the vendor's
 * aliases, so a custom reference does not silently disable the documented
 * variable.
 */
export function credentialRefsFor(id, configured) {
  const defaults = credentialRefs(id);
  const custom = readRef(configured);
  if (typeof custom !== 'string' || custom.length === 0) return defaults;
  if (custom === defaults[0]) return defaults;
  return [custom, ...defaults.slice(1)];
}

/** The reference name to report in errors for one provider. */
export function primaryEnvFor(id, configured) {
  return credentialRefsFor(id, configured)[0] ?? CREDENTIAL_ENV[id];
}

/**
 * JSON Schema for this plugin's config, published to the loader so the settings
 * UI can render the section and report write capability.
 */
export const Config = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      enum: PROVIDER_IDS,
      default: DEFAULT_PROVIDER,
      description: 'Which search source serves web_search. "none" keeps every source in this plugin dark, so the shipped provider stays in charge.',
    },
    ...Object.fromEntries(
      Object.entries(SECTIONS).map(([id, spec]) => [
        id,
        {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'Literal API key; prefer apiKeyEnv so no secret enters configuration.' },
            apiKeyEnv: {
              type: 'string',
              default: CREDENTIAL_ENV[id] ?? '',
              description: `Credential reference to resolve for this source, e.g. ${(credentialRefs(id)[0] ?? 'n/a')}.`,
            },
            baseURL: { type: 'string', default: spec.baseURL, description: 'Endpoint base; override only for a proxy or a mirror.' },
            count: {
              type: 'number',
              default: spec.count,
              minimum: 1,
              maximum: ABSOLUTE_MAX_COUNT,
              description: 'Preferred number of sources per search; the caller may request fewer.',
            },
            ...Object.fromEntries(
              spec.fields.map((field) => [
                field,
                field === 'extraSnippets'
                  ? { type: 'boolean', default: false, description: 'Request Brave extra snippets (billable).' }
                  : { type: 'string', ...(FIELD_DEFAULTS[id]?.[field] === undefined ? {} : { default: FIELD_DEFAULTS[id][field] }) },
              ]),
            ),
          },
          additionalProperties: false,
        },
      ]),
    ),
  },
  additionalProperties: false,
};

export { PROVIDER_IDS };
