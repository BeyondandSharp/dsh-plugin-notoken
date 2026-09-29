/** Unit tests for the notoken-login host plugin. Run with: node --test */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, internals, name } from '../notoken.js'

const COOKIE = 'dsh-auth-abc=v1.eyJhIjoxfQ.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'

/** Minimal cordis-like context: route registry, effect runner, and a scripted connection. */
function fakeContext({ rejection = 401, authorize } = {}) {
  const routes = []
  const disposers = []
  const calls = { requestRejection: [], authorizeIndex: [], authenticatedUrl: [] }
  const connection = {
    authenticatedUrl(baseUrl) {
      calls.authenticatedUrl.push(baseUrl)
      return `${baseUrl}?token=PROCESS-TOKEN`
    },
    requestRejection(request) {
      calls.requestRejection.push(request)
      return typeof rejection === 'function' ? rejection(request) : rejection
    },
    authorizeIndex(request, response) {
      calls.authorizeIndex.push({ request, response })
      if (authorize !== undefined) return authorize(request, response)
      response.writeHead(303, {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
        'set-cookie': COOKIE,
      })
      response.end()
      return false
    },
  }
  const ctx = {
    connection,
    webServer: {
      port: 3199,
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, disposers, calls }
}

/** Run one synchronous step with console.log/console.warn captured. */
function captureConsole(run) {
  const logged = []
  const warned = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => { logged.push(args.join(' ')) }
  console.warn = (...args) => { warned.push(args.join(' ')) }
  try {
    run()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
  return { logged, warned }
}

/** Async sibling of {@link captureConsole}, for steps that await. */
async function captureConsoleAsync(run) {
  const logged = []
  const warned = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => { logged.push(args.join(' ')) }
  console.warn = (...args) => { warned.push(args.join(' ')) }
  try {
    await run()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
  return { logged, warned }
}

/** Load the plugin with a scripted context, capturing the announcement line. */
function boot(options = {}, config = undefined) {
  const fake = fakeContext(options)
  const { logged } = captureConsole(() => { apply(fake.ctx, config) })
  return { ...fake, logged }
}

/** Replace the loopback document reader for one step; returns the calls it saw. */
function stubDocument(respond) {
  const requests = []
  const original = internals.readDocument
  internals.readDocument = async (port, host, cookie) => {
    requests.push({ port, host, cookie })
    return respond(port, host, cookie)
  }
  return { requests, restore: () => { internals.readDocument = original } }
}

function fakeRequest({ method = 'GET', host = '127.0.0.1:3199', headers = {} } = {}) {
  return { method, headers: { host, ...headers } }
}

function fakeResponse() {
  const state = { status: 0, headers: {}, body: undefined }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      return this
    },
    end(body) {
      state.body = body
    },
  }
}

test('exports the cordis plugin identity and dependencies', () => {
  assert.equal(name, 'notoken-login')
  assert.deepEqual(inject, ['webServer', 'connection'])
})

test('registers one exact route at the default path, announces it, and disposes it', () => {
  const { routes, disposers, logged } = boot()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/__dsh_login')
  assert.equal(disposers.length, 1)
  assert.match(
    logged[0],
    /^notoken-login: login entry at http:\/\/127\.0\.0\.1:3199\/__dsh_login \(no \?token= needed\)$/,
  )
  disposers[0]()
  assert.equal(routes.length, 0)
})

test('exchange mode relays the 303 and its cookie without leaking the token', () => {
  const { routes, calls } = boot()
  const res = fakeResponse()
  routes[0].handler(fakeRequest(), res)
  assert.equal(res.state.status, 303)
  assert.equal(res.state.headers['location'], './')
  assert.equal(res.state.headers['cache-control'], 'no-store')
  assert.equal(res.state.headers['set-cookie'], COOKIE)
  assert.equal(JSON.stringify(res.state).includes('PROCESS-TOKEN'), false)
  assert.equal(calls.authorizeIndex.length, 1)
  assert.equal(calls.authorizeIndex[0].request.url, '/?token=PROCESS-TOKEN')
  assert.equal(calls.authorizeIndex[0].request.method, 'GET')
  assert.equal(calls.authorizeIndex[0].request.headers.host, '127.0.0.1:3199')
  assert.equal(calls.authenticatedUrl[0], 'http://127.0.0.1:3199/')
})

test('an already-authenticated request (no rejection) still mints a fresh cookie', () => {
  const { routes } = boot({ rejection: undefined })
  const res = fakeResponse()
  routes[0].handler(fakeRequest(), res)
  assert.equal(res.state.status, 303)
  assert.equal(res.state.headers['set-cookie'], COOKIE)
})

test('a 403 from the trust fence refuses the entry and names the deciding facts', () => {
  const { routes, calls } = boot({ rejection: 403 })
  const res = fakeResponse()
  const { warned } = captureConsole(() => {
    routes[0].handler(fakeRequest({
      host: 'evil.example.com',
      headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
    }), res)
  })
  assert.equal(res.state.status, 403)
  assert.equal(res.state.headers['set-cookie'], undefined)
  assert.match(res.state.body, /connection trust fence/)
  assert.match(res.state.body, /Host: evil\.example\.com/)
  assert.match(res.state.body, /Origin: https:\/\/evil\.example\.com/)
  assert.match(res.state.body, /Sec-Fetch-Site: cross-site/)
  assert.equal(calls.authorizeIndex.length, 0)
  assert.match(warned[0], /refused .*Host: evil\.example\.com/)
})

test('allowCrossSiteNavigation permits a cross-site subresource whose authority still passes the fence', async () => {
  // The probe re-asks the fence without the browser labels: 403 with them, 401 without.
  const fence = req => (req.headers['sec-fetch-site'] === 'cross-site' ? 403 : 401)
  const { routes, calls } = boot({ rejection: fence }, { allowCrossSiteNavigation: true })
  const res = fakeResponse()
  const { warned } = captureConsole(() => {
    routes[0].handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } }), res)
  })
  await Promise.resolve()
  assert.equal(res.state.status, 303)
  assert.equal(res.state.headers['set-cookie'], COOKIE)
  assert.equal(calls.authorizeIndex.length, 1)
  assert.match(warned[0], /allowing a browser-labelled cross-site request/)
})

