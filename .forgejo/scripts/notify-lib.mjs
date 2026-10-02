// notify-lib — canonical webhook payload/delivery logic for the npm-publish Action.
//
// This is a normal shipped file: the workflow runs the sibling programs with
// `node "$forgejo_dir/scripts/<name>.mjs"` and each imports './notify-lib.mjs'.
// Keeping the logic in files instead of inside YAML heredocs means the test
// suite exercises the exact same source the runner uses.
//
// Payload contract (v1): the top level always carries a non-empty `title` (the
// repository name) and a `url` holding the authentication link npm printed. A
// notice is only sent when such a link exists — never a run page or registry
// origin — because the receiving message pusher extracts {"title","url"}.
//
// The destination is supplied by configuration only: this file contains no
// webhook address, so a copy of the Action never carries one repository's
// endpoint into another repository.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA = 'dsh.release.notify/v1';
export const DEFAULT_TITLE = 'npm-publish';

export const PHASES = new Set([
  'starting',
  'publishing',
  'npm-2fa',
  'npm-login-required',
  'published',
  'already-published',
  'failed',
]);

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Read an optional value from the environment: whitespace-only and *unexpanded*
 * expression text count as "not provided".
 *
 * Forgejo does not always substitute `${{ inputs.x }}` / `${{ vars.x }}` in the
 * job environment when the workflow was triggered by an event that defines no
 * inputs (a tag push). The literal text then reaches the programs, and treating
 * it as a real value breaks releases with errors like
 * "无法从 tag 解析出合法版本号：${{ inputs.version }}".
 */
export function readOptional(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.includes('${{') ? '' : text;
}

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);
}

export function repoTitle(repo, repoOnly = false) {
  const value = String(repo || '').replace(/\/+$/, '');
  if (!value) return DEFAULT_TITLE;
  return repoOnly ? value.split('/').pop() : value;
}

export function semverParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] };
}

/** Strict semantic-version precedence; exits 0 in release.sh terms when a > b. */
export function semverGt(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  if (!left || !right) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  if (left.patch !== right.patch) return left.patch > right.patch;
  if (left.pre === undefined && right.pre === undefined) return false;
  if (left.pre === undefined) return true;
  if (right.pre === undefined) return false;
  const aParts = left.pre.split('.');
  const bParts = right.pre.split('.');
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const x = aParts[index];
    const y = bParts[index];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y);
    } else if (xNumeric) {
      return false;
    } else if (yNumeric) {
      return true;
    } else if (x !== y) {
      return x > y;
    }
  }
  return false;
}

export function phaseForPhaseArg(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'starting';
  if (PHASES.has(raw)) return raw;
  if (raw === '2fa' || raw === 'otp' || raw === 'chrome-2fa') return 'npm-2fa';
  if (raw === 'login' || raw === 'npm-login') return 'npm-login-required';
  if (raw === 'fail' || raw === 'error') return 'failed';
  if (raw === 'done' || raw === 'success') return 'published';
  return raw;
}

export function errorSummary(error) {
  if (!error) return 'unknown error';
  if (error.cause && error.cause.message) return `${error.message}（${error.cause.message}）`;
  return error.message || String(error);
}

function phaseMessage(phase, core = {}) {
  const target = `${core.name || core.package || 'package'}@${core.version || '?'}`;
  switch (phase) {
    case 'starting':
      return `准备发布 ${target}`;
    case 'publishing':
      return `开始发布 ${target}（dist-tag=${core.distTag || 'latest'}）`;
    case 'npm-2fa':
      return `npm 要求二次验证：${target}`;
    case 'npm-login-required':
      return `npm 要求登录：${target}`;
    case 'published':
      return `已发布 ${target}`;
    case 'already-published':
      return `${target} 已存在于 registry，本次为空操作`;
    case 'failed':
      return `发布失败：${target}`;
    default:
      return `发布状态 ${phase}：${target}`;
  }
}

/**
 * The payload's `url` is the authentication link and nothing else. Falling back to
 * the run page (or a registry origin) would send the reader somewhere useless, so
 * an empty string is returned instead and `deliver` stays silent.
 */
export function resolvePayloadUrl({ auth } = {}) {
  const candidate = typeof auth === 'string' ? auth : auth?.url;
  if (isHttpUrl(candidate)) return candidate;
  if (typeof auth === 'string' && auth.trim()) {
    throw new Error(`auth url must be an http(s) URL: ${auth.trim()}`);
  }
  return '';
}

/** Notifications that only make sense with a real authentication link. */
export const AUTH_PHASES = new Set(['npm-login-required', 'npm-2fa', 'npm-login']);

