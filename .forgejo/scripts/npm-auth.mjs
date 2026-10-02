// npm-auth.mjs — drive npm's web authorisation without extra packages.
//
// npm exposes the whole flow to a script when it has no TTY:
//   * `npm login --auth-type=web` prints the `loginUrl` unconditionally and
//     polls until the browser flow completes;
//   * a write that needs a second factor fails with EOTP, and since npm 11.9.0
//     the error (and `--json` output) carries `authUrl` + `doneUrl`;
//   * `doneUrl` is a plain endpoint: 202 means "keep waiting" (respect
//     `retry-after`), 200 returns `{ token }`.
//
// That means no PTY (`script(1)`) and no extra package is required — the PTY
// path stays as a fallback for older npm builds only.

/** The npm log prefix every line of a block shares ("npm error ", "npm notice "). */
function sharedLogPrefix(lines) {
  const prefixes = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^(npm\s+\w+\s+)/.exec(line)?.[1] || '');
  if (prefixes.length === 0) return '';
  const first = prefixes[0];
  if (!first) return '';
  return prefixes.every((prefix) => prefix === first) ? first : '';
}

/** Remove npm's log prefix ("npm error ") from one line, if it has one. */
export function stripLogPrefix(line) {
  return String(line).replace(/^npm\s+\w+\s+/, '');
}

/** Pull the last parseable JSON object out of npm's log-wrapped output. */
export function parseLastJsonObject(text) {
  // npm prefixes every line of the block ("npm error "), so strip that first and
  // then treat a line that is exactly `{` as the start of a candidate object.
  const lines = String(text || '').split('\n').map(stripLogPrefix);
  let best = null;
  // Compact single-line objects (`{"token":"…"}`) are not split across lines.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') best = parsed;
    } catch {
      // Not JSON; the multi-line scan below may still find something.
    }
  }
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== '{') continue;
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end].trim() !== '}') continue;
      try {
        const parsed = JSON.parse(lines.slice(start, end + 1).join('\n'));
        if (parsed && typeof parsed === 'object') best = parsed;
      } catch {
        // Try a later closing brace.
      }
    }
  }
  return best;
}

/**
 * Extract the authorisation URLs from npm output, preferring npm's structured
 * JSON and falling back to the URLs printed in prose. `authUrl` is what the human
 * opens; `doneUrl` is what a script polls for the resulting token.
 */
