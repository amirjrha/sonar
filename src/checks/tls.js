'use strict';

const tls = require('node:tls');
const net = require('node:net');

const DAY = 86_400_000;

function name(obj) {
  if (!obj) return null;
  return obj.CN || obj.O || Object.values(obj)[0] || null;
}

/** Handshake on 443 and read the certificate chain, protocol and cipher. */
function tlsCheck(target, ip, opts = {}) {
  const port = target.port && target.port !== 80 ? target.port : 443;
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = tls.connect({
      host: ip,
      port,
      servername: net.isIP(target.host) ? undefined : target.host,
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
      timeout: opts.timeout ?? 6000,
    });

    const fail = (error) => { socket.destroy(); resolve({ available: false, port, error }); };
    socket.once('timeout', () => fail('ETIMEDOUT'));
    socket.once('error', (err) => fail(err.code || err.message));

    socket.once('secureConnect', () => {
      const handshake = Math.round(performance.now() - started);
      const cert = socket.getPeerCertificate(true);
      const chain = [];
      let c = cert;
      const seen = new Set();
      while (c && c.fingerprint256 && !seen.has(c.fingerprint256) && chain.length < 5) {
        seen.add(c.fingerprint256);
        chain.push({ subject: name(c.subject), issuer: name(c.issuer) });
        c = c.issuerCertificate;
      }

      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
      const daysLeft = validTo ? Math.floor((validTo - Date.now()) / DAY) : null;
      const lifetime = validTo && validFrom ? Math.round((validTo - validFrom) / DAY) : null;
      const sans = (cert.subjectaltname || '')
        .split(',')
        .map((s) => s.trim().replace(/^DNS:|^IP Address:/, ''))
        .filter(Boolean);

      const result = {
        available: true,
        port,
        handshakeMs: handshake,
        trusted: socket.authorized,
        trustError: socket.authorizationError || null,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name || null,
        alpn: socket.alpnProtocol || null,
        subject: name(cert.subject),
        issuer: name(cert.issuer),
        issuerOrg: cert.issuer?.O || null,
        validFrom: validFrom?.toISOString() || null,
        validTo: validTo?.toISOString() || null,
        daysLeft,
        lifetime,
        sans: sans.slice(0, 40),
        sanCount: sans.length,
        keyBits: cert.bits || null,
        keyType: cert.asn1Curve ? `EC ${cert.asn1Curve}` : cert.bits ? 'RSA' : null,
        serial: cert.serialNumber || null,
        fingerprint: cert.fingerprint256 || null,
        chain,
      };
      socket.end();
      resolve(result);
    });
  });
}

module.exports = { tlsCheck };
