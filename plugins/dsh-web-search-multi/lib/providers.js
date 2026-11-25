/**
 * Per-provider wire adapters.
 *
 * Every adapter answers the same two questions:
 *   - where does the key go, and where does the query go (request shape);
 *   - where do url / title / snippet / date live in the response.
 *
 * Contracts are transcribed from each vendor's documented HTTP surface. Any
 * field whose exact spelling is not contractually stable is read defensively
 * through several candidate paths rather than one.
 */
import { WebError } from '@deepseek-ai/dsh-web';
import {
  cleanText,
  httpJson,
  httpText,
  missingCredentialError,
  pickArray,
  pickString,
  readPath,
  stripHtml,
  toRawSource,
  unwrapRedirectUrl,
} from './shared.js';

/** Join a base URL and a path without doubling or dropping the separator. */
function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/u, '')}${path}`;
}

/**
 * Header placeholders. A JSON adapter describes *where* a key goes; the search
 * entry point substitutes the resolved secret, so no adapter ever holds one.
 */
export const KEY_PLACEHOLDER = Object.freeze({
  bearer: '\u0000credential:bearer\u0000',
  xApiKey: '\u0000credential:x-api-key\u0000',
  xSubscriptionToken: '\u0000credential:x-subscription-token\u0000',
});

/** Replace placeholder header values with the resolved credential. */
export function substituteCredential(headers, key) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string' || !value.includes('\u0000credential:')) {
      out[name] = value;
      continue;
    }
    out[name] = value.replace(KEY_PLACEHOLDER.bearer, `Bearer ${key}`).replace(KEY_PLACEHOLDER.xApiKey, key).replace(KEY_PLACEHOLDER.xSubscriptionToken, key);
  }
  return out;
}

/**
 * Run one JSON adapter: build the request, substitute the credential, POST it,
 * and let the adapter translate the response.
 */
export async function runJsonAdapter(adapter, options) {
  const request = adapter.buildRequest(options);
  const headers = substituteCredential(request.headers, options.key);
  const response = await httpJson({
    label: adapter.label,
    url: joinUrl(options.baseURL, request.url),
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(request.payload),
    signal: options.signal,
  });
  return adapter.parse(response);
}

/** The generic shape every adapter returns: raw items plus its own truncation flag. */
function normalize(items) {
  const sources = [];
  for (const item of items) {
    const source = toRawSource('', item);
    if (source !== undefined) sources.push(source);
  }
  return { sources, truncated: false };
}

// ── Bocha (博查) ────────────────────────────────────────────────────────────────

/**
 * Bocha Web Search: a Chinese, directly reachable aggregator with a plain JSON
 * contract. Auth is a bearer token; results arrive under `data.webPages.value`.
 *
 * Two vendor quirks the adapter must absorb: an HTTP 200 can still carry a
 * non-200 business `code`, and `dateLastCrawled` is stamped with a `Z` that
 * actually means UTC+8, so `datePublished` is the trustworthy date.
 */
export const bocha = {
  id: 'bocha',
  label: 'Bocha',
  defaultBaseURL: 'https://api.bochaai.com',
  defaultCount: 10,
  maxCount: 50,
  buildRequest({ query, count, freshness }) {
    return {
      url: '/v1/web-search',
      headers: { authorization: KEY_PLACEHOLDER.bearer },
      payload: {
        query,
        count,
        // `summary: true` is what makes `summary` — the long snippet — appear.
        summary: true,
        ...(freshness === undefined ? {} : { freshness }),
      },
    };
  },
  parse(response) {
    assertBusinessSuccess('Bocha', response, ['code'], [200, 0]);
    const items = pickArray(response, ['data.webPages.value', 'webPages.value', 'data.value', 'value']) ?? [];
    return normalize(
      items.map((item) => ({
        url: pickString(item, ['url', 'siteUrl', 'link']),
        title: pickString(item, ['name', 'title']),
        snippet: cleanText(stripHtml(pickString(item, ['summary', 'snippet', 'description']))),
        publishedAt: pickString(item, ['datePublished', 'publishedDate']),
      })),
    );
  },
};

/**
 * Reject an application-level failure that arrived inside an HTTP 200 body.
 *
 * @param label - provider name for the error message.
 * @param response - the parsed body.
 * @param paths - candidate paths carrying the business status code.
 * @param accepted - the codes that mean success.
 */
function assertBusinessSuccess(label, response, paths, accepted) {
  const code = pickString(response, paths);
  if (code === undefined) return;
  const numeric = Number(code);
  if (!Number.isFinite(numeric) || accepted.includes(numeric)) return;
  const message = pickString(response, ['msg', 'message', 'error.message']) ?? 'no detail';
  throw new WebError(`${label} rejected the search with code ${numeric}: ${message}`, 'WEB_PROVIDER_ERROR');
}

// ── Tavily ─────────────────────────────────────────────────────────────────────

/**
 * Tavily is built for agent consumption: one POST, ranked results with an
 * inline `content` extract, and an optional synthesized `answer`.
 */
export const tavily = {
  id: 'tavily',
  label: 'Tavily',
  defaultBaseURL: 'https://api.tavily.com',
  defaultCount: 8,
  maxCount: 20,
  buildRequest({ query, count, searchDepth, topic }) {
    return {
      url: '/search',
      headers: { authorization: KEY_PLACEHOLDER.bearer },
      payload: {
        query,
        max_results: count,
        search_depth: searchDepth,
        include_answer: false,
        include_raw_content: false,
        // Documented as opt-in: without it `published_date` never appears.
        include_published_date: true,
        ...(topic === undefined ? {} : { topic }),
      },
    };
  },
  parse(response) {
    const items = pickArray(response, ['results']) ?? [];
    const answer = pickString(response, ['answer']);
    return {
      ...normalize(
        items.map((item) => ({
          url: pickString(item, ['url', 'link']),
          title: pickString(item, ['title', 'name']),
          snippet: cleanText(pickString(item, ['content', 'raw_content', 'snippet'])),
          publishedAt: pickString(item, ['published_date', 'publishedDate', 'date']),
        })),
      ),
      ...(answer === undefined ? {} : { content: answer }),
    };
  },
};

// ── Brave Search ───────────────────────────────────────────────────────────────

/**
 * Brave serves its own index and therefore returns genuinely independent
 * rankings. The web endpoint is a GET with query parameters and two required
 * headers (`X-Subscription-Token` and a JSON `Accept`).
 */
export const brave = {
  id: 'brave',
  label: 'Brave Search',
  defaultBaseURL: 'https://api.search.brave.com',
  defaultCount: 10,
  maxCount: 20,
  buildRequest({ query, count, freshness, country, searchLang, extraSnippets }) {
    const params = new URLSearchParams({ q: query, count: String(count) });
    if (extraSnippets === true) params.set('extra_snippets', 'true');
    if (freshness !== undefined) params.set('freshness', freshness);
    if (country !== undefined) params.set('country', country);
    if (searchLang !== undefined) params.set('search_lang', searchLang);
    return {
      url: `/res/v1/web/search?${params.toString()}`,
      headers: {
        // Brave documents this header name explicitly and warns that
        // `Authorization: Bearer` is wrong for its API.
        'x-subscription-token': KEY_PLACEHOLDER.xSubscriptionToken,
        accept: 'application/json',
      },
      payload: undefined,
    };
  },
  parse(response) {
    const items = pickArray(response, ['web.results', 'results']) ?? [];
    return normalize(
      items.map((item) => {
        const extra = Array.isArray(item.extra_snippets) ? item.extra_snippets.filter((value) => typeof value === 'string') : [];
        const description = pickString(item, ['description']);
        return {
          url: pickString(item, ['url']),
          title: pickString(item, ['title']),
          snippet: cleanText([description, ...extra].filter((value) => typeof value === 'string' && value.length > 0).join(' ')),
          // `page_age` is the ISO timestamp; `age` is only relative prose.
          publishedAt: pickString(item, ['page_age']),
        };
      }),
    );
  },
};

// ── Exa ────────────────────────────────────────────────────────────────────────

/**
 * Exa is a neural/keyword hybrid index aimed at technical and research recall.
 * Results carry `publishedDate` natively; the excerpt comes from `contents`.
 */
export const exa = {
  id: 'exa',
  label: 'Exa',
  defaultBaseURL: 'https://api.exa.ai',
  defaultCount: 8,
  maxCount: 25,
  buildRequest({ query, count, searchType }) {
    return {
      url: '/search',
      headers: { 'x-api-key': KEY_PLACEHOLDER.xApiKey },
      payload: {
        query,
        numResults: count,
        type: searchType,
        contents: { text: { maxCharacters: 1200 } },
      },
    };
  },
  parse(response) {
    const items = pickArray(response, ['results']) ?? [];
    return normalize(
      items.map((item) => {
        const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value) => typeof value === 'string') : [];
        return {
          url: pickString(item, ['url']),
          title: pickString(item, ['title']),
          snippet: cleanText(pickString(item, ['text', 'summary']) ?? highlights.join(' ')),
          publishedAt: pickString(item, ['publishedDate', 'published_date']),
        };
      }),
    );
  },
};

// ── Perplexity ─────────────────────────────────────────────────────────────────

/**
 * Perplexity's dedicated Search API: a plain ranked result list, which is what a
 * search provider should return. The legacy Sonar Chat Completions surface this
 * package originally targeted is deprecated — vendor support ended 2026-09-27 —
 * and its `citations[]` array was deprecated in May 2025 in favour of
 * `search_results[]`, so neither is used here.
 *
 * `/search` returns no prose answer, so `content` stays absent: sources only.
 */
export const perplexity = {
  id: 'perplexity',
  label: 'Perplexity',
  defaultBaseURL: 'https://api.perplexity.ai',
  defaultCount: 10,
  maxCount: 20,
  buildRequest({ query, count, searchType, country }) {
    return {
      url: '/search',
      headers: { authorization: KEY_PLACEHOLDER.bearer },
      payload: {
        query,
        max_results: count,
        ...(searchType === undefined ? {} : { search_type: searchType }),
        ...(country === undefined ? {} : { country }),
      },
    };
  },
  parse(response) {
    const items = pickArray(response, ['results', 'search_results']) ?? [];
    return normalize(
      items.map((item) => ({
        url: pickString(item, ['url']),
        title: pickString(item, ['title']),
        snippet: cleanText(pickString(item, ['snippet', 'text', 'content'])),
        publishedAt: pickString(item, ['date', 'last_updated', 'published_date']),
      })),
    );
  },
};

// ── Zhipu (智谱) ───────────────────────────────────────────────────────────────

/**
 * Zhipu's Web Search API. Three request fields are mandatory — `search_query`,
 * `search_engine` and `search_intent` — and the response array is named
 * `search_result`, singular.
 *
 * Authentication is sent as a plain bearer key. Zhipu's SDKs additionally sign an
 * HS256 JWT for legacy `{id}.{secret}` keys; if a key in that form is rejected
 * with 401, the error message says so explicitly rather than guessing.
 */
export const zhipu = {
  id: 'zhipu',
  label: 'Zhipu Web Search',
  defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
  defaultCount: 10,
  maxCount: 50,
  maxQueryChars: 70,
  buildRequest({ query, count, engine }) {
    return {
      url: '/web_search',
      headers: { authorization: KEY_PLACEHOLDER.bearer },
      payload: {
        search_query: query.length > 70 ? query.slice(0, 70) : query,
        search_engine: engine,
        search_intent: false,
        count,
      },
    };
  },
  parse(response) {
    assertBusinessError('Zhipu', response);
    // `search_result` may be a structured array already, or a JSON string.
    const decoded = decodeNestedJson(response, ['search_result']);
    const items = pickArray(decoded, ['search_result', 'search_results', 'results']) ?? [];
    return normalize(
      items.map((item) => ({
        url: pickString(item, ['link', 'url']),
        title: pickString(item, ['title', 'name']),
        snippet: cleanText(stripHtml(pickString(item, ['content', 'snippet', 'summary']))),
        // Documented to arrive as an empty string when unknown.
        publishedAt: pickString(item, ['publish_date', 'publishedDate', 'date']),
      })),
    );
  },
};

/** Zhipu reports business failures as `{ error: { code, message } }` inside HTTP 200. */
function assertBusinessError(label, response) {
  const code = pickString(response, ['error.code']);
  if (code === undefined) return;
  const message = pickString(response, ['error.message']) ?? 'no detail';
  throw new WebError(`${label} rejected the search with error ${code}: ${message}`, 'WEB_PROVIDER_ERROR');
}

/** Replace a JSON-encoded string field with its parsed value when it holds JSON. */
function decodeNestedJson(response, paths) {
  for (const path of paths) {
    const value = readPath(response, path);
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      return { ...response, [path]: JSON.parse(trimmed) };
    } catch {
      return response;
    }
  }
  return response;
}

// ── MiniMax ────────────────────────────────────────────────────────────────────

/**
 * MiniMax publishes no standalone search endpoint; web search is a server-side
 * tool on its chat surfaces. This adapter uses the Anthropic-compatible surface
 * and reads the structured `web_search_tool_result` block, so the result list is
 * real retrieved data rather than prose scraped out of a reply.
 *
 * Consequences of that shape, stated plainly: the model decides how many pages
 * to retrieve, so `count` is advisory here and the seam's `maxResults` does the
 * real capping; and one search costs a full model turn.
 */
export const minimax = {
  id: 'minimax',
  label: 'MiniMax Web Search',
  defaultBaseURL: 'https://api.minimax.chat/anthropic/v1',
  defaultCount: 10,
  maxCount: 50,
  defaultModel: 'MiniMax-Text-01',
  buildRequest({ query, model }) {
    return {
      url: '/messages',
      headers: { 'x-api-key': KEY_PLACEHOLDER.xApiKey, 'anthropic-version': '2023-06-01' },
      payload: {
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    };
  },
  parse(response) {
    const blocks = Array.isArray(response?.content) ? response.content : [];
    const items = [];
    for (const block of blocks) {
      if (block?.type !== 'web_search_tool_result') continue;
      for (const item of Array.isArray(block.content) ? block.content : []) {
        if (item?.type === 'web_search_result') items.push(item);
      }
    }
    const answer = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim();
    return {
      ...normalize(
        items.map((item) => ({
          url: pickString(item, ['url']),
          title: pickString(item, ['title']),
          snippet: cleanText(pickString(item, ['content', 'snippet', 'text'])),
          publishedAt: pickString(item, ['page_age', 'published_date']),
        })),
      ),
      ...(answer.length === 0 ? {} : { content: cleanText(answer, 2000) }),
    };
  },
};

// ── SearXNG (self-hosted meta search) ─────────────────────────────────────────

/**
 * SearXNG aggregates other engines on your own instance: no vendor account, no
 * ads, fully auditable. The instance must allow `format=json` (a documented
 * `settings.yml` change on recent releases).
 */
export const searxng = {
  id: 'searxng',
  label: 'SearXNG',
  defaultBaseURL: 'http://127.0.0.1:8080',
  defaultCount: 10,
  maxCount: 30,
  async search({ baseURL, query, count, engines, language, timeRange, signal }) {
    const params = new URLSearchParams({ q: query, format: 'json', safesearch: '0' });
    if (language !== undefined) params.set('language', language);
    if (timeRange !== undefined) params.set('time_range', timeRange);
    if (engines !== undefined && engines.length > 0) params.set('engines', engines.join(','));
    const response = await httpJson({
      label: 'SearXNG',
      url: joinUrl(baseURL, `/search?${params.toString()}`),
      headers: { accept: 'application/json' },
      signal,
    });
    return parseSearxngResults(response, count);
  },
};

/** Translate a SearXNG JSON response, truncating when the instance over-returns. */
export function parseSearxngResults(response, count) {
  const items = pickArray(response, ['results']) ?? [];
  const limited = typeof count === 'number' && count > 0 ? items.slice(0, count) : items;
  return {
    ...normalize(
      limited.map((item) => ({
        url: pickString(item, ['url']),
        title: pickString(item, ['title']),
        snippet: cleanText(pickString(item, ['content', 'snippet'])),
        publishedAt: pickString(item, ['publishedDate', 'published_date']),
      })),
    ),
    ...(items.length > limited.length ? { truncated: true } : {}),
  };
}

// ── DuckDuckGo (keyless fallback) ─────────────────────────────────────────────

/**
 * DuckDuckGo's no-JavaScript HTML endpoint is the only server-side surface that
 * works without a browser or a key, and it is explicitly undocumented: there is
 * no official web-search API, and the `d.js` JSON endpoint cannot serve page one
 * without a `vqd` harvested from an HTML response.
 *
 * Two behaviours make this adapter different from every other one here:
 *   - redirects are mandatory (the result hrefs are `/l/?uddg=` wrappers, and
 *     some hosts answer with a legitimate 303), so `redirect: follow` is used;
 *   - a block arrives as HTTP 200 with a challenge form in the body, so the body
 *     itself has to be inspected before it is parsed as results.
 *
 * Treat this as a best-effort fallback: DuckDuckGo rate-limits by IP, ships no
 * contract, and is unreachable from some networks including mainland China.
 */
export const ddg = {
  id: 'ddg',
  label: 'DuckDuckGo',
  defaultBaseURL: 'https://html.duckduckgo.com',
  defaultCount: 10,
  maxCount: 30,
  /** Browser-like identity: the endpoint rejects clients that look like scripts. */
  browserUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  async search({ baseURL, query, count, region, signal }) {
    const body = new URLSearchParams({ q: query, b: '', kl: region ?? 'wt-wt' });
    const html = await httpText({
      label: 'DuckDuckGo',
      url: joinUrl(baseURL, '/html/'),
      method: 'POST',
      // The result hrefs and (on some hosts) the search itself are redirects.
      redirect: 'follow',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: `${joinUrl(baseURL, '/')}/`,
        'user-agent': ddg.browserUserAgent,
      },
      body: body.toString(),
      signal,
    });
    assertNotChallenged(html);
    const items = parseDuckDuckGoHtml(html).slice(0, count);
    return normalize(items);
  },
};

/** Detect DuckDuckGo's bot challenge, which arrives with a 200 status. */
function assertNotChallenged(html) {
  if (typeof html !== 'string') return;
  if (/id="challenge-form"|anomaly-modal|Unfortunately, bots use DuckDuckGo too/iu.test(html)) {
    throw new WebError(
      'DuckDuckGo returned a bot challenge instead of results. Its HTML endpoint is undocumented and rate-limits by address; wait before retrying, raise the search count, or select a different search provider under Settings > Plugins > Plugin configuration > Web search.',
      'WEB_PROVIDER_ERROR',
    );
  }
}

/** Parse the DuckDuckGo HTML result list into raw items. */
export function parseDuckDuckGoHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const items = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/iu).slice(1);
  for (const block of blocks) {
    const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu.exec(block);
    if (anchor === null) continue;
    const url = unwrapRedirectUrl(decodeEntitiesInAttribute(anchor[1]));
    if (url === undefined) continue;
    const title = cleanText(stripHtml(anchor[2]));
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/iu.exec(block)
      ?? /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(block);
    const snippet = snippetMatch === null ? undefined : cleanText(stripHtml(snippetMatch[1]));
    items.push({ url, title, snippet });
  }
  return items;
}

/** Attribute values keep their entities until after the redirect is unwrapped. */
function decodeEntitiesInAttribute(value) {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>');
}

/** Reject an unusable provider configuration before any request leaves the process. */
export function assertBaseURL(label, baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0 || !URL.canParse(baseURL)) {
    throw new Error(`${label} search base URL ${JSON.stringify(baseURL)} is not a parseable URL`);
  }
  return baseURL;
}

/** The credential-missing error for a provider, phrased for the conversation model. */
export function requireCredential(label, envVar, key) {
  if (typeof key !== 'string' || key.length === 0) throw missingCredentialError(label, envVar);
  return key;
}

export { normalize, joinUrl };
