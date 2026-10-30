'use strict';

const net = require('node:net');

/** Open a TCP connection and report how long the handshake took. */
function tcpConnect(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: ip, port });
    let settled = false;
    const done = (state, extra = {}) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, state, ms: Math.round((performance.now() - started) * 10) / 10, ...extra });
    };
    socket.setTimeout(timeout, () => done('filtered'));
    socket.once('connect', () => done('open'));
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'closed' : 'filtered', { code: err.code }));
  });
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const jitter = values.length > 1
    ? values.slice(1).reduce((acc, v, i) => acc + Math.abs(v - values[i]), 0) / (values.length - 1)
    : 0;
  const round = (n) => Math.round(n * 10) / 10;
  return { min: round(sorted[0]), max: round(sorted.at(-1)), avg: round(avg), jitter: round(jitter) };
}

/**
 * "Ping" over TCP. ICMP needs raw sockets (root), TCP handshakes do not and
 * are what firewalls usually let through anyway.
 */
async function pingCheck(ip, opts = {}) {
  const count = opts.count ?? 8;
  const candidates = opts.port ? [opts.port] : [443, 80, 22];

  let port = null;
  for (const p of candidates) {
    const probe = await tcpConnect(ip, p, 2500);
    if (probe.state === 'open') { port = p; break; }
  }
  if (!port) return { port: null, sent: count, received: 0, loss: 100, samples: [], stats: null };

  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const r = await tcpConnect(ip, port, 2500);
    samples.push(r.state === 'open' ? r.ms : null);
    await new Promise((res) => setTimeout(res, 120));
  }
  const ok = samples.filter((s) => s !== null);
  return {
    port,
    sent: count,
    received: ok.length,
    loss: Math.round(((count - ok.length) / count) * 100),
    samples,
    stats: stats(ok),
  };
}

const COMMON_PORTS = {
  21: 'FTP', 22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 143: 'IMAP',
  443: 'HTTPS', 465: 'SMTPS', 587: 'Submission', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MSSQL', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 6379: 'Redis',
  8080: 'HTTP-alt', 8443: 'HTTPS-alt', 27017: 'MongoDB',
};

async function portsCheck(ip, opts = {}) {
  const ports = opts.ports || Object.keys(COMMON_PORTS).map(Number);
  const concurrency = 8;
  const results = [];
  let index = 0;
  async function worker() {
    while (index < ports.length) {
      const port = ports[index++];
      const r = await tcpConnect(ip, port, opts.timeout ?? 1800);
      results.push({ ...r, service: COMMON_PORTS[port] || null });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.port - b.port);
  return {
    ports: results.map(({ port, state, ms, service }) => ({ port, state, ms: state === 'open' ? ms : null, service })),
    open: results.filter((r) => r.state === 'open').length,
  };
}

module.exports = { tcpConnect, pingCheck, portsCheck, COMMON_PORTS };
