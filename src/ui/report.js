'use strict';

const { c, sym, pad, truncate, meter, sparkline, cols, width } = require('./term');
const { RISKY_PORTS } = require('../runner');

const NAMES = {
  resolve: 'resolve', ping: 'tcp ping', http: 'http', tls: 'tls', dns: 'dns', ports: 'ports', geo: 'network',
};
const ORDER = ['resolve', 'ping', 'http', 'tls', 'dns', 'ports', 'geo'];
const IND = '  ';

function section(title, note = '') {
  const head = `${IND}${c.signal('──')} ${c.bold(title)}${note ? `  ${c.muted(note)}` : ''} `;
  return `\n${head}${c.dim('─'.repeat(Math.max(4, cols() - width(head) - 2)))}`;
}

function ms(v, digits = 0) {
  if (v == null) return c.muted('—');
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${Number(v).toFixed(digits)} ms`;
}

function speedColor(v) {
  if (v == null) return 'coral';
  if (v < 80) return 'signal';
  if (v < 200) return 'sky';
  if (v < 400) return 'amber';
  return 'coral';
}

/* ---------------- header ---------------- */

function header(version) {
  const ring = c.signal('◉');
  return [
    '',
    `${IND}${c.dim('((')} ${ring} ${c.dim('))')}  ${c.bold('sonar')} ${c.muted(`v${version}`)}`,
    `${IND}${c.muted('check-host for your terminal')}`,
  ].join('\n');
}

function targetLine(report) {
  const res = report.results.resolve;
  const arrow = c.dim(sym.arrow);
  if (!res) return `\n${IND}${c.bold(report.target)}`;
  const extra = res.data.addresses.length > 1 ? c.muted(`  +${res.data.addresses.length - 1} more`) : '';
  return `\n${IND}${c.bold(report.target)}  ${arrow}  ${c.signal(res.data.ip)}${extra}`;
}

/* ---------------- live probe rows ---------------- */

function probeRows(report, spin) {
  const w = cols();
  const lines = [section('from this machine', `${ORDER.length} probes in parallel`).slice(1)];
  for (const id of ORDER) {
    const r = report.results[id];
    const icon = r ? c.status(r.status, sym[r.status] || sym.ok) : c.sky(spin);
    const name = pad(r ? c.text(NAMES[id]) : c.muted(NAMES[id]), 10);
    const time = r ? c.muted(pad(`${r.ms} ms`, 8, 'right')) : pad('', 8);
    const summaryWidth = w - 2 - 2 - 10 - 2 - 8 - 4;
    const summary = r ? c.status(r.status === 'ok' ? 'muted' : r.status, truncate(r.summary || '', summaryWidth)) : c.dim('…');
    lines.push(`${IND}${icon} ${name}  ${pad(summary, summaryWidth)}  ${time}`);
  }
  return lines.join('\n');
}

/* ---------------- detail sections ---------------- */

function latencySection(r) {
  const out = [section('latency', r?.data?.port ? `tcp/${r.data.port}` : '')];
  if (!r || !r.data) return [...out, `${IND}${c.coral(r ? r.summary : 'not run')}`].join('\n');
  const d = r.data;
  if (!d.received) return [...out, `${IND}${c.coral('No TCP reply on 443, 80 or 22. A firewall may be dropping connections.')}`].join('\n');
  const s = d.stats;
  const cell = (label, value, color = 'text') => `${c.muted(label)} ${c[color](value)}`;
  out.push(`${IND}${[
    cell('min', ms(s.min, 1)), cell('avg', ms(s.avg, 1), speedColor(s.avg)), cell('max', ms(s.max, 1)),
    cell('jitter', ms(s.jitter, 1)), cell('loss', `${d.loss}%`, d.loss ? 'amber' : 'signal'),
  ].join(c.dim('   │   '))}`);
  out.push(`${IND}${sparkline(d.samples)}  ${c.muted(`${d.received}/${d.sent} handshakes`)}`);
  return out.join('\n');
}

function httpSection(r) {
  const out = [section('http')];
  if (!r || !r.data) return [...out, `${IND}${c.coral(r ? r.summary : 'not run')}`].join('\n');
  const d = r.data;
  if (!d.reachable) return [...out, `${IND}${c.coral(`No answer on HTTPS or HTTP (${d.error})`)}`].join('\n');

  const codeColor = d.status >= 500 ? 'coral' : d.status >= 400 ? 'amber' : d.status >= 300 ? 'sky' : 'signal';
  out.push(`${IND}${c.bold(c[codeColor](d.status))} ${c[codeColor](d.statusText || '')}   ${c.muted(`HTTP/${d.httpVersion}`)}   ${c.text(d.finalUrl)}`);

  const t = d.timings;
  const phases = [
    ['connect', t.connect, 'sky'],
    ['tls', t.tls != null ? t.tls - t.connect : null, 'violet'],
    ['first byte', t.ttfb - (t.tls ?? t.connect), 'signal'],
    ['download', t.total - t.ttfb, 'amber'],
  ].filter(([, v]) => v != null && v >= 0);
  const barW = Math.max(20, Math.min(46, cols() - 34));
  const total = Math.max(1, t.total);
  let offset = 0;
  out.push('');
  for (const [name, v, color] of phases) {
    const before = offset / total;
    offset += v;
    const lead = Math.round(before * barW);
    const len = Math.max(1, Math.round((v / total) * barW));
    const bar = c.dim(sym.light.repeat(lead)) + c[color](sym.block.repeat(Math.min(len, barW - lead))) + c.dim(sym.light.repeat(Math.max(0, barW - lead - len)));
    out.push(`${IND}${pad(c.muted(name), 11)} ${bar}  ${pad(ms(v), 9, 'right')}`);
  }
  out.push(`${IND}${pad(c.muted('total'), 11)} ${' '.repeat(barW)}  ${pad(c.bold(ms(t.total)), 9, 'right')}`);
  out.push('');

  const kv = [
    ['title', d.title], ['server', d.server], ['cdn', d.cdn], ['powered by', d.poweredBy],
    ['type', (d.contentType || '').split(';')[0]], ['size', d.size ? `${(d.size / 1024).toFixed(1)} KB` : null],
  ].filter(([, v]) => v);
  for (const [k, v] of kv) out.push(`${IND}${pad(c.muted(k), 11)} ${truncate(String(v), cols() - 16)}`);

  if (d.chain.length > 1) {
    const hops = d.chain.map((h) => `${c.status(h.status && h.status < 400 ? (h.status >= 300 ? 'pending' : 'ok') : 'fail', h.status ?? '✕')} ${h.url}`);
    out.push(`${IND}${pad(c.muted('redirects'), 11)} ${hops[0]}`);
    for (const h of hops.slice(1)) out.push(`${IND}${' '.repeat(11)} ${c.dim('↳')} ${h}`);
  }
  return out.join('\n');
}

function tlsSection(r) {
  const out = [section('tls certificate')];
  if (!r || !r.data) return [...out, `${IND}${c.coral(r ? r.summary : 'not run')}`].join('\n');
  const d = r.data;
  if (!d.available) return [...out, `${IND}${c.coral(`No TLS handshake on port ${d.port} (${d.error})`)}`].join('\n');

  const trust = d.trusted ? c.signal(`${sym.tick} trusted`) : c.coral(`${sym.cross} ${d.trustError || 'not trusted'}`);
  out.push(`${IND}${trust}   ${c.text(d.protocol)}   ${d.alpn ? c.text(d.alpn) : ''}   ${c.muted(d.cipher || '')}`);

  const color = d.daysLeft < 0 ? 'coral' : d.daysLeft <= 14 ? 'amber' : 'signal';
  const frac = d.lifetime ? Math.max(0, Math.min(1, d.daysLeft / d.lifetime)) : 0;
  const expiry = d.validTo ? d.validTo.slice(0, 10) : '?';
  const left = d.daysLeft < 0 ? c.coral(`expired ${-d.daysLeft} days ago`) : c[color](`${d.daysLeft} days left`);
  out.push(`${IND}${meter([[frac, color]], 24)}  ${left}  ${c.muted(`until ${expiry}`)}`);
  out.push('');
  const kv = [
    ['issued to', d.subject], ['issuer', d.issuerOrg || d.issuer],
    ['names', d.sanCount ? `${d.sans.slice(0, 4).join(', ')}${d.sanCount > 4 ? c.muted(`  +${d.sanCount - 4}`) : ''}` : null],
    ['key', d.keyType ? `${d.keyType}${d.keyBits ? ` ${d.keyBits}-bit` : ''}` : null],
    ['chain', d.chain.length ? d.chain.map((x) => x.subject).join(c.dim(` ${sym.arrow} `)) : null],
  ].filter(([, v]) => v);
  for (const [k, v] of kv) out.push(`${IND}${pad(c.muted(k), 11)} ${truncate(String(v), cols() - 16)}`);
  return out.join('\n');
}

function dnsSection(r) {
  const out = [section(r?.data?.kind === 'reverse' ? 'reverse dns' : 'dns records')];
  if (!r || !r.data) return [...out, `${IND}${c.coral(r ? r.summary : 'not run')}`].join('\n');
  const d = r.data;
  const types = Object.keys(d.records);
  if (!types.length) out.push(`${IND}${c.muted('No records found')}`);
  for (const type of types) {
    d.records[type].slice(0, 8).forEach((rec, i) => {
      const label = i === 0 ? c.signal(pad(type, 6)) : ' '.repeat(6);
      const prio = rec.priority != null ? c.muted(pad(String(rec.priority), 4)) : '';
      out.push(`${IND}${label} ${prio}${truncate(rec.value, cols() - 16)}`);
    });
    if (d.records[type].length > 8) out.push(`${IND}${' '.repeat(7)}${c.muted(`+${d.records[type].length - 8} more`)}`);
  }
  if (d.mail) {
    const flag = (ok, name) => (ok ? c.signal(`${sym.tick} ${name}`) : c.coral(`${sym.cross} ${name}`));
    out.push('', `${IND}${pad(c.muted('mail auth'), 11)} ${flag(d.mail.spf, 'SPF')}   ${flag(d.mail.dmarc, 'DMARC')}`);
  }
  return out.join('\n');
}

function portsSection(r) {
  const out = [section('ports', r?.data ? `${r.data.open} open of ${r.data.ports.length}` : '')];
  if (!r || !r.data) return [...out, `${IND}${c.coral(r ? r.summary : 'not run')}`].join('\n');
  const cellW = 18;
  const perRow = Math.max(2, Math.floor((cols() - 4) / cellW));
  const cells = r.data.ports.map((p) => {
    const label = `${p.port} ${(p.service || '').toLowerCase()}`;
    if (p.state === 'open') {
      const risky = RISKY_PORTS.has(p.port);
      return pad(`${c[risky ? 'amber' : 'signal'](sym.ok)} ${c[risky ? 'amber' : 'text'](label)}`, cellW);
    }
    return pad(`${c.dim(p.state === 'closed' ? sym.pending : sym.dot)} ${c.dim(label)}`, cellW);
  });
  for (let i = 0; i < cells.length; i += perRow) out.push(`${IND}${cells.slice(i, i + perRow).join('')}`);
  out.push(`${IND}${c.muted(`${sym.ok} open   ${sym.pending} closed   ${sym.dot} filtered`)}`);
  return out.join('\n');
}

function securitySection(r) {
  if (!r || !r.data || !r.data.reachable) return '';
  const short = {
    'strict-transport-security': 'hsts', 'content-security-policy': 'csp', 'x-frame-options': 'x-frame-options',
    'x-content-type-options': 'x-content-type-options', 'referrer-policy': 'referrer-policy', 'permissions-policy': 'permissions-policy',
  };
  const out = [section('security headers', `${r.data.securityScore} of 6`)];
  const items = Object.entries(r.data.security).map(([k, v]) => (v ? c.signal(`${sym.tick} ${short[k]}`) : c.dim(`${sym.cross} ${short[k]}`)));
  const perRow = cols() > 100 ? 6 : 3;
  for (let i = 0; i < items.length; i += perRow) out.push(`${IND}${items.slice(i, i + perRow).map((s) => pad(s, 26)).join('')}`);
  return out.join('\n');
}

function networkSection(report) {
  const out = [section('network')];
  const res = report.results.resolve;
  const g = report.results.geo;
  if (res && res.data.addresses.length > 1) {
    out.push(`${IND}${pad(c.muted('addresses'), 11)} ${res.data.addresses.map((a) => a.address).join(c.dim('  '))}`);
  }
  if (!g || !g.data) {
    out.push(`${IND}${c.muted('Geolocation lookup unavailable')}`);
    return out.join('\n');
  }
  const d = g.data;
  const place = [d.city, d.region !== d.city ? d.region : null, d.country].filter(Boolean).join(', ');
  const kv = [
    ['location', `${place}${d.countryCode ? c.muted(`  [${d.countryCode}]`) : ''}`],
    ['asn', [d.asn, d.org || d.isp].filter(Boolean).join('  ')],
    ['isp', d.isp && d.isp !== d.org ? d.isp : null],
    ['coords', d.lat != null ? `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}` : null],
    ['timezone', d.timezone],
  ].filter(([, v]) => v);
  for (const [k, v] of kv) out.push(`${IND}${pad(c.muted(k), 11)} ${v}`);
  return out.join('\n');
}

function details(report) {
  const r = report.results;
  return [
    latencySection(r.ping), httpSection(r.http), tlsSection(r.tls), securitySection(r.http),
    dnsSection(r.dns), portsSection(r.ports), networkSection(report),
  ].filter(Boolean).join('\n');
}

/* ---------------- worldwide ---------------- */

function globalTable(state, spin, kinds) {
  const w = cols();
  const lines = [section('worldwide', state ? `${state.nodes.length} nodes via check-host.net` : 'contacting check-host.net')];
  if (!state) return [...lines, `${IND}${c.sky(spin)} ${c.muted('picking nodes…')}`].join('\n');

  const nodes = [...state.nodes];
  if (state.done) {
    nodes.sort((a, b) => (a.results.ping?.avg ?? 1e9) - (b.results.ping?.avg ?? 1e9));
  }
  const placeW = Math.min(26, Math.max(16, w - 70));
  const barW = w >= 110 ? 18 : 10;
  for (const n of nodes) {
    const p = n.results.ping;
    const h = n.results.http || n.results.tcp;
    const reachable = (p && p.ok) || (h && h.ok);
    const pending = !p || (kinds.length > 1 && !h);
    const icon = pending ? c.sky(spin) : reachable ? c.signal(sym.ok) : c.coral(sym.fail);
    const place = `${c.muted(pad(n.cc || '··', 3))}${truncate(n.city || n.country || n.id, placeW - 3)}`;

    let ping = c.dim(pad('…', 30));
    if (p) {
      if (p.ok) {
        const spark = sparkline(p.times);
        ping = `${pad(spark, 5)} ${pad(c[speedColor(p.avg)](ms(p.avg, 1)), 10, 'right')} ${c.muted(pad(`${p.received}/${p.sent}`, 4))} ${meter([[Math.min(1, p.avg / 400), speedColor(p.avg)]], barW)}`;
      } else {
        ping = pad(c.coral(truncate(p.error || 'no reply', 20)), 21 + barW);
      }
    }
    let http = '';
    if (kinds.includes('http') || kinds.includes('tcp')) {
      if (!h) http = c.dim('…');
      else if (h.ok) http = `${c.signal(h.code || 'open')} ${c.muted(ms(h.ms))}`;
      else http = c.coral(truncate(h.code ? `${h.code} ${h.message || ''}` : (h.error || h.message || 'failed'), 22));
    }
    lines.push(`${IND}${icon} ${pad(place, placeW)} ${ping}  ${http}`);
  }

  if (state.done) {
    const total = state.nodes.length;
    const up = state.nodes.filter((n) => n.results.ping?.ok || n.results.http?.ok || n.results.tcp?.ok).length;
    const avgs = state.nodes.map((n) => n.results.ping?.avg).filter((v) => v != null).sort((a, b) => a - b);
    const median = avgs.length ? avgs[Math.floor(avgs.length / 2)] : null;
    const color = up === total ? 'signal' : up >= total * 0.7 ? 'amber' : 'coral';
    lines.push('', `${IND}${c[color](`reachable from ${up} of ${total} nodes`)}${median != null ? c.muted(`   median ping ${ms(median, 1)}`) : ''}${state.link ? c.muted(`   ${state.link}`) : ''}`);
  }
  return lines.join('\n');
}

/* ---------------- verdict ---------------- */

function findings(report, world) {
  const r = report.results;
  const list = [];
  const add = (level, text) => list.push([level, text]);
  if (r.http?.data) {
    const d = r.http.data;
    if (!d.reachable) add('fail', 'Not answering on HTTP or HTTPS');
    else {
      if (!d.https) add('warn', 'Served over plain HTTP, not HTTPS');
      if (d.status >= 500) add('fail', `Server error ${d.status}`);
      else if (d.status >= 400) add('warn', `Responds with ${d.status}`);
      const missing = Object.entries(d.security).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length >= 4) add('warn', `Missing ${missing.length} of 6 security headers`);
    }
  }
  if (r.tls?.data) {
    const t = r.tls.data;
    if (t.available && !t.trusted) add('fail', `Certificate not trusted (${t.trustError})`);
    else if (t.available && t.daysLeft < 0) add('fail', 'Certificate has expired');
    else if (t.available && t.daysLeft <= 14) add('warn', `Certificate expires in ${t.daysLeft} days`);
    if (t.available && !/TLSv1\.[23]/.test(t.protocol || '')) add('warn', `Outdated protocol ${t.protocol}`);
  }
  if (r.ports?.data) {
    for (const p of r.ports.data.ports) if (p.state === 'open' && RISKY_PORTS.has(p.port)) add('warn', `${p.service} (${p.port}) is open to the internet`);
  }
  if (r.dns?.data?.mail) {
    if (!r.dns.data.mail.spf) add('info', 'No SPF record');
    if (!r.dns.data.mail.dmarc) add('info', 'No DMARC record');
  }
  if (r.ping?.data?.loss > 0) add('warn', `${r.ping.data.loss}% packet loss from this machine`);
  if (world && world.done) {
    const down = world.nodes.filter((n) => !(n.results.ping?.ok || n.results.http?.ok || n.results.tcp?.ok));
    if (down.length) add(down.length > world.nodes.length / 2 ? 'fail' : 'warn', `Unreachable from ${down.map((n) => n.city || n.cc).slice(0, 5).join(', ')}${down.length > 5 ? ` +${down.length - 5}` : ''}`);
  }
  return list;
}

function verdict(report, world, elapsedMs) {
  const { value, grade } = report.score;
  const color = grade.startsWith('A') ? 'signal' : grade === 'B' || grade === 'C' ? 'amber' : 'coral';
  const g = pad(grade, 2);
  const box = [
    `${IND}${c[color]('╭────────╮')}`,
    `${IND}${c[color]('│')}   ${c.bold(c[color](g))}   ${c[color]('│')}   ${c.bold(`${value}`)}${c.muted('/100')}   ${meter([[value / 100, color]], 30)}`,
    `${IND}${c[color]('╰────────╯')}   ${c.muted(`${report.target} checked in ${(elapsedMs / 1000).toFixed(1)} s`)}`,
  ];
  const f = findings(report, world);
  const lines = ['', ...box, ''];
  if (!f.length) lines.push(`${IND}${c.signal(`${sym.tick} Nothing to fix. Clean bill of health.`)}`);
  for (const [level, text] of f) {
    const icon = level === 'fail' ? c.coral(sym.fail) : level === 'warn' ? c.amber(sym.warn) : c.sky(sym.dot);
    lines.push(`${IND}${icon} ${level === 'info' ? c.muted(text) : text}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { header, targetLine, probeRows, details, globalTable, verdict, findings };
