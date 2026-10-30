'use strict';

/**
 * Worldwide checks through the public check-host.net API: the same target is
 * probed from nodes in many countries, so you can see whether it is reachable
 * (and how fast) from outside your own network.
 */

const BASE = process.env.CHECKHOST_API || 'https://check-host.net';
const UA = 'sonar-checkhost (+https://github.com/)';

async function api(path, params = []) {
  const url = new URL(path, BASE);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) throw new Error('check-host.net rate limit reached, try again in a minute');
  if (!res.ok) throw new Error(`check-host.net answered HTTP ${res.status}`);
  return res.json();
}

async function startCheck(type, host, { maxNodes, nodes } = {}) {
  const params = [['host', host]];
  if (nodes && nodes.length) for (const n of nodes) params.push(['node', n]);
  else params.push(['max_nodes', String(maxNodes || 20)]);
  const body = await api(`/check-${type}`, params);
  if (!body.ok || !body.request_id) throw new Error(body.error || 'check-host.net refused the check');
  return { id: body.request_id, link: body.permanent_link, nodes: body.nodes || {} };
}

/* ---- result parsers: each returns null while the node is still working ---- */

function parsePing(v) {
  if (v == null) return null;
  const rows = Array.isArray(v) && Array.isArray(v[0]) ? v[0] : [];
  const pings = rows.filter(Array.isArray);
  if (!pings.length) return { ok: false, error: 'Could not resolve', sent: 0, received: 0, times: [] };
  const times = pings.map((p) => (p[0] === 'OK' && typeof p[1] === 'number' ? Math.round(p[1] * 10000) / 10 : null));
  const okTimes = times.filter((t) => t != null);
  return {
    ok: okTimes.length > 0,
    sent: pings.length,
    received: okTimes.length,
    times,
    avg: okTimes.length ? Math.round((okTimes.reduce((a, b) => a + b, 0) / okTimes.length) * 10) / 10 : null,
    ip: (pings.find((p) => typeof p[2] === 'string') || [])[2] || null,
    error: okTimes.length ? null : (pings[0][0] || 'TIMEOUT'),
  };
}

function parseHttp(v) {
  if (v == null) return null;
  const r = Array.isArray(v) && Array.isArray(v[0]) ? v[0] : null;
  if (!r) return { ok: false, error: 'No result' };
  return {
    ok: r[0] === 1,
    ms: typeof r[1] === 'number' ? Math.round(r[1] * 1000) : null,
    message: r[2] || null,
    code: r[3] != null ? String(r[3]) : null,
    ip: r[4] || null,
  };
}

function parseTcp(v) {
  if (v == null) return null;
  const r = Array.isArray(v) ? v[0] : v;
  if (!r || typeof r !== 'object') return { ok: false, error: 'No result' };
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, ms: typeof r.time === 'number' ? Math.round(r.time * 10000) / 10 : null, ip: r.address || null };
}

const PARSERS = { ping: parsePing, http: parseHttp, tcp: parseTcp };

/**
 * Run `checks` (e.g. [['ping', 'example.com'], ['http', 'https://example.com']])
 * on the same set of nodes. `onUpdate(state)` fires after every poll.
 */
async function globalCheck(checks, { maxNodes = 20, timeoutMs = 30_000, onUpdate = () => {} } = {}) {
  const [firstType, firstHost] = checks[0];
  const first = await startCheck(firstType, firstHost, { maxNodes });
  const nodeIds = Object.keys(first.nodes);
  const started = [{ type: firstType, ...first }];
  for (const [type, host] of checks.slice(1)) {
    try { started.push({ type, ...(await startCheck(type, host, { nodes: nodeIds })) }); } catch { /* keep what we have */ }
  }

  const state = {
    link: first.link,
    nodes: nodeIds.map((id) => {
      const info = first.nodes[id] || [];
      return { id, cc: (info[0] || '').toUpperCase(), country: info[1] || '', city: info[2] || '', results: {} };
    }),
    done: false,
  };
  onUpdate(state);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let pending = 0;
    await Promise.all(started.map(async (chk) => {
      let body;
      try { body = await api(`/check-result/${encodeURIComponent(chk.id)}`); } catch { pending += 1; return; }
      for (const node of state.nodes) {
        const parsed = PARSERS[chk.type](body ? body[node.id] : null);
        if (parsed) node.results[chk.type] = parsed;
        else pending += 1;
      }
    }));
    onUpdate(state);
    if (!pending) break;
  }
  state.done = true;
  for (const node of state.nodes) {
    for (const chk of started) if (!node.results[chk.type]) node.results[chk.type] = { ok: false, error: 'No answer in time', timeout: true };
  }
  onUpdate(state);
  return state;
}

module.exports = { globalCheck, parsePing, parseHttp, parseTcp };
