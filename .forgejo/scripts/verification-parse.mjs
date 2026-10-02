// Extract the URL npm tells the user to open, from whatever npm printed.
//
// npm's wording differs per registry and per failure: the hosted registry emits a
// modern `auth/cli/<uuid>` challenge, a `401` body can carry an `authUrl` field,
// and a custom/internal registry only appears in a `Log in on <registry>` notice.
// The relay must forward *npm's own* URL (internal registry included), never a
// made-up npmjs.com page.
export const VERIFICATION_PATTERNS = [
  { kind: 'npm-2fa', re: /"authUrl"\s*:\s*"(https?:[^"]+)"/g },
{ kind: 'npm-2fa', re: /https:\/\/[^\s'"<>()\[\]*`\x00-\x1f]*\/auth\/cli\/[^\s'"<>()\[\]*`\x00-\x1f]*/g },
{ kind: 'npm-2fa', re: /https:\/\/www\.npmjs\.com\/auth\/cli\/[^\s'"<>()\[\]*`\x00-\x1f]+/g },
{ kind: 'npm-login-required', re: /https:\/\/www\.npmjs\.com\/(?:login|signup)[^\s'"<>()\[\]*`\x00-\x1f]*/g },
{ kind: 'npm-login-required', re: /"loginUrl"\s*:\s*"(https?:[^"]+)"/g },
{ kind: 'npm-login-required', re: /https?:\/\/[^\s'"<>()\[\]*`\x00-\x1f]+\/(?:login|signin|weblogin|web-login|auth)[^\s'"<>()\[\]*`\x00-\x1f]*/g },
];

/**
* `Log in on <registry>` / `Log in at <url>` style notices: take the token after
* the keyword, so a bare registry origin (no /login path) is still forwarded.
*/
/**
* `Log in on <registry>` / `Log in at <url>` notices. npm writes "Log in" as
* two words, so both spellings are accepted, and the token after the keyword is
* taken verbatim: a bare registry origin (no /login path) is still a usable URL.
*/
/**
* `Log in on <registry>` / `Log in at <url>` notices. npm writes "Log in" as
* TWO words, which a token comparison misses — hence the joined-text match. The
* token after the preposition is taken verbatim, so a bare registry origin (with
  * no /login path) is still a usable URL.
*/
export function registryLoginUrl(text) {
  const cleaned = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
    const match = /(?:^|\s)log\s*[-]?\s*in\s+(?:on|at|to|using|via)\s+(\S+)/i.exec(cleaned);
    if (!match) return '';
    const candidate = match[1].replace(/[),.;'"]+$/, '');
    return /^https?:\/\//.test(candidate) ? candidate : '';
  }

  export function extractVerificationCode(text) {
    const labelled = /one[\s-]?tim(?:e|\s)?\s*password\s*(?:is)?\s*[:：]?\s*([0-9]{6,8})\b/i.exec(text || '');
    if (labelled) return labelled[1];
    const afterPrompt = /(?:enter otp|otp)\s*[:：]\s*([0-9]{6,8})\b/i.exec(text || '');
    if (afterPrompt) return afterPrompt[1];
    const inQuery = /[?&]code=([0-9]{6,8})\b/.exec(text || '');
    if (inQuery) return inQuery[1];
    return '';
  }

  export function parseNpmAuthOutput(text) {
    const source = String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r/g, '');
      const candidates = [];
      const push = (url, kind, priority) => {
        if (!url || !/^https?:\/\//.test(url)) return;
          if (candidates.some((entry) => entry.url === url)) return;
          candidates.push({ url, kind, priority });
        };

        for (const pattern of VERIFICATION_PATTERNS) {
          for (const match of source.matchAll(pattern.re)) {
            // `"authUrl": "…"` / `"loginUrl": "…"` capture the URL in group 1; prose
            // patterns match the whole URL.
            push(match[1] || match[0], pattern.kind, pattern.kind === 'npm-2fa' ? 10 : 20);
          }
        }
        // A /login path is a stronger signal than a bare registry origin.
        for (const candidate of candidates) {
          if (/\/(?:login|signin|weblogin|web-login|auth)/i.test(candidate.url)) candidate.priority -= 5;
          if (candidate.url.includes('/auth/cli/')) candidate.priority -= 5;
        }
        const fromNotice = registryLoginUrl(source);
        if (fromNotice) push(fromNotice, 'npm-login-required', 30);

        candidates.sort((a, b) => a.priority - b.priority);
        const chosen = candidates[0] || { url: '', kind: '' };
        const code = extractVerificationCode(source);
        const mentionsSecondFactor =
        Boolean(code) ||
        chosen.kind === 'npm-2fa' ||
        chosen.url.includes('/auth/cli/') ||
        chosen.url.includes('/login/') ||
        chosen.url.includes('/auth/') ||
        /\beotp\b|one[\s-]?time password|verification code/i.test(source);
        return {
          url: chosen.url,
          code,
          kind: chosen.url ? (mentionsSecondFactor ? 'npm-2fa' : 'npm-login-required') : '',
        };
      }
