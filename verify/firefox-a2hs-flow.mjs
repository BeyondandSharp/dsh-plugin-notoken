/**
 * Reproduce a Firefox for Android "Add to Home Screen" launch against a running
 * instance, through the reverse-proxy shape the README documents:
 * `location = /` proxies `/`, and `error_page 401 = /__dsh_login` rewrites an
 * unauthenticated root navigation to the login entry server-side.
 *
 * Faithful to Firefox: an installed shortcut is loaded as an external app, so
 * the navigation is labelled `Sec-Fetch-Site: none` (NOT `cross-site`, unlike
 * Chrome's WebAPK), while the `SameSite=Strict` session cookie is withheld from
 * every hop of the chain. A `303 location: ./` therefore used to bounce to a
 * cookie-less `/` until Firefox aborted with "The page isn't redirecting
 * properly". The flow passes only when the document is served in the response
 * to the first request; it then proves the freshly minted cookie authenticates
 * the application's own document request.
 *
 *   node verify/firefox-a2hs-flow.mjs <upstream-port> [upstream-host] [forwarded-host]
 *
 * `forwarded-host` simulates the nginx `proxy_set_header Host $host` shape: the
 * upstream request carries the public Host (the cookie authority) while the
 * connection goes to the listener's bind address. Exits non-zero when the
 * launch does not reach the application shell.
 */
import { createServer, request as httpRequest } from 'node:http'

const upstreamPort = Number(process.argv[2])
const upstreamHost = process.argv[3] ?? '127.0.0.1'
const forwardedHost = process.argv[4] ?? ''
if (!Number.isInteger(upstreamPort)) {
  console.error('usage: node verify/firefox-a2hs-flow.mjs <upstream-port> [upstream-host] [forwarded-host]')
  process.exit(2)
}

/** nginx `location = /`: proxy as-is, but answer an upstream 401 from the entry. */
const proxy = createServer((req, res) => {
  const headers = forwardedHost === '' ? req.headers : { ...req.headers, host: forwardedHost }
  const forward = (path, intercept) => {
    const upstream = httpRequest(
      { host: upstreamHost, port: upstreamPort, method: req.method, path, headers },
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

/** What Firefox's external-app launch sends: user-triggered, no site for cookies. */
const launchHeaders = {
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'user-agent': 'Mozilla/5.0 (Android 14; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN',
  'upgrade-insecure-requests': '1',
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

// Firefox withholds the Strict cookie on every hop of this chain, so the launch
// must complete on the strength of the first response.
const response = await fetch(base, { redirect: 'manual', headers: launchHeaders })
const body = await response.text()
const setCookieHeaders = response.headers.getSetCookie()
const setCookie = setCookieHeaders.join('; ')
console.log(`launch: GET / -> ${response.status}${response.headers.get('location') === null ? '' : ` location=${response.headers.get('location')}`}`)

check('launch answers 200 (no redirect chain)', 200, response.status)
check('launch has no location header', null, response.headers.get('location'))
check('launch response is the shell', true, /<!doctype html/i.test(body) && body.includes('id="root"'))
check('launch response sets the session cookie', true, /^dsh-auth-[^=]+=/.test(setCookie))
check('launch response is html', true, (response.headers.get('content-type') ?? '').startsWith('text/html'))

// The cookie minted for the launch must authenticate the app's same-origin
// document request, which is what makes the in-place shell usable.
const cookiePair = setCookie.split(';', 1)[0]
const follow = await fetch(base, {
  redirect: 'manual',
  headers: { ...launchHeaders, 'sec-fetch-site': 'same-origin', cookie: cookiePair },
})
check('the minted cookie authenticates the app document', 200, follow.status)

proxy.close()
if (failures > 0) {
  console.log(`firefox-a2hs-flow: FAIL (${String(failures)})`)
  process.exit(1)
}
console.log('firefox-a2hs-flow: PASS')
