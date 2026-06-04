const os = require('os');

/** Non-loopback IPv4 addresses on this machine (Wi‑Fi, Ethernet, etc.). */
function getLanIpv4Addresses() {
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      const family = iface.family;
      const isV4 = family === 'IPv4' || family === 4;
      if (!isV4 || iface.internal) continue;
      const ip = iface.address;
      if (ip.startsWith('169.254.')) continue;
      addrs.push({ ip, name });
    }
  }
  return addrs;
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url).trim()).hostname;
  } catch {
    return null;
  }
}

/**
 * Warn when API_PUBLIC_URL points at an IP/hostname this PC does not own
 * (common cause of ERR_CONNECTION_REFUSED on Stripe return / mobile).
 */
function warnIfApiPublicUrlMismatch() {
  const apiPublic = process.env.API_PUBLIC_URL;
  if (!apiPublic || !String(apiPublic).trim()) return;
  const host = hostnameFromUrl(apiPublic);
  if (!host || host === 'localhost' || host === '127.0.0.1') return;

  const lanIps = getLanIpv4Addresses().map((a) => a.ip);
  if (lanIps.includes(host)) return;

  const port = Number(process.env.PORT) || 4000;
  console.warn('');
  console.warn('[network] *** API_PUBLIC_URL mismatch — connection refused likely ***');
  console.warn(`[network] API_PUBLIC_URL host "${host}" is NOT assigned on this PC.`);
  console.warn(`[network] LAN IPs on this machine: ${lanIps.length ? lanIps.join(', ') : '(none detected)'}`);
  console.warn(`[network] Update API_PUBLIC_URL in .env / server/.env, e.g. http://${lanIps[0] || 'YOUR_LAN_IP'}:${port}`);
  console.warn('');
}

module.exports = { getLanIpv4Addresses, warnIfApiPublicUrlMismatch, hostnameFromUrl };