/**
 * Is this a URL a human can authenticate with? Requires an authentication path,
 * so a bare registry origin (https://registry.npmjs.org) and a repository page
 * (https://git.example.com/owner/repo/actions/runs/11) do not qualify.
 */
/**
 * Is this a link the reader can actually finish a login or a second factor with?
 *
 * Only npm's one-time session links qualify: `/auth/cli/<uuid>`, or the hosted
 * page that carries the same session (`/login?next=/login/cli/<uuid>`). A generic
 * `/-/web-login` page or a bare login/signin route is deliberately rejected — the
 * Action promises never to hand the reader a page that leads nowhere.
 */
export function isAuthUrl(value) {
  if (!isHttpUrl(value)) return false;
  if (/\/(?:auth|login)\/cli\/[^/?#\s]+/i.test(value)) return true;
  return /[?&]next=[^&#\s]*\/login\/cli\//i.test(value);
}

/**
 * Every notice is only worth sending with a real authentication link. A missing
 * link is a reason to stay silent rather than to substitute the run page, the
 * registry origin or a package page — those send the reader nowhere useful.
 */
export function shouldSend(payload) {
  return isAuthUrl(payload.url);
}

export function buildPayload({
  phase = 'starting',
  core = {},
  auth,
  title,
  summary,
  reason,
  outputTail,
  package: packageName,
  now,
  requestId,
  env = process.env,
} = {}) {
  const resolvedPhase = phaseForPhaseArg(phase);
  const repoOnly = String(env.NOTIFY_TITLE_REPO_ONLY || '').toLowerCase() === 'true';
  const repo = core.repo || env.GITHUB_REPOSITORY || '';
  const resolvedTitle = title || repoTitle(repo, repoOnly);
  const normalizedAuth = auth && typeof auth === 'object' ? auth : auth ? { url: auth } : undefined;
  const url = resolvePayloadUrl({ auth: normalizedAuth });
  const version = core.version || '';
  const packageValue = packageName || core.name || core.package || '';
  const summaryText =
    summary ||
    [phaseMessage(resolvedPhase, { ...core, name: packageValue }), reason, outputTail ? `原始输出：${outputTail}` : '']
      .filter(Boolean)
      .join(' · ');

  return {
    title: resolvedTitle,
    url,
    schema: SCHEMA,
    event: 'release',
    phase: resolvedPhase,
    repository: repo,
    version,
    package: packageValue,
    dist_tag: core.distTag || '',
    prerelease: Boolean(core.prerelease),
    dry_run: Boolean(core.dryRun),
    summary: summaryText,
    auth: {
      kind: normalizedAuth?.kind || '',
      url: normalizedAuth?.url || '',
      code: normalizedAuth?.code || '',
      expires_at: normalizedAuth?.expiresAt || '',
    },
    release: {
      // No run_url here: it used to be forwarded as the payload url and is not
      // something the reader should receive.
      npm_url: packageValue && version ? `https://www.npmjs.com/package/${packageValue}/v/${version}` : '',
      tarball: core.tarball || '',
    },
    request_id: requestId || `${repo}@${version}-${core.runNumber || ''}-${core.runAttempt || ''}`,
    timestamp: now || new Date().toISOString(),
  };
}

export function notifyConfig(env = process.env) {
  const url = String(env.MESSAGE_PUSHER_URL || '').trim();
  const requireDelivery = String(env.NOTIFY_REQUIRED ?? 'true').toLowerCase() !== 'false';
  const attempts = Number(env.NOTIFY_ATTEMPTS || 3);
  const timeoutMs = Number(env.NOTIFY_TIMEOUT_MS || 10_000);

  return {
    url,
    token: env.MESSAGE_PUSHER_TOKEN || '',
    requireDelivery,
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 3,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
    stateDir: env.RUNNER_TEMP || env.TMPDIR || '/tmp',
    // message-pusher's native endpoint takes its own field names; anything else
    // (a custom webhook) receives the verbatim v1 envelope.
    messagePusherStyle: url.includes('/push/') && env.MESSAGE_PUSHER_RAW !== 'true',
  };
}

/**
 * Validate the notification configuration before a release touches the
 * registry. A missing destination is a hard configuration error: the whole
 * point of the relay is that a human can finish the npm verification, so
 * silently skipping it would strand the run.
 */
export function assertNotifyConfigured(env = process.env) {
  const config = notifyConfig(env);
  if (!config.url) {
    throw new Error(
      '未配置通知地址：请在仓库变量里设置 MESSAGE_PUSHER_URL 为你自己的推送服务地址。该地址不会随 Action 分发，必须由目标仓库提供',
    );
  }
  if (!isHttpUrl(config.url)) {
    throw new Error(`MESSAGE_PUSHER_URL 必须是 http(s) 地址，当前为：${config.url}`);
  }
  if (config.url.includes('/push/') && !config.token && String(env.MESSAGE_PUSHER_REQUIRE_TOKEN || '') === 'true') {
    throw new Error('MESSAGE_PUSHER_URL 指向 /push/ 接口但未设置 MESSAGE_PUSHER_TOKEN');
  }
  return config;
}

function toMessagePusherBody(payload, config) {
  const anchor = payload.auth?.url || payload.url || payload.release?.run_url || '';
  const code = payload.auth?.code ? `（验证码 ${payload.auth.code}）` : '';
  const lines = [
    payload.summary || '',
    code,
    anchor ? `链接：${anchor}` : '',
    payload.release?.run_url && payload.release.run_url !== anchor ? `run：${payload.release.run_url}` : '',
  ].filter(Boolean);
  return {
    title: payload.title,
    description: payload.summary || '',
    content: lines.join('\n'),
    url: isHttpUrl(anchor) ? anchor : payload.url,
    ...(config.token ? { token: config.token } : {}),
    async: false,
  };
}

/**
 * One marker per (request, url): a run can legitimately deliver several different
 * authentication URLs (the derived login page first, then npm's one-time
 * `auth/cli/<uuid>` challenge), and keying on the request id alone silently
 * dropped the second one — the address the user actually needs.
 */
function idempotencyPath(config, requestId, url) {
  const key = `${requestId}|${url}`.replace(/[^\w.-]+/g, '_');
  return join(config.stateDir, `notify-${key.slice(0, 120)}.json`);
}

async function attemptDelivery(payload, config, fetchImpl) {
  const body = config.messagePusherStyle ? toMessagePusherBody(payload, config) : payload;
  const headers = { 'content-type': 'application/json', 'user-agent': 'dsh-npm-publish-action/1' };
  if (config.token && !config.messagePusherStyle) headers.authorization = `Bearer ${config.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.message || text.slice(0, 200) || '';
      const error = new Error(`webhook HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.retryable = RETRYABLE.has(response.status);
      error.status = response.status;
      throw error;
    }
    if (parsed && parsed.success === false) {
      const error = new Error(`webhook reported failure: ${parsed.message || 'unknown'}`);
      error.retryable = false;
      throw error;
    }
    return { status: response.status, response: parsed || text, body };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST the payload, retrying transient failures with exponential backoff and
 * jitter. The same request_id is delivered at most once per job: a marker file
 * in RUNNER_TEMP records the outcome so a re-run of a step does not spam the
 * receiving chat, while an explicit `--force` (not used by the Action) can.
 */
export async function deliver(payload, options = {}) {
  const env = options.env || process.env;
  const config = { ...notifyConfig(env), ...options.config };
  // Fail with an actionable message rather than a cryptic fetch error.
  if (!config.url) {
    throw new Error('未配置 MESSAGE_PUSHER_URL，无法投递通知');
  }
  if (!shouldSend(payload)) {
    return {
      skipped: true,
      reason: `no authentication URL to send (url=${payload.url || '<empty>'})`,
      previous: '',
    };
  }
  const idempotent = options.idempotent !== false;
  const marker = idempotencyPath(config, payload.request_id, payload.url);

  if (idempotent && options.force !== true && existsSync(marker)) {
    const previous = readFileSync(marker, 'utf8').trim();
    return { skipped: true, reason: `already delivered ${payload.request_id} → ${payload.url}`, previous };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  let lastError;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      const result = await attemptDelivery(payload, config, fetchImpl);
      if (idempotent) {
        try {
          mkdirSync(dirname(marker), { recursive: true });
          writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), status: result.status }), 'utf8');
        } catch {
          // Losing the marker only costs a duplicate notification, never correctness.
        }
      }
      return { ...result, skipped: false, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (!retryable || attempt === config.attempts) break;
      const backoff = Math.min(2000, 250 * 2 ** (attempt - 1));
      await sleep(backoff + Math.floor(Math.random() * 100));
    }
  }
  throw lastError;
}

/** Human-readable log line for a delivery result. */
export function describeDelivery(payload, result) {
  if (result.skipped) return `webhook 已投递过（request_id=${payload.request_id}），本次跳过`;
  return `webhook 投递成功（HTTP ${result.status}, phase=${payload.phase}）`;
}
