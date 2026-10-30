'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const MAX_BODY = 256 * 1024;
const MAX_REDIRECTS = 5;

const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
];

/** A single request against a pinned IP, with per-phase timings. */
function request(url, ip, timeout) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const family = net.isIPv6(ip) ? 6 : 4;
    const t0 = performance.now();
    const t = { connect: null, tls: null, ttfb: null, total: null };
    const at = () => Math.round((performance.now() - t0) * 10) / 10;

    const req = lib.request({
      method: 'GET',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: false,
      agent: false,
      timeout,
      // Never re-resolve: connect to the address we already vetted.
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family)),
      headers: {
        'user-agent': 'SonarCheck/1.0 (+https://github.com/)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-encoding': 'identity',
      },
    });

    req.on('socket', (socket) => {
      socket.once('connect', () => { t.connect = at(); });
      socket.once('secureConnect', () => { t.tls = at(); });
    });

    req.on('response', (res) => {
      t.ttfb = at();
      const tlsInfo = isHttps ? { authorized: res.socket.authorized, error: res.socket.authorizationError || null } : null;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
        else res.destroy();
      });
      const finish = () => {
        t.total = at();
        resolve({
          ok: true,
          status: res.statusCode,
          statusText: res.statusMessage,
          httpVersion: res.httpVersion,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          size,
          timings: t,
          tls: tlsInfo,
        });
      };
      res.once('end', finish);
      res.once('close', finish);
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message, timings: { ...t, total: at() } }));
    req.end();
  });
}

function pageTitle(body) {
  const m = body.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/**
 * Fetch the target over HTTPS (falling back to HTTP), following redirects.
 * `resolveSafe(host)` must return an IP that has passed the SSRF guard.
 */
async function httpCheck(target, ip, opts) {
  const timeout = opts.timeout ?? 8000;
  const hostPart = target.kind === 'ip6' ? `[${target.host}]` : target.host;
  const portPart = target.port ? `:${target.port}` : '';

  const attempts = [new URL(`https://${hostPart}${portPart}/`), new URL(`http://${hostPart}${portPart}/`)];
  let first;
  for (const url of attempts) {
    first = { url, res: await request(url, ip, timeout) };
    if (first.res.ok) break;
  }
  if (!first.res.ok) {
    return { reachable: false, error: first.res.error, chain: [] };
  }

  const chain = [];
  let { url, res } = first;
  let currentIp = ip;
  for (let hop = 0; ; hop += 1) {
    chain.push({ url: url.href, status: res.status, ms: res.timings.total });
    const loc = res.headers.location;
    if (!(res.status >= 300 && res.status < 400 && loc) || hop >= MAX_REDIRECTS) break;
    let next;
    try { next = new URL(loc, url); } catch { break; }
    if (!['http:', 'https:'].includes(next.protocol)) break;
    try {
      currentIp = next.hostname === url.hostname ? currentIp : await opts.resolveSafe(next.hostname.replace(/^\[|\]$/g, ''));
    } catch (err) {
      chain.push({ url: next.href, status: null, blocked: err.message });
      break;
    }
    const r = await request(next, currentIp, timeout);
    if (!r.ok) {
      chain.push({ url: next.href, status: null, error: r.error });
      break;
    }
    url = next;
    res = r;
  }

  const h = res.headers;
  const security = Object.fromEntries(SECURITY_HEADERS.map((name) => [name, h[name] ? String(h[name]).slice(0, 200) : null]));

  return {
    reachable: true,
    finalUrl: url.href,
    status: res.status,
    statusText: res.statusText,
    httpVersion: res.httpVersion,
    timings: first.res.timings,
    finalTimings: res.timings,
    server: h.server || null,
    poweredBy: h['x-powered-by'] || null,
    contentType: h['content-type'] || null,
    size: res.size,
    title: pageTitle(res.body),
    chain,
    https: url.protocol === 'https:',
    certTrusted: res.tls ? res.tls.authorized : null,
    security,
    securityScore: Object.values(security).filter(Boolean).length,
    cdn: detectCdn(h),
  };
}

function detectCdn(h) {
  if (h['cf-ray']) return 'Cloudflare';
  if (h['x-amz-cf-id']) return 'Amazon CloudFront';
  if (h['x-served-by'] && /cache/i.test(h['x-served-by'])) return 'Fastly';
  if (h['x-vercel-id']) return 'Vercel';
  if (h['x-nf-request-id']) return 'Netlify';
  if (h['x-azure-ref']) return 'Azure Front Door';
  if (h['x-akamai-transformed'] || /akamai/i.test(h.server || '')) return 'Akamai';
  if (/arvancloud/i.test(h.server || '') || h['ar-poweredby']) return 'ArvanCloud';
  if (/gws|gfe/i.test(h.server || '')) return 'Google';
  return null;
}

module.exports = { httpCheck, SECURITY_HEADERS };
