/**
 * Shared plumbing for every provider adapter in this package.
 *
 * Design commitments:
 * - One HTTP path (`httpJson` / `httpText`) so redirect rejection, cancellation
 *   mapping, error shaping and the User-Agent header are defined exactly once.
 * - Adapters only translate a provider's wire response into `RawSource[]`; the
 *   search entry point owns deduplication, the result cap and `truncated`.
 * - No dependency beyond the Harness peer packages the profile already mounts.
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** Attribution header sent on every request. Bump with the package version. */
export const USER_AGENT = 'dsh-web-search-multi/0.1.0';

/** Redirects are refused rather than followed, matching the shipped DeepSeek provider. */
export const REDIRECT_POLICY = 'error';

/** A provider-neutral result item; every field except `url` is optional by wire reality. */
export const RAW_SOURCE_FIELDS = ['url', 'title', 'snippet', 'publishedAt'];

/** Stable error codes this package throws. */
export const ERROR_CODES = {
  aborted: 'WEB_ABORTED',
  providerError: 'WEB_PROVIDER_ERROR',
  credentialMissing: 'WEB_PROVIDER_CREDENTIAL_MISSING',
};

/** True for DeepSeek/Harness request limits that are safe to send upstream. */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** True for a fetch or `AbortSignal` abort, surfaced as `WEB_ABORTED`. */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Throw the stable cancellation error when the caller already aborted. */
export function throwIfAborted(signal, label) {
  if (signal?.aborted === true) throw abortedError(signal, label);
}

/** Build the stable cancellation error while retaining the caller's reason. */
export function abortedError(signal, label) {
  return new WebError(`${label} search aborted`, ERROR_CODES.aborted, {
    cause: signal?.aborted === true ? signal.reason : undefined,
  });
}

/**
 * Describe an unrecoverable provider-side failure, naming the provider and the
 * settings path a user would use to fix a credential or endpoint problem.
 */
export function providerError(label, message, cause) {
  return new WebError(`${label} search failed: ${message}`, ERROR_CODES.providerError, cause === undefined ? undefined : { cause });
}

/** The missing-credential error, phrased so the model can tell the user what to set. */
export function missingCredentialError(label, envVar) {
  return new WebError(
    `${label} search has no API key for "${envVar}"; store it through the credentials service (the Web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the web-search-multi config. To use a keyless source instead, point Settings > Plugins > Plugin configuration > Web search at one of: dsh-dd, dsh-searxng.`,
    ERROR_CODES.credentialMissing,
  );
}

/**
 * Perform one JSON request. Redirects are refused, cancellation maps to
 * `WEB_ABORTED`, and every other failure becomes a `WEB_PROVIDER_ERROR` that
 * names the provider and endpoint.
 *
 * @param options - label, method, url, headers, optional body, redirect policy and signal.
 * @returns the parsed JSON body.
 */
export async function httpJson(options) {
  const text = await httpText(options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw providerError(options.label, `returned an unprocessable JSON body from ${options.url}`, error);
  }
}

/**
 * Perform one request and return its body as text.
 *
 * Redirects are refused by default: a search backend that redirects is either
 * misconfigured or being intercepted, and following it silently would send the
 * query somewhere the operator did not choose. The one documented exception is
 * DuckDuckGo, whose every answer is a legitimate hop.
 *
 * @param options - label, url, method, headers, optional body, redirect policy and signal.
 * @returns the response body as text.
 */
export async function httpText(options) {
  const { label, url, method = 'GET', headers = {}, body, signal, redirect = REDIRECT_POLICY } = options;
  throwIfAborted(signal, label);
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, label);
    throw providerError(label, `request to ${url} failed: ${String(error)}`, error);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, label);
    throw providerError(label, `could not read the response from ${url}: ${String(error)}`, error);
  }
  if (!response.ok) {
    throw providerError(label, `HTTP ${response.status} from ${url}${detailSuffix(text)}`);
  }
  return text;
}

/** Append a short, single-line upstream error detail when the body carries one. */
function detailSuffix(text) {
  const detail = extractErrorDetail(text);
  return detail === undefined ? '' : `: ${detail}`;
}

/** Best-effort extraction of a human-readable error detail from a failed response body. */
export function extractErrorDetail(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (text.length > 4096) return undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = parsed?.error?.message ?? parsed?.error?.code ?? parsed?.error ?? parsed?.message ?? parsed?.Message ?? parsed?.msg;
      if (typeof candidate === 'string' && candidate.length > 0) return oneLine(candidate);
    } catch {
      // Fall through to the raw-text path below.
    }
  }
  if (/<html/i.test(trimmed)) return undefined;
  return oneLine(trimmed);
}

/** Collapse any whitespace run into a single space so error text stays one line. */
function oneLine(value) {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

/** Read the first present, non-empty string among a list of candidate paths. */
export function pickString(object, paths) {
  for (const path of paths) {
    const value = readPath(object, path);
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Resolve a dotted path (`a.b.0.c`) against a parsed JSON value. */
export function readPath(object, path) {
  let current = object;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/** Find the first array reachable at any of the candidate paths. */
export function pickArray(object, paths) {
  for (const path of paths) {
    const value = readPath(object, path);
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

/** Normalize one adapter-produced item, dropping unusable entries. */
export function toRawSource(label, item) {
  if (item === null || typeof item !== 'object') return undefined;
  const url = typeof item.url === 'string' ? item.url.trim() : '';
  if (url.length === 0) return undefined;
  const raw = {
    url,
    ...(cleanText(item.title) === undefined ? {} : { title: cleanText(item.title) }),
    ...(cleanText(item.snippet) === undefined ? {} : { snippet: cleanText(item.snippet) }),
    ...(cleanText(item.publishedAt) === undefined ? {} : { publishedAt: cleanText(item.publishedAt) }),
  };
  void label;
  return raw;
}

/**
 * Trim and bound one piece of provider-controlled text. The provider contract
 * keeps snippets short: results are resent to the model on every turn.
 */
export function cleanText(value, max = 1000) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Strip HTML tags and decode the handful of entities a search result actually uses. */
export function stripHtml(value) {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ');
  return decodeEntities(text);
}

/** Decode the named and numeric HTML entities that appear in search result markup. */
export function decodeEntities(value) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => safeFromCodePoint(Number.parseInt(code, 16)));
}

/** Convert a numeric character reference, tolerating out-of-range values. */
function safeFromCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Extract the destination of a DuckDuckGo/HTML redirect wrapper, which encodes
 * the real target in a `uddg` query parameter.
 */
export function unwrapRedirectUrl(href) {
  if (typeof href !== 'string' || href.length === 0) return undefined;
  const normalized = href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    if (target !== null && target.length > 0) return decodeURIComponent(target);
    return parsed.toString();
  } catch {
    return undefined;
  }
}
