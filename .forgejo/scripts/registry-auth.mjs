// registry-auth.mjs — read the authorisation link out of npm's output.
//
// npm drives the whole token-free flow itself when it has a terminal:
//   * `npm login --auth-type=web` prints the `loginUrl` from `POST /-/v1/login`
//     and polls `doneUrl` until the browser flow finishes;
//   * a write that needs a second factor fails with `EOTP`, and npm's own
//     `otplease` prints `err.body.authUrl`, polls `doneUrl` and retries with the
//     one-time token.
//
// The script's only job is therefore to notice the URL as it is printed and
// relay it before npm gives up. `--json` is deliberately NOT used: `outputMsg`
// buffers the URL into the JSON blob instead of printing it, which would hide
// the link until npm had already exited. The accepted shapes live in
// notify-lib.mjs (`AUTH_URL_PATTERNS` / `isAuthUrl`) so the streamed link and
// the delivered link can never disagree.

import { AUTH_URL_COMPLETE_PATTERNS, AUTH_URL_PATTERNS } from './notify-lib.mjs';

/**
 * The most specific authorisation URL printed in `text`.
 *
 * A bare registry origin is never returned: `npm notice Log in on
 * https://registry.npmjs.org/` must not shadow the one-time link that follows.
 * The `doneUrl` of an OTP challenge (`…/-/auth/done/<id>`) does not match
 * either — opening it does nothing for the reader.
 */
export function findAuthUrl(text) {
  const source = String(text || '');
  for (const pattern of AUTH_URL_PATTERNS) {
    const found = [...source.matchAll(pattern)]
      .map((match) => match[0].replace(/[),.;'"]+$/, ''))
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
  for (const pattern of AUTH_URL_COMPLETE_PATTERNS) {
    const found = [...source.matchAll(pattern)]
      // A trailing line break is conclusive; a bare buffer end is not.
      .filter((match) => match[2] !== '' || source.endsWith('\n') || source.endsWith('\r'))
      .map((match) => match[1].replace(/[),.;'"]+$/, ''))
      .filter(Boolean);
    if (found.length > 0) return found[found.length - 1];
  }
  return '';
}

/**
 * Did npm refuse because it has no terminal AND did not expose a URL?
 *
 * Without a TTY npm's `otplease` rethrows the raw `EOTP`/`E401`, so there is
 * nothing to relay and waiting would only burn the budget — the caller should
 * explain that `script(1)` is missing, that npm is older than 10.9, or that the
 * registry only accepts a typed code.
 */
export function nonInteractiveRefusal(text) {
  const source = String(text || '');
  if (!/\bEOTP\b|one-time pass|NON_INTERACTIVE|not running in an interactive terminal/i.test(source)) return '';
  return findAuthUrl(source) ? '' : 'otp';
}

/** npm fell back to an interactive username prompt: web login is not available. */
export function fellBackToPasswordPrompt(text) {
  return /(^|\n)\s*(Username|Password)\s*:/i.test(String(text || ''));
}
