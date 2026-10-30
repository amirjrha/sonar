'use strict';

const { Resolver } = require('node:dns').promises;

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SOA'];

function makeResolver(servers) {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  if (servers && servers.length) r.setServers(servers);
  return r;
}

async function query(resolver, host, type) {
  try {
    const records = await resolver.resolve(host, type);
    return Array.isArray(records) ? records : [records];
  } catch (err) {
    if (['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED', 'ESERVFAIL'].includes(err.code)) return [];
    throw err;
  }
}

function format(type, rec) {
  switch (type) {
    case 'MX': return { value: rec.exchange, priority: rec.priority };
    case 'TXT': return { value: rec.join('') };
    case 'CAA': {
      const tag = Object.keys(rec).find((k) => k !== 'critical');
      return { value: `${tag} "${rec[tag]}"` };
    }
    case 'SOA': return { value: `${rec.nsname} ${rec.hostmaster}`, serial: rec.serial, ttl: rec.minttl };
    default: return { value: typeof rec === 'string' ? rec : rec.address || String(rec) };
  }
}

/** Full record sweep for a domain, or a PTR lookup for an IP. */
async function dnsCheck(target, opts = {}) {
  const resolver = makeResolver(opts.dnsServers);

  if (target.kind !== 'domain') {
    let ptr = [];
    try { ptr = await resolver.reverse(target.host); } catch { /* no PTR */ }
    return { kind: 'reverse', records: { PTR: ptr.map((value) => ({ value })) } };
  }

  const started = performance.now();
  const entries = await Promise.all(TYPES.map(async (type) => {
    const recs = await query(resolver, target.host, type);
    return [type, recs.map((r) => format(type, r))];
  }));
  const records = Object.fromEntries(entries.filter(([, v]) => v.length));

  const txt = (records.TXT || []).map((r) => r.value);
  const mail = {
    spf: txt.some((t) => t.toLowerCase().startsWith('v=spf1')),
    dmarc: false,
  };
  try {
    const d = await query(resolver, `_dmarc.${target.host}`, 'TXT');
    mail.dmarc = d.some((r) => r.join('').toLowerCase().startsWith('v=dmarc1'));
  } catch { /* ignore */ }

  return {
    kind: 'forward',
    ms: Math.round(performance.now() - started),
    records,
    mail,
  };
}

module.exports = { dnsCheck };
