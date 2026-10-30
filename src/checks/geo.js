'use strict';

/**
 * IP geolocation + ASN. Two free providers, tried in order; neither needs a key.
 * Swap or add providers here if you have a paid/self-hosted source (e.g. MaxMind).
 */
const PROVIDERS = [
  {
    name: 'ipwho.is',
    url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
    map: (j) => (j.success === false ? null : {
      country: j.country, countryCode: j.country_code, region: j.region, city: j.city,
      lat: j.latitude, lon: j.longitude, timezone: j.timezone?.id || null,
      asn: j.connection?.asn ? `AS${j.connection.asn}` : null,
      org: j.connection?.org || null, isp: j.connection?.isp || null,
    }),
  },
  {
    name: 'ip-api.com',
    url: (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as`,
    map: (j) => (j.status !== 'success' ? null : {
      country: j.country, countryCode: j.countryCode, region: j.regionName, city: j.city,
      lat: j.lat, lon: j.lon, timezone: j.timezone,
      asn: j.as ? j.as.split(' ')[0] : null, org: j.org || null, isp: j.isp || null,
    }),
  },
];

const cache = new Map();
const TTL = 6 * 60 * 60 * 1000;

async function geoCheck(ip, opts = {}) {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const res = await fetch(p.url(ip), { signal: AbortSignal.timeout(opts.timeout ?? 4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mapped = p.map(await res.json());
      if (mapped) {
        const value = { ...mapped, source: p.name };
        cache.set(ip, { at: Date.now(), value });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
        return value;
      }
      errors.push(`${p.name}: no data`);
    } catch (err) {
      errors.push(`${p.name}: ${err.message}`);
    }
  }
  const e = new Error('Geolocation providers unavailable');
  e.details = errors;
  throw e;
}

module.exports = { geoCheck };
