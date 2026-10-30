'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { parseTarget, isPrivateIP, TargetError } = require('./target');
const { dnsCheck } = require('./checks/dns');
const { pingCheck, portsCheck } = require('./checks/tcp');
const { httpCheck } = require('./checks/http');
const { tlsCheck } = require('./checks/tls');
const { geoCheck } = require('./checks/geo');

const RISKY_PORTS = new Set([21, 23, 1433, 3306, 3389, 5432, 6379, 27017]);

/** Order matters: the UI places each probe at a fixed bearing on the radar. */
const CHECKS = ['resolve', 'ping', 'http', 'tls', 'dns', 'ports', 'geo'];

function makeResolveSafe(allowPrivate) {
  return async function resolveSafe(host) {
    if (net.isIP(host)) {
      if (!allowPrivate && isPrivateIP(host)) throw new TargetError('BLOCKED', 'Private and reserved addresses cannot be checked');
      return host;
    }
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new TargetError('NXDOMAIN', `Could not resolve ${host} (${err.code || err.message})`);
    }
    const usable = addrs.filter((a) => allowPrivate || !isPrivateIP(a.address));
    if (!usable.length) throw new TargetError('BLOCKED', 'This name only points to private or reserved addresses');
    return (usable.find((a) => a.family === 4) || usable[0]).address;
  };
}

async function resolveTarget(target, allowPrivate) {
  if (target.kind !== 'domain') {
    if (!allowPrivate && isPrivateIP(target.host)) throw new TargetError('BLOCKED', 'Private and reserved addresses cannot be checked');
    return { ip: target.host, addresses: [{ address: target.host, family: target.kind === 'ip6' ? 6 : 4 }] };
  }
  let addrs;
  try {
    addrs = await dns.lookup(target.host, { all: true, verbatim: true });
  } catch (err) {
    throw new TargetError('NXDOMAIN', `Could not resolve ${target.host} (${err.code || err.message})`);
  }
  const usable = addrs.filter((a) => allowPrivate || !isPrivateIP(a.address));
  if (!usable.length) throw new TargetError('BLOCKED', 'This name only points to private or reserved addresses');
  const ip = (usable.find((a) => a.family === 4) || usable[0]).address;
  return { ip, addresses: addrs };
}

/* ---------- verdicts ---------- */

function judge(id, d) {
  switch (id) {
    case 'ping':
      if (!d.received) return ['fail', 'No TCP reply'];
      if (d.loss > 0 || d.stats.avg > 200) return ['warn', `${d.stats.avg} ms avg, ${d.loss}% loss`];
      return ['ok', `${d.stats.avg} ms avg`];
    case 'http':
      if (!d.reachable) return ['fail', d.error || 'Unreachable'];
      if (d.status >= 500) return ['fail', `${d.status} ${d.statusText || ''}`.trim()];
      if (d.status >= 400 || !d.https) return ['warn', `${d.status}${d.https ? '' : ' over plain HTTP'}`];
      if (d.certTrusted === false) return ['warn', `${d.status}, untrusted certificate`];
      return ['ok', `${d.status} ${d.statusText || ''}`.trim()];
    case 'tls':
      if (!d.available) return ['fail', 'No TLS on 443'];
      if (!d.trusted) return ['fail', d.trustError || 'Untrusted certificate'];
      if (d.daysLeft < 0) return ['fail', 'Certificate expired'];
      if (d.daysLeft <= 14 || !/TLSv1\.[23]/.test(d.protocol || '')) return ['warn', `${d.daysLeft} days left, ${d.protocol}`];
      return ['ok', `${d.protocol}, ${d.daysLeft} days left`];
    case 'dns': {
      const n = Object.values(d.records).reduce((a, r) => a + r.length, 0);
      return [n ? 'ok' : 'warn', `${n} records`];
    }
    case 'ports': {
      const risky = d.ports.filter((p) => p.state === 'open' && RISKY_PORTS.has(p.port));
      if (risky.length) return ['warn', `${risky.map((p) => p.service).join(', ')} exposed`];
      return ['ok', `${d.open} open`];
    }
    case 'geo':
      return ['ok', [d.city, d.countryCode].filter(Boolean).join(', ') || d.country || 'Located'];
    default:
      return ['ok', ''];
  }
}

