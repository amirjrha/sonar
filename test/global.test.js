'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePing, parseHttp, parseTcp } = require('../src/global');

test('pending nodes parse to null', () => {
  assert.equal(parsePing(null), null);
  assert.equal(parseHttp(null), null);
  assert.equal(parseTcp(null), null);
});

test('parses ping replies, including partial loss', () => {
  const r = parsePing([[['OK', 0.044, '93.184.216.34'], ['TIMEOUT', 3.005], ['OK', 0.046], ['OK', 0.042]]]);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 4);
  assert.equal(r.received, 3);
  assert.equal(r.avg, 44);
  assert.equal(r.ip, '93.184.216.34');
  assert.deepEqual(r.times, [44, null, 46, 42]);
});

test('parses unresolvable ping', () => {
  const r = parsePing([[null]]);
  assert.equal(r.ok, false);
});

test('parses http success and failure', () => {
  assert.deepEqual(parseHttp([[1, 0.135, 'OK', '200', '1.2.3.4']]), { ok: true, ms: 135, message: 'OK', code: '200', ip: '1.2.3.4' });
  const f = parseHttp([[0, 10.0, 'Connection timed out', null, null]]);
  assert.equal(f.ok, false);
  assert.equal(f.message, 'Connection timed out');
});

test('parses tcp success and failure', () => {
  assert.deepEqual(parseTcp([{ time: 0.0312, address: '1.2.3.4' }]), { ok: true, ms: 31.2, ip: '1.2.3.4' });
  assert.deepEqual(parseTcp([{ error: 'Connection refused' }]), { ok: false, error: 'Connection refused' });
});
