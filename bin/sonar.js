#!/usr/bin/env node
'use strict';

const { runChecks } = require('../src/runner');
const { parseTarget, isPrivateIP, TargetError } = require('../src/target');
const { globalCheck } = require('../src/global');
const term = require('../src/ui/term');
const ui = require('../src/ui/report');
const pkg = require('../package.json');

const HELP = `
  sonar — check-host for your terminal

  Usage
    sonar <domain | ip | url> [more targets…] [options]

  Examples
    sonar github.com
    sonar 1.1.1.1 --nodes 30
    sonar https://example.com/login --local
    sonar example.com --ports 22,80,443,3306 --json > report.json

  Options
    -l, --local          Only run checks from this machine
    -g, --global         Only run worldwide checks (check-host.net)
    -n, --nodes <n>      Number of worldwide nodes (default 16, max 40)
    -p, --ports <list>   Ports to scan, comma separated (default: 20 common ports)
    -c, --count <n>      TCP pings to send (default 8)
        --no-ports       Skip the port scan
        --json           Print machine-readable JSON instead of the report
        --no-color       Disable colours (NO_COLOR is honoured too)
    -h, --help           Show this help
    -v, --version        Show the version

  Exit code is 0 when every target is reachable and grades C or better, 1 otherwise.
`;

function parseArgs(argv) {
  const opts = { targets: [], local: true, global: true, nodes: 16, json: false, ports: undefined, count: 8, skip: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null || v.startsWith('-')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-l': case '--local': opts.global = false; break;
      case '-g': case '--global': opts.local = false; break;
      case '-n': case '--nodes': opts.nodes = Math.max(1, Math.min(40, Number(next()) || 16)); break;
      case '-c': case '--count': opts.count = Math.max(1, Math.min(50, Number(next()) || 8)); break;
      case '-p': case '--ports':
        opts.ports = next().split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
        if (!opts.ports.length) throw new Error('--ports needs numbers like 22,80,443');
        break;
      case '--no-ports': opts.skip.push('ports'); break;
      case '--json': opts.json = true; break;
      case '--no-color': term.setColor(false); break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        opts.targets.push(a);
    }
  }
  return opts;
}

function globalPlan(target, local) {
  const host = target.kind === 'ip6' ? `[${target.host}]` : target.host;
  const plan = [['ping', target.host]];
  const http = local?.results.http?.data;
  if (http?.reachable) {
    const u = new URL(http.finalUrl);
    plan.push(['http', `${u.protocol}//${u.host}${u.pathname}`]);
  } else if (target.kind === 'domain') {
    plan.push(['http', `https://${host}${target.port ? `:${target.port}` : ''}`]);
  } else {
    plan.push(['tcp', `${host}:${target.port || local?.results.ping?.data?.port || 443}`]);
  }
  return plan;
}

async function checkOne(input, opts) {
  const started = performance.now();
  const target = parseTarget(input);
  const report = { target: target.host, results: {}, score: null };
  const out = process.stdout;

  // ---- from this machine ----
  let local = null;
  if (opts.local) {
    if (!opts.json) out.write(`${ui.targetLine(report)}\n\n`);
    const live = opts.json ? null : new term.LiveBlock((spin) => ui.probeRows(report, spin));
    try {
      local = await runChecks(input, (event, data) => {
        if (event === 'check') report.results[data.id] = data;
      }, { allowPrivate: true, ports: opts.ports, count: opts.count, skip: opts.skip });
      report.score = local.score;
    } finally {
      if (live) live.done();
    }
    if (!opts.json) out.write(`${ui.details(report)}\n`);
  } else if (!opts.json) {
    out.write(`${ui.targetLine(report)}\n`);
  }

  // ---- worldwide ----
  let world = null;
  let worldError = null;
  const ip = local?.ip || (target.kind !== 'domain' ? target.host : null);
  if (opts.global && ip && isPrivateIP(ip)) {
    worldError = 'skipped: private address is not reachable from the internet';
  } else if (opts.global) {
    const plan = globalPlan(target, local);
    const kinds = plan.map(([k]) => k);
    let state = null;
    const live = opts.json ? null : new term.LiveBlock((spin) => ui.globalTable(state, spin, kinds));
    try {
      world = await globalCheck(plan, { maxNodes: opts.nodes, onUpdate: (s) => { state = s; } });
    } catch (err) {
      worldError = err.message;
    } finally {
      if (live) {
        if (!world) live.render = () => `${ui.globalTable(null, ' ', kinds).split('\n').slice(0, 2).join('\n')}\n  ${term.c.coral(worldError || 'failed')}`;
        live.done();
      }
    }
  }
  if (worldError && !opts.json && !world && opts.global && /skipped/.test(worldError)) {
    out.write(`\n  ${term.c.muted(`worldwide check ${worldError}`)}\n`);
  }

  const elapsed = Math.round(performance.now() - started);
  if (!opts.json && report.score) out.write(ui.verdict(report, world, elapsed));
  else if (!opts.json) out.write('\n');

  const reachableLocal = local ? local.results.ping?.data?.received > 0 || local.results.http?.data?.reachable : true;
  const reachableWorld = world ? world.nodes.some((n) => n.results.ping?.ok || n.results.http?.ok || n.results.tcp?.ok) : true;
  const healthy = reachableLocal && reachableWorld && (!report.score || report.score.value >= 60);

  return {
    healthy,
    json: {
      target: target.host,
      input,
      checkedAt: new Date().toISOString(),
      elapsedMs: elapsed,
      score: report.score,
      findings: report.score ? ui.findings(report, world).map(([level, text]) => ({ level, text })) : [],
      local: local ? { ip: local.ip, results: local.results } : null,
      worldwide: world ? { link: world.link, nodes: world.nodes } : worldError ? { error: worldError } : null,
    },
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`\n  ${term.c.coral(err.message)}\n  Run sonar --help for usage.\n\n`);
    process.exit(2);
  }
  if (opts.version) { process.stdout.write(`${pkg.version}\n`); return; }
  if (opts.help || !opts.targets.length) { process.stdout.write(`${term.c.bold(HELP.split('\n')[1])}\n${HELP.split('\n').slice(2).join('\n')}`); process.exit(opts.help ? 0 : 2); }
  if (opts.json) term.setColor(false);

  process.on('SIGINT', () => { process.stdout.write('\x1b[?25h\n'); process.exit(130); });

  if (!opts.json) process.stdout.write(`${ui.header(pkg.version)}\n`);
  const results = [];
  let ok = true;
  for (const t of opts.targets) {
    try {
      const r = await checkOne(t, opts);
      results.push(r.json);
      ok = ok && r.healthy;
    } catch (err) {
      ok = false;
      const msg = err instanceof TargetError ? err.message : `Check failed: ${err.message}`;
      if (opts.json) results.push({ input: t, error: err.code || 'ERROR', message: msg });
      else process.stdout.write(`\n  ${term.c.coral(term.sym.fail)} ${term.c.bold(t)}  ${term.c.coral(msg)}\n\n`);
    }
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main();
