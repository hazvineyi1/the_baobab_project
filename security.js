// Response headers.
//
// WHY BY HAND RATHER THAN helmet. This app has two runtime dependencies and it
// is worth keeping it that way — the whole thing is meant to be readable and
// repairable years from now by somebody with no toolchain. What helmet does is
// set about a dozen headers; below is those headers, with the reason each one
// is here written next to it, which is more useful than a package name.
//
// THE ONE THAT ACTUALLY DOES SOMETHING is the Content-Security-Policy, and it
// is only worth having because this page has no inline event handlers and no
// eval anywhere in it. That means the single <script> can carry a per-request
// nonce and everything else executable can be refused outright — so an
// injected <script> does not run, which is the whole point. A CSP with
// 'unsafe-inline' on scripts would be decoration.
//
// The rest are cheap and each closes one specific thing.

const crypto = require('crypto');

/* A fresh nonce per response. It has to be per RESPONSE, not per boot: a nonce
   reused across requests is a nonce an attacker can read off one page and put
   in the injection they send to the next. */
const newNonce = () => crypto.randomBytes(16).toString('base64');

function policy(nonce) {
  return [
    // Nothing loads from anywhere unless a line below says otherwise.
    "default-src 'self'",

    // The nonce is what makes this worth having. No 'unsafe-inline' and no
    // 'unsafe-eval': an injected script has no nonce and does not run.
    `script-src 'self' 'nonce-${nonce}'`,

    // 'unsafe-inline' HERE and nowhere else, and it is a deliberate trade.
    // The page is laid out with style="..." attributes throughout, which no
    // nonce can cover — style-src-attr could, but a browser that does not
    // know that directive falls back to this one and the family gets an
    // unstyled page. Inline STYLE cannot execute; inline SCRIPT can, and that
    // is the one this refuses.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",

    // data: because the backdrop mask is built as an SVG data URI.
    "img-src 'self' data:",

    // The page only ever talks to its own origin. If it ever starts sending a
    // family's names anywhere else, this is what fails first.
    "connect-src 'self'",

    // A form on this page cannot post the passcode to somebody else's server.
    "form-action 'self'",

    // Nobody frames this. Clickjacking a tree is a strange idea, but the
    // dashboard has "close this family" buttons on it.
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join('; ');
}

/* Express middleware. Puts a nonce on the request for the HTML routes to use
   and sets the headers on every response, including the static files — a
   header that is only on the pages you remembered is a header you do not have.

   `secure` decides HSTS: it is meaningless over http (browsers ignore it) and
   actively wrong to promise on a deployment reached by name over plain http,
   so it is only sent when the request actually arrived over TLS. */
function securityHeaders({ enabled = true } = {}) {
  if (!enabled) return (req, res, next) => next();

  return function headers(req, res, next) {
    const nonce = newNonce();
    req.cspNonce = nonce;
    res.locals = res.locals || {};
    res.locals.cspNonce = nonce;

    res.setHeader('Content-Security-Policy', policy(nonce));

    // Stops a browser deciding for itself that a .txt is really a script.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // frame-ancestors above covers modern browsers; this covers the rest.
    res.setHeader('X-Frame-Options', 'DENY');

    /* NO REFERRER, and this one matters more here than it usually does.

       An invitation is /join/<token> — the token is in the PATH, not the
       fragment, because the server has to see it. Without this, a browser
       following any outbound link from that page would hand the whole
       invitation to whoever it went to. The family key is in the fragment and
       was never at risk; this is about the tokens that cannot be. */
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.setHeader('Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    /* The link-preview card is the ONE thing meant to be fetched from
       elsewhere — that is what it is for. Everything else is same-origin, so
       an embedded copy of a family's page cannot be loaded into somebody
       else's site. */
    res.setHeader('Cross-Origin-Resource-Policy',
      req.path === '/preview.jpg' ? 'cross-origin' : 'same-origin');

    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security',
        'max-age=31536000; includeSubDomains');
    }

    next();
  };
}

/* Put the nonce on the one <script> in a page.

   Both HTML files this serves have exactly one, and neither has an inline
   event handler — which is what makes a nonce sufficient rather than
   theatre. If a second script is ever added, this covers it too; if an
   onclick= attribute is ever added, it will silently stop working, and that
   is the right way round for it to fail. */
const withNonce = (html, nonce) =>
  html.split('<script>').join(`<script nonce="${nonce}">`);

/* ── ONE ADDRESS ───────────────────────────────────────────────────────────

   A site on both themuwuyuproject.org and www.themuwuyuproject.org is two
   sites as far as a browser is concerned, and here that costs more than
   tidiness: the session cookie is scoped to the host it was set on, so a
   family signing in at the bare domain and then following a link to www is
   asked for their passcode again, on what is to them the same site. Links
   people send each other split the same way.

   SO ONLY WITHIN THE SAME REGISTRABLE DOMAIN. The apex and any other
   subdomain of it are sent to the canonical host; everything else — the
   railway.app address, 127.0.0.1, whatever a test or a laptop is using — is
   left alone. A redirect that caught every host would be one that broke every
   way in except the one somebody remembered to configure.

   301, because it is permanent and browsers and search engines should be told
   so, and the path and query travel with it: an invitation link that arrives
   at the wrong host must still open the invitation.

   /health is never redirected. It is what the platform asks to know the
   service is alive, and an answer of "look over there" is not an answer. */
function canonicalHost(canonical) {
  const want = String(canonical || '').trim().toLowerCase().replace(/\.$/, '');
  if (!want) return (req, res, next) => next();
  // The registrable domain this applies to: www.example.org guards example.org
  // and everything under it, and nothing else anywhere.
  const apex = want.replace(/^www\./, '');

  return function canonical(req, res, next) {
    if (req.path === '/health') return next();
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (!host || host === want) return next();
    if (host !== apex && !host.endsWith('.' + apex)) return next();
    return res.redirect(301, `https://${want}${req.originalUrl || req.url || '/'}`);
  };
}

module.exports = { securityHeaders, withNonce, policy, newNonce, canonicalHost };
