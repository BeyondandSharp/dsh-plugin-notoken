/**
 * Reproduce an installed-application launch (Android Chrome PWA / WebAPK) against
 * a running instance, through the reverse-proxy shape the README documents:
 * `location = /` proxies `/`, and `error_page 401 = /__dsh_login` rewrites an
 * unauthenticated root navigation to the login entry server-side.
 *
 * Faithful to Chrome: the navigation is labelled cross-site (that is what makes
 * the entry refuse it by default), and the `SameSite=Strict` session cookie is
 * withheld for EVERY hop of the chain — which is exactly why a `303` back to `/`
 * used to end in "too many redirects". The flow passes only when the document is
 * served in the response to the first request.
 *
 *   node verify/webapk-flow.mjs <upstream-port>
 *
 * Exits non-zero when the launch does not reach the application shell.
 */
import { createServer, request as httpRequest } from 'node:http'

const upstreamPort = Number(process.argv[2])
if (!Number.isInteger(upstreamPort)) {
  console.error('usage: node verify/webapk-flow.mjs <upstream-port>')
  process.exit(2)
}

/** nginx `location = /`: proxy as-is, but answer an upstream 401 from the entry. */
const proxy = createServer((req, res) => {
  const forward = (path, intercept) => {
    const upstream = httpRequest(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path, headers: req.headers },
      (result) => {
        if (intercept && result.statusCode === 401) {
          result.resume()
          forward('/__dsh_login', false)
          return
        }
        res.writeHead(result.statusCode, result.headers)
        result.pipe(res)
      },
    )
    upstream.on('error', (error) => { res.destroy(error) })
    req.pipe(upstream)
  }
  forward(req.url, req.url === '/')
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${String(proxy.address().port)}/`

/** What the launcher sends: a browser-labelled cross-site top-level navigation. */
const launchHeaders = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/WebAPK',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

let failures = 0
const check = (label, expected, actual) => {
  if (expected === actual) {
    console.log(`PASS  ${label} (${String(actual)})`)
  } else {
    console.log(`FAIL  ${label}: expected ${String(expected)}, got ${String(actual)}`)
    failures += 1
  }
}

// Chrome withholds the Strict cookie on every hop of this chain, so no hop ever
// carries one — the launch must complete on the strength of the first response.
const response = await fetch(base, { redirect: 'manual', headers: launchHeaders })
const body = await response.text()
const setCookie = response.headers.getSetCookie().join('; ')
console.log(`launch: GET / -> ${response.status}${response.headers.get('location') === null ? '' : ` location=${response.headers.get('location')}`}`)

check('launch answers 200 (no redirect chain)', 200, response.status)
check('launch response is the shell', true, /<!doctype html/i.test(body) && body.includes('id="root"'))
check('launch response sets the session cookie', true, /^dsh-auth-[^=]+=/.test(setCookie))
check('launch response is html', true, (response.headers.get('content-type') ?? '').startsWith('text/html'))

proxy.close()
if (failures > 0) {
  console.log(`webapk-flow: FAIL (${String(failures)})`)
  process.exit(1)
}
console.log('webapk-flow: PASS')