function score(results) {
  let s = 0;
  const p = results.ping?.data;
  const h = results.http?.data;
  const t = results.tls?.data;
  const ports = results.ports?.data;
  const d = results.dns?.data;

  if (p?.received) s += 10 * (p.received / p.sent);
  if (p?.stats) s += Math.max(0, 15 - Math.max(0, p.stats.avg - 30) / 15);
  if (h?.reachable && h.status < 500) s += h.status < 400 ? 20 : 10;
  if (h?.reachable) s += (h.securityScore / 6) * 15;
  if (t?.available && t.trusted && t.daysLeft >= 0) {
    s += 15;
    if (/TLSv1\.3/.test(t.protocol)) s += 5;
    else if (/TLSv1\.2/.test(t.protocol)) s += 3;
    if (t.daysLeft > 14) s += 5;
  }
  if (d?.mail) s += (d.mail.spf ? 2.5 : 0) + (d.mail.dmarc ? 2.5 : 0);
  else if (d) s += 5; // IP targets: mail auth does not apply
  if (ports) s += Math.max(0, 10 - ports.ports.filter((x) => x.state === 'open' && RISKY_PORTS.has(x.port)).length * 5);
  else s += 10; // port scan skipped: don't penalise

  const value = Math.max(0, Math.min(100, Math.round(s)));
  const grade = value >= 95 ? 'A+' : value >= 85 ? 'A' : value >= 75 ? 'B' : value >= 60 ? 'C' : value >= 45 ? 'D' : 'F';
  return { value, grade };
}

/**
 * Run every probe against `input`, calling `emit(event, payload)` as each one
 * finishes so the UI can paint results live.
 */
async function runChecks(input, emit = () => {}, opts = {}) {
  const allowPrivate = Boolean(opts.allowPrivate);
  const started = performance.now();
  const target = parseTarget(input);

  emit('start', { target: target.host, kind: target.kind, checks: CHECKS, at: new Date().toISOString() });

  const t0 = performance.now();
  const resolved = await resolveTarget(target, allowPrivate);
  const resolveMs = Math.round(performance.now() - t0);
  const results = {
    resolve: {
      id: 'resolve', status: 'ok', ms: resolveMs,
      summary: resolved.ip,
      data: { ip: resolved.ip, addresses: resolved.addresses },
    },
  };
  emit('check', results.resolve);

  const ip = resolved.ip;
  const ctx = { resolveSafe: makeResolveSafe(allowPrivate), timeout: 8000 };
  const jobs = {
    ping: () => pingCheck(ip, { port: target.port || undefined, count: opts.count }),
    http: () => httpCheck(target, ip, ctx),
    tls: () => tlsCheck(target, ip),
    dns: () => dnsCheck(target, { dnsServers: opts.dnsServers }),
    ports: () => portsCheck(ip, { ports: opts.ports }),
    geo: () => geoCheck(ip),
  };
  if (opts.skip) for (const id of opts.skip) delete jobs[id];

  await Promise.all(Object.entries(jobs).map(async ([id, job]) => {
    const t = performance.now();
    let entry;
    try {
      const data = await job();
      const [status, summary] = judge(id, data);
      entry = { id, status, summary, ms: Math.round(performance.now() - t), data };
    } catch (err) {
      entry = { id, status: 'error', summary: err.message, ms: Math.round(performance.now() - t), data: null };
    }
    results[id] = entry;
    emit('check', entry);
  }));

  const final = { target: target.host, ip, score: score(results), ms: Math.round(performance.now() - started), results };
  emit('done', { score: final.score, ms: final.ms });
  return final;
}

module.exports = { runChecks, CHECKS, score, judge, RISKY_PORTS };
