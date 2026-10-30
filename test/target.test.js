'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, isPrivateIP } = require('../src/target');

test('normalises URLs, ports and case', () => {
  assert.deepEqual(parseTarget('https://Example.COM/path?x=1'), { input: 'https://Example.COM/path?x=1', host: 'example.com', kind: 'domain', port: null });
  assert.equal(parseTarget('api.example.co.uk:8443').port, 8443);
  assert.equal(parseTarget('example.com.').host, 'example.com');
});

test('recognises IPv4 and IPv6', () => {
  assert.equal(parseTarget('8.8.8.8').kind, 'ip4');
  assert.equal(parseTarget('[2606:4700::1111]').kind, 'ip6');
  assert.equal(parseTarget('2606:4700::1111').host, '2606:4700::1111');
  assert.equal(parseTarget('http://[::1]:8080/').kind, 'ip6');
});

test('converts internationalised domains to punycode', () => {
  assert.match(parseTarget('بانک.ایران').host, /^xn--/);
});

test('rejects things that are not hosts', () => {
  for (const bad of ['', '   ', 'localhost', 'not a host', '1.2.3', '2130706433', 'exa_mple.com', '-bad.com']) {
    assert.throws(() => parseTarget(bad), undefined, bad);
  }
});

test('flags private and reserved ranges', () => {
  for (const ip of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIP(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIP(ip), false, ip);
  }
});