export function extractAuthFlow(text, { parseJson = parseLastJsonObject } = {}) {
  const source = String(text || '');
  const parsed = parseJson(source) || {};
  const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;

  const firstUrl = (...values) => values.find((value) => typeof value === 'string' && /^https?:\/\//.test(value)) || '';

  let authUrl = firstUrl(error.authUrl, error.loginUrl, error.url);
  let doneUrl = firstUrl(error.doneUrl, error.done);
  let loginUrl = firstUrl(error.loginUrl);

  // Prose fallback. NOTE: npm prints "Log in on https://registry.npmjs.org/"
  // immediately before the real link, and that registry origin is useless to the
  // reader — so only URLs that look like an authorisation endpoint are accepted,
  // and the most specific one wins.
  if (!authUrl) authUrl = findAuthUrl(source);
  if (!authUrl) {
    // Last resort: the text after "Login at:" / "Log in on", but never a bare
    // registry origin.
    const match = /(?:log\s*in\s+(?:at|on)|open\s+(?:this\s+)?(?:url|link)[^\n]*?)\s*:?\s*(https?:\/\/\S+)/i.exec(source);
    if (match) {
      const candidate = match[1].replace(/[),.;'"\]]+$/, '');
      if (!/^https?:\/\/[^/]+\/?$/.test(candidate)) authUrl = candidate;
    }
  }
  if (!doneUrl) {
    const match = /https?:\/\/\S*\/(?:auth\/done|-\/v1\/done)[^\s'"<>()[\]]*/.exec(source);
    if (match) doneUrl = match[0];
  }
  if (!loginUrl) loginUrl = authUrl;

  const token = typeof parsed.token === 'string' ? parsed.token : '';
  const code = typeof error.code === 'string' ? error.code : '';
  return { authUrl, doneUrl, loginUrl, token, code, raw: parsed };
}

/**
 * The most specific authorisation URL printed in `text`.
 *
 * Ranked so that npm's own one-time link beats a generic login page, and a bare
 * registry origin is never returned: `npm notice Log in on
 * https://registry.npmjs.org/` must not shadow the `Login at:` URL that follows.
 */
export function findAuthUrl(text) {
  const source = String(text || '');
  const patterns = [
    // npm's one-time verification links, and the hosted page carrying the same
    // session (https://www.npmjs.com/login?next=/login/cli/<uuid>). A generic
    // login page is not accepted: only session-carrying links lead anywhere.
    /(https?:\/\/\S+\/(?:auth|login)\/cli\/[^\s'"]*)/g,
    /(https?:\/\/\S+\/[^\s'"?]*\?[^\s'"]*next=[^&#\s]*\/login\/cli\/[^\s'"]*)/g,
  ];
  for (const pattern of patterns) {
    const found = [...source.matchAll(pattern)]
      .map((match) => match[1].replace(/[),.;'"]+$/, ''))
      .filter(Boolean);
    if (found.length > 0) return found[found.length - 1];
  }
  return '';
}

/**
 * Like {@link findAuthUrl}, but only returns a URL that is known to be complete.
 *
 * Output arrives in chunks, so a URL can be split at any point. A candidate is
 * considered final only when it is followed by whitespace/a quote (or the buffer
 * fell exactly on a line end), which means the reader will not be handed a
 * truncated link that then cannot be corrected — `announce` dedupes by URL.
 */
export function findCompleteAuthUrl(text) {
  const source = String(text || '');
  const patterns = [
    /(https?:\/\/\S+\/(?:auth|login)\/cli\/[^\s'"]*)([\s'"]|$)/g,
    /(https?:\/\/\S+\/[^\s'"?]*\?[^\s'"]*next=[^&#\s]*\/login\/cli\/[^\s'"]*)([\s'"]|$)/g,
  ];
  for (const pattern of patterns) {
    const found = [...source.matchAll(pattern)]
      // A trailing line break is conclusive; a bare buffer end is not.
      .filter((match) => match[2] !== '' || text.endsWith('\n') || text.endsWith('\r'))
      .map((match) => match[1].replace(/[),.;'"]+$/, ''))
      .filter(Boolean);
    if (found.length > 0) return found[found.length - 1];
  }
  return '';
}

/** npm fell back to an interactive username prompt: web login is not available. */
export function fellBackToPasswordPrompt(text) {
  return /(^|\n)\s*(Username|Password)\s*:/i.test(String(text || ''));
}

/**
 * Poll `doneUrl` until the browser flow finishes.
 * 202 = still waiting (wait `retry-after`), 200 = `{ token }`.
 */
export async function pollDoneUrl(doneUrl, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  timeoutMs = 15 * 60_000,
  onWait = () => {},
  maxPolls = Infinity,
} = {}) {
  if (!doneUrl) throw new Error('no doneUrl to poll');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const deadline = Date.now() + timeoutMs;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    if (Date.now() >= deadline) throw new Error(`等待授权超时（${Math.round(timeoutMs / 1000)}s）`);
    let response;
    try {
      response = await fetchImpl(doneUrl, { headers: { accept: 'application/json' } });
    } catch (error) {
      onWait({ poll, status: 0, retryAfterMs: 2000, error: error.message });
      await sleep(2000);
      continue;
    }
    if (response.status === 200) {
      const body = await response.json().catch(() => ({}));
      const token = typeof body?.token === 'string' ? body.token : '';
      if (!token) throw new Error('doneUrl 返回 200 但没有 token');
      return { token, polls: poll };
    }
    if (response.status !== 202) {
      const text = await response.text().catch(() => '');
      throw new Error(`doneUrl 返回 HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const retryAfterSeconds = Number(response.headers?.get?.('retry-after') || 1);
    const waitMs = Math.min(
      Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 1000, 250),
      Math.max(250, deadline - Date.now()),
    );
    onWait({ poll, status: 202, retryAfterMs: waitMs });
    await sleep(waitMs);
  }
  throw new Error('doneUrl 轮询次数用尽');
}

/**
 * Choose how to run npm: a pipe is enough on npm >= 11.9.0 (the URLs are
 * exposed), and only older builds need a PTY to see them.
 */
export function needsPty({ npmVersion = '', hasPty = false, ptyForced = false } = {}) {
  if (ptyForced) return true;
  const [major, minor] = String(npmVersion)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return hasPty; // unknown version: keep the old behaviour
  if (major > 11) return false;
  if (major === 11 && Number.isFinite(minor) && minor >= 9) return false;
  return hasPty;
}
