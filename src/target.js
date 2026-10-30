'use strict';

const net = require('node:net');

const MAX_LEN = 253;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

class TargetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Normalise whatever the user typed (URL, host:port, bare IP, IDN…) into a
 * host we can probe. Paths, query strings and credentials are dropped.
 */
function parseTarget(raw) {
  if (typeof raw !== 'string') throw new TargetError('EMPTY', 'Target is required');
  let input = raw.trim();
  if (!input) throw new TargetError('EMPTY', 'Target is required');
  if (input.length > 2048) throw new TargetError('TOO_LONG', 'Target is too long');

  let port = null;
  let host = input;

  // Bare IPv6, possibly bracketed
  const bare = input.replace(/^\[|\]$/g, '');
  if (net.isIPv6(bare)) {
    return { input, host: bare.toLowerCase(), kind: 'ip6', port: null };
  }

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`);
    host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.port) port = Number(url.port);
  } catch {
    throw new TargetError('INVALID', 'That does not look like a domain or IP address');
  }

  host = host.replace(/\.$/, '').toLowerCase();

  if (net.isIPv4(host)) {
    // URL() expands shorthand like "1.2.3" or "2130706433"; refuse anything that wasn't written out.
    if (!input.toLowerCase().includes(host)) throw new TargetError('INVALID', 'Write IPv4 addresses as four numbers, e.g. 1.1.1.1');
    return { input, host, kind: 'ip4', port };
  }
  if (net.isIPv6(host)) return { input, host, kind: 'ip6', port };

  // URL() already converted IDN to punycode
  if (host.length > MAX_LEN || !host.includes('.') || !host.split('.').every((l) => LABEL.test(l))) {
    throw new TargetError('INVALID', 'That does not look like a domain or IP address');
  }
  if (/^\d+$/.test(host.split('.').pop())) {
    throw new TargetError('INVALID', 'That does not look like a domain or IP address');
  }
  return { input, host, kind: 'domain', port };
}

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

/** True for loopback, private, link-local, CGNAT, multicast, documentation and reserved ranges. */
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIP(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (lower.startsWith('2001:db8')) return true; // documentation
    return false;
  }
  return true;
}

module.exports = { parseTarget, isPrivateIP, TargetError };