test('a cross-site document navigation serves the shell in place of a redirect', async () => {
  const fence = req => (req.headers['sec-fetch-site'] === 'cross-site' ? 403 : 401)
  const { routes } = boot({ rejection: fence }, { allowCrossSiteNavigation: true })
  const res = fakeResponse()
  const { requests, restore } = stubDocument(() => ({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from('<!doctype html><html><body><div id="root"></div></body></html>'),
  }))
  try {
    await routes[0].handler(fakeRequest({
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    }), res)
  } finally {
    restore()
  }
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.state.headers['set-cookie'], COOKIE)
  assert.match(String(res.state.body), /id="root"/)
  assert.deepEqual(requests, [{
    port: 3199,
    host: '127.0.0.1:3199',
    cookie: 'dsh-auth-abc=v1.eyJhIjoxfQ.sig',
  }])
})

test('a failed loopback document fetch is a 502, never a redirect loop', async () => {
  const fence = req => (req.headers['sec-fetch-site'] === 'cross-site' ? 403 : 401)
  const { routes } = boot({ rejection: fence }, { allowCrossSiteNavigation: true })
  const res = fakeResponse()
  const { restore } = stubDocument(() => { throw new Error('connection refused') })
  try {
    await captureConsoleAsync(async () => {
      await routes[0].handler(fakeRequest({
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      }), res)
    })
  } finally {
    restore()
  }
  assert.equal(res.state.status, 502)
  assert.match(res.state.body, /loopback/)
})

test('a loopback document request that is not 200 is a 502', async () => {
  const fence = req => (req.headers['sec-fetch-site'] === 'cross-site' ? 403 : 401)
  const { routes } = boot({ rejection: fence }, { allowCrossSiteNavigation: true })
  const res = fakeResponse()
  const { restore } = stubDocument(() => ({ status: 401, contentType: 'text/plain', body: Buffer.from('') }))
  try {
    await captureConsoleAsync(async () => {
      await routes[0].handler(fakeRequest({
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      }), res)
    })
  } finally {
    restore()
  }
  assert.equal(res.state.status, 502)
  assert.match(res.state.body, /401/)
})

test('allowCrossSiteNavigation still refuses an untrusted authority', () => {
  const { routes, calls } = boot({ rejection: 403 }, { allowCrossSiteNavigation: true })
  const res = fakeResponse()
  routes[0].handler(fakeRequest({ host: 'evil.example.com', headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.state.status, 403)
  assert.equal(res.state.headers['set-cookie'], undefined)
  assert.equal(calls.authorizeIndex.length, 0)
})

test('non-GET is 405 with allow: GET and never reaches the fence', () => {
  const { routes, calls } = boot()
  const res = fakeResponse()
  routes[0].handler({ method: 'POST', headers: { host: '127.0.0.1:3199' } }, res)
  assert.equal(res.state.status, 405)
  assert.equal(res.state.headers['allow'], 'GET')
  assert.match(res.state.body, /only GET opens the login entry \(got POST\)/)
  assert.equal(calls.requestRejection.length, 0)
  assert.equal(calls.authorizeIndex.length, 0)
})

test('redirect mode answers 302 with the token URL and skips the exchange', () => {
  const { routes, calls } = boot({}, { mode: 'redirect' })
  const res = fakeResponse()
  routes[0].handler(fakeRequest(), res)
  assert.equal(res.state.status, 302)
  assert.equal(res.state.headers['location'], 'http://127.0.0.1:3199/?token=PROCESS-TOKEN')
  assert.equal(res.state.headers['set-cookie'], undefined)
  assert.equal(calls.requestRejection.length, 1)
  assert.equal(calls.authorizeIndex.length, 0)
})

test('a custom path is honoured', () => {
  const { routes } = boot({}, { path: '/__login' })
  assert.equal(routes[0].path, '/__login')
})

test('an unexpected exchange result degrades to redirect mode', () => {
  const { routes } = boot({
    authorize: (request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('unauthorized')
      return false
    },
  })
  const res = fakeResponse()
  routes[0].handler(fakeRequest(), res)
  assert.equal(res.state.status, 302)
  assert.equal(res.state.headers['location'], 'http://127.0.0.1:3199/?token=PROCESS-TOKEN')
})

test('unsupported config fails the load instead of being ignored', () => {
  const bad = [
    { pth: '/x' },
    { path: 'x' },
    { path: '/a/b' },
    { path: '/a/' },
    { path: 7 },
    { mode: 'token' },
    { allowCrossSiteNavigation: 'yes' },
    [],
  ]
  for (const config of bad) {
    const { ctx, routes } = fakeContext()
    assert.throws(() => apply(ctx, config), /notoken-login:/, `config ${JSON.stringify(config)}`)
    assert.equal(routes.length, 0)
  }
})

test('missing host is refused', () => {
  const { routes, calls } = boot()
  const res = fakeResponse()
  routes[0].handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.state.status, 400)
  assert.match(res.state.body, /no usable Host header/)
  assert.equal(calls.authorizeIndex.length, 0)
})
