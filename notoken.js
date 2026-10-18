/**
 * Host half of the local `notoken-login` plugin: one public route — the login
 * entry — that turns the running process's launch token into the
 * `dsh-auth-*` browser-session cookie, so a first visit (or any visit after the
 * cookie expired, the browser changed, or the authority changed) needs no
 * `?token=...` in the address bar.
 *
 * The route deliberately skips browser authentication, because
 * "not authenticated yet" is exactly the condition it exists to resolve. It
 * still consults the composition's own trust fence (`connection.
 * requestRejection`): a 403 — an authority outside loopback/`trustedHosts`, a
 * scripted cross-site call, or a foreign `Origin` — ends the request, so the
 * entry never mints a cookie for an authority the `/api` fence and the Gateway
 * WebSocket would refuse anyway. A 401 is the normal entry condition and
 * proceeds.
 *
 * The default `exchange` mode keeps the token in this process: it feeds the
 * authenticated URL's path and query to `connection.authorizeIndex` with a
 * capturing response, then relays the 303 plus its `Set-Cookie` header. The
 * browser therefore only ever sees `/__dsh_login` (and the redirect to `./`).
 * `redirect` mode is the compatible fallback: it answers 302 with the
 * token-bearing URL, which puts the token in the browser history. It does not
 * cover installed-app launches: their Strict cookie is withheld on that token
 * URL chain too, so it can still loop.
 *
 * The session cookie is `SameSite=Strict`, and some launches withhold it for a
 * whole redirect chain. Chrome labels an installed PWA/WebAPK launch
 * `Sec-Fetch-Site: cross-site`; Firefox labels its add-to-home-screen launch
 * `Sec-Fetch-Site: none` while still treating the external launch as a foreign
 * request for SameSite purposes. A 303 back to `./` then bounces to a
 * cookie-less `/` forever (observed as "too many redirects"). For a document
 * navigation that reaches the entry without a session and is labelled
 * `cross-site` (only when allowed) or `none` — the two shapes whose Strict
 * cookie the chain will withhold — the entry serves the application shell in
 * this same response instead: its root is fetched from the listener's own bind
 * address (`webServer.host` and `port`) with the freshly minted cookie, so the
 * bytes are exactly the render the redirect would serve and the browser keeps
 * the URL it asked for. Same-origin/same-site navigations still take the 303:
 * their redirect chain does carry the cookie. Dialing the bind address, never a
 * hard-coded loopback, matters because `dsh web --host <address>` binds one
 * concrete interface: `127.0.0.1` may refuse the connection.
 *
 * The token is read per request, so the entry never goes stale across
 * restarts. The cookie lifetime stays whatever `client-connection`'s
 * `cookieMaxAgeDays` decides; this plugin neither signs cookies nor holds
 * secrets.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Cordis function-plugin name. */
export const name = 'notoken-login'

/** The route carrier and the trust fence / token-exchange owner. */
export const inject = ['webServer', 'connection']

/** Default route: one segment under the application root. */
const DEFAULT_PATH = '/__dsh_login'

/** Default mode: the token never leaves the Host process. */
const DEFAULT_MODE = 'exchange'

/**
 * One path segment, no trailing slash: the exchange relays
 * `location: './'`, whose parent directory must be the application root.
 * A nested path would land the browser on that parent instead.
 */
const SINGLE_SEGMENT_PATH = /^\/[A-Za-z0-9._~-]+$/

const MODES = new Set(['exchange', 'redirect'])

const CONFIG_KEYS = new Set(['path', 'mode', 'allowCrossSiteNavigation'])

/**
 * Validate the row config by hand: this plugin exports no schema, so an
 * unsupported key must fail the load loudly instead of being ignored.
 * @param config - raw row config, or undefined.
 * @returns the route path, the exchange mode, and the cross-site policy.
 * @throws when the shape, the key set, the path, the mode, or the flag is unsupported.
 */
