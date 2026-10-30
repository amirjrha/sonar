'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { runChecks } = require('../src/runner');

test('runs every probe against a local HTTP server', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' });
    res.end('<title>Local test</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const events = [];
  const report = await runChecks(`127.0.0.1:${port}`, (e, d) => events.push([e, d.id]), {
    allowPrivate: true, ports: [port], count: 3, skip: ['geo'],
  });
  server.close();

  assert.equal(events[0][0], 'start');
  assert.equal(events.at(-1)[0], 'done');
  assert.equal(report.results.ping.data.received, 3);
  assert.equal(report.results.http.data.status, 200);
  assert.equal(report.results.http.data.title, 'Local test');
  assert.equal(report.results.ports.data.open, 1);
  assert.ok(report.score.value >= 0 && report.score.value <= 100);
});

test('refuses private targets unless allowed', async () => {
  await assert.rejects(runChecks('192.168.1.1'), { code: 'BLOCKED' });
});