function resolveOptions(config) {
  if (config === undefined || config === null) {
    return { path: DEFAULT_PATH, mode: DEFAULT_MODE, allowCrossSiteNavigation: false }
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${name}: config must be an object with optional "path", "mode", and "allowCrossSiteNavigation"`)
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`${name}: unknown config key ${JSON.stringify(key)}; supported keys are `
        + '"path", "mode", and "allowCrossSiteNavigation"')
    }
  }
  const path = config.path === undefined || config.path === null ? DEFAULT_PATH : config.path
  const mode = config.mode === undefined || config.mode === null ? DEFAULT_MODE : config.mode
  const allowCrossSiteNavigation = config.allowCrossSiteNavigation === undefined
    || config.allowCrossSiteNavigation === null
    ? false
    : config.allowCrossSiteNavigation
  if (typeof path !== 'string' || !SINGLE_SEGMENT_PATH.test(path)) {
    throw new Error(`${name}: "path" must be one path segment like "${DEFAULT_PATH}"`)
  }
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new Error(`${name}: "mode" must be one of ${[...MODES].map(value => JSON.stringify(value)).join(', ')}`)
  }
  if (typeof allowCrossSiteNavigation !== 'boolean') {
    throw new Error(`${name}: "allowCrossSiteNavigation" must be a boolean`)
  }
  return { path, mode, allowCrossSiteNavigation }
}

/** Answer 302 with the token-bearing URL (the token reaches the browser here). */
function sendRedirect(res, location) {
  res.writeHead(302, {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'location': location,
  })
  res.end()
}

/** One header value as a single line (arrays are diagnostic only). */
function headerLine(req, field) {
  const value = req.headers[field]
  return Array.isArray(value) ? value.join(', ') : value
}

/** The request facts the connection trust fence decides on. */
function fenceFacts(req) {
  return [
    `Host: ${headerLine(req, 'host') ?? '-'}`,
    `Origin: ${headerLine(req, 'origin') ?? '-'}`,
    `Sec-Fetch-Site: ${headerLine(req, 'sec-fetch-site') ?? '-'}`,
  ].join(', ')
}

/** Refuse with a short plain-text reason: the entry is a human navigation target. */
function refuse(res, status, detail, headers) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
  })
  res.end(`${name}: ${detail}\n`)
}

/**
 * Whether ONLY the browser's cross-site/Origin labels caused the refusal: the
 * same request stripped of those two headers still passes the composition's own
 * fence, so its authority is ours and the Host/Origin whitelist is not being
 * widened. Nothing here reimplements the fence — it asks the same service
 * twice. This is the probe behind `allowCrossSiteNavigation`.
 * @param ctx - Host plugin context carrying `connection`.
 * @param req - the refused request.
 * @returns true when the authority passes the fence without browser labels.
 */
function authorityPassesWithoutLabels(ctx, req) {
  const stripped = { ...req.headers }
  delete stripped['sec-fetch-site']
  delete stripped.origin
  return ctx.connection.requestRejection({ headers: stripped }) !== 403
}

/**
 * Minimal sink for `connection.authorizeIndex`: it records what the exchange
 * wrote so the real response can relay exactly that status and header set.
 * @returns the sink and a reader for the captured state.
 */
function captureResponse() {
  let status = 0
  let headers = {}
  return {
    sink: {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = nextHeaders ?? {}
        return this
      },
      end() {},
    },
    captured: () => ({ status, headers }),
  }
}

/** Deadline for the local document request that serves an application shell. */
const DOCUMENT_TIMEOUT_MS = 5000

/**
 * Where this process's own web server answers. `webServer.host` is the one
 * concrete interface the listener bound (the web server rejects wildcard
 * binds), so dialing it from this machine always reaches this same process.
 * A deployment such as `dsh web --host 192.168.0.10` listens on that address
 * only — `127.0.0.1` is refused, and hard-coding it is what made the in-place
 * shell fail with ECONNREFUSED.
 * @param webServer - the Host web-server service.
 * @returns the protocol, bind host, and listening port of the local listener.
 * @throws when the service has no bound address yet.
 */
function listenerTarget(webServer) {
  const { host, port } = webServer
  if (typeof host !== 'string' || host === '' || typeof port !== 'number') {
    throw new Error('the web server has no bound host and port')
  }
  return { protocol: webServer.protocol === 'https:' ? 'https:' : 'http:', host, port }
}

/**
 * A printable form of {@link listenerTarget} for the announcement line.
 * @param webServer - the Host web-server service.
 * @returns the local origin (for example `http://127.0.0.1:3080`).
 */
function listenerOrigin(webServer) {
  try {
    return webServer.getOrigin()
  } catch {
    const target = listenerTarget(webServer)
    return `${target.protocol}//${target.host}:${String(target.port)}`
  }
}

/**
 * GET the application root from the composition's own listener with an explicit
 * Host and the freshly minted cookie. `node:http` is deliberate: the global
 * `fetch` treats `Host` as a forbidden header and silently sends the URL's own
 * authority instead, which would mint the cookie against one authority and
 * present it as another. The bind address, not `127.0.0.1`, is the target: the
 * listener binds exactly one concrete interface, so a loopback dial can be
 * refused.
 * @param target - protocol, bind host, and listening port (see {@link listenerTarget}).
 * @param host - the caller's Host authority (the cookie is bound to it).
 * @param cookie - the minted cookie pair.
 * @returns the status, content type, and body bytes of the document response.
 */
function readDocumentOverLocalListener(target, host, cookie) {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = transport({
      host: target.host,
      port: target.port,
      method: 'GET',
      path: '/',
      headers: { host, cookie, connection: 'close' },
      timeout: DOCUMENT_TIMEOUT_MS,
      // A native-TLS listener's certificate may name its public authority
      // rather than the bind address; this request never leaves the machine.
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks = []
      response.on('data', chunk => { chunks.push(chunk) })
      response.on('end', () => {
        const contentType = response.headers['content-type']
        resolve({
          status: response.statusCode ?? 500,
          contentType: (Array.isArray(contentType) ? contentType[0] : contentType)
            ?? 'text/html; charset=utf-8',
          body: Buffer.concat(chunks),
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`local document request timed out after ${String(DOCUMENT_TIMEOUT_MS)}ms`))
    })
    request.on('error', reject)
    request.end()
  })
}

/** Test seam: the local document reader and the bind-address derivation. */
export const internals = { readDocument: readDocumentOverLocalListener, listenerTarget }

/** Whether the caller is asking for a top-level document rather than an API-shaped
 * subresource. A client that sends no fetch metadata at all (curl, older
 * browsers) is treated as navigating.
 * @param req - the incoming request.
 * @returns true for a navigation.
 */
function navigatesDocument(req) {
  const mode = headerLine(req, 'sec-fetch-mode')
  if (mode === undefined) return true
  return mode === 'navigate' || headerLine(req, 'sec-fetch-dest') === 'document'
}

/**
 * Serve the application document in place of a redirect.
 *
 * A launch chain may withhold `SameSite=Strict` cookies from every hop,
 * including the hop after a 303 — so `303 location: ./` would bounce back to a
 * cookie-less `/` forever (observed as "too many redirects" when launching an
 * installed PWA/WebAPK, and with Firefox's add-to-home-screen launch, which
 * labels its request `Sec-Fetch-Site: none` but treats the external launch as
 * foreign for SameSite). This serves the document for the request that is
 * already in flight instead: the shell is fetched from the composition's own
 * listener with the freshly minted cookie, so it is exactly the render the
 * fallback would serve, and the browser keeps the URL it asked for. The cookie
 * still rides along, which is what every same-origin request the loaded
 * application makes will use.
 * @param ctx - Host plugin context carrying `webServer`.
 * @param res - the response to own.
 * @param host - the caller's Host authority (the internal request must carry it,
 * so the cookie name and any absolute reference stay bound to it).
 * @param setCookie - the exact `Set-Cookie` value the token exchange produced.
 */
async function serveDocumentInPlace(ctx, res, host, setCookie) {
  const cookie = setCookie.split(';', 1)[0].trim()
  let document
  try {
    document = await internals.readDocument(internals.listenerTarget(ctx.webServer), host, cookie)
  } catch (error) {
    console.warn(`${name}: the local document request failed: ${String(error)}`)
    refuse(res, 502, 'could not fetch the application document from the local listener')
    return
  }
  if (document.status !== 200) {
    console.warn(`${name}: the local document request answered ${String(document.status)}`)
    refuse(res, 502, `the local document request answered ${String(document.status)}`)
    return
  }
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': document.contentType,
    'set-cookie': setCookie,
  })
  res.end(document.body)
}

/**
 * Register the login entry route.
 * @param ctx - Host plugin context carrying `webServer` and `connection`.
 * @param config - row config (`path`, `mode`, `allowCrossSiteNavigation`; all optional).
 */
export function apply(ctx, config) {
  const { path, mode, allowCrossSiteNavigation } = resolveOptions(config)

  const handler = async (req, res) => {
    if (req.method !== 'GET') {
      refuse(res, 405, `only GET opens the login entry (got ${req.method})`, { allow: 'GET' })
      return
    }
    // 403 = the fence refused this authority/marker; 401 = the authority passed
    // the fence but there is no usable browser session, which is the entry's
    // own reason to exist. The refusal names its facts: an empty 403 is the
    // least debuggable response a deployment can get.
    let allowedByLabelsOnly = false
    let sessionMissing = false
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === 403) {
      const facts = fenceFacts(req)
      if (allowCrossSiteNavigation && authorityPassesWithoutLabels(ctx, req)) {
        // The authority is ours; only the browser's cross-site label refused it.
        // A link clicked on another site is a legitimate way to reach a login
        // entry, and the session cookie is SameSite=Strict, so such a request
        // can never carry it anyway.
        allowedByLabelsOnly = true
        console.warn(`${name}: allowing a browser-labelled cross-site request — ${facts}`)
      } else {
        console.warn(`${name}: refused ${req.url ?? '/'} — ${facts}`)
        refuse(res, 403, 'refused by the connection trust fence; the Host must be loopback or listed in '
          + `trustedHosts, and scripted cross-site requests or foreign Origins are refused (${facts})`)
        return
      }
    } else if (rejection === 401) {
      sessionMissing = true
    }
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') {
      refuse(res, 400, 'request carries no usable Host header')
      return
    }
    // Read the process token per request: it changes on every restart.
    const authenticated = new URL(ctx.connection.authenticatedUrl(`http://${host}/`))
    if (mode === 'redirect') {
      sendRedirect(res, authenticated.href)
      return
    }
    const { sink, captured } = captureResponse()
    ctx.connection.authorizeIndex({
      headers: req.headers,
      method: 'GET',
      url: `${authenticated.pathname}${authenticated.search}`,
    }, sink)
    const { status, headers } = captured()
    // Relay only a completed token exchange. Anything else means the upstream
    // contract changed: degrade to the documented redirect instead of leaving
    // the entry broken.
    if (status !== 303 || typeof headers['set-cookie'] !== 'string') {
      sendRedirect(res, authenticated.href)
      return
    }
    // A launch chain may withhold the new SameSite=Strict cookie from every
    // hop, so redirecting back to './' would loop forever. Two browser shapes
    // reach here without a session: a chain labelled cross-site (Chrome
    // installed PWA/WebAPK; relaxation gated by allowCrossSiteNavigation), and
    // a user/browser-initiated navigation labelled `none` (Firefox
    // add-to-home-screen). Serve the document for the request already in
    // flight instead (see serveDocumentInPlace). Reverse proxies that
    // internally rewrite `/` to this route therefore return the shell under the
    // browser's own URL.
    const secFetchSite = headerLine(req, 'sec-fetch-site')
    const launchWithoutSession = allowedByLabelsOnly
      || (sessionMissing && secFetchSite === 'none')
    if (launchWithoutSession && navigatesDocument(req)) {
      await serveDocumentInPlace(ctx, res, host, headers['set-cookie'])
      return
    }
    res.writeHead(status, headers)
    res.end()
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path, handler }),
    `${name}: GET ${path}`,
  )

  // Announce the entry beside the `dsh web:` URL line: this composition's
  // logger exporter is not wired to stdout, and the URL line itself uses
  // console.log for exactly that reason. The origin is the listener's real bind
  // address, not loopback: `--host` deployments do not answer on 127.0.0.1.
  if (typeof ctx.webServer.port === 'number') {
    console.log(`${name}: login entry at ${listenerOrigin(ctx.webServer)}${path} (no ?token= needed)`)
  }
}
