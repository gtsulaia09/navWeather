/**
 * A self-signed HTTPS certificate for `npm run dev:phone`, so a phone on the same Wi-Fi can open the dev server.
 * Phones allow location, motion and wake lock only on secure pages (https or localhost); over plain
 * http://192.168.x.x the app cannot start navigation. The certificate is for localhost and this computer's
 * network addresses, made with `openssl`, kept in `.cert/` (ignored by git) and made again only when the addresses
 * change or it is about to expire, so the phone's "not private" warning has to be accepted only once.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export const CERT_DIR = '.cert';
export const KEY_FILE = join(CERT_DIR, 'key.pem');
export const CERT_FILE = join(CERT_DIR, 'cert.pem');
const HOSTS_FILE = join(CERT_DIR, 'hosts.txt');
const DAYS = 365; // phones refuse certificates valid for more than 825 days
const RENEW_AFTER_MS = 300 * 86_400_000;

/** This computer's IPv4 addresses on the local network (Wi-Fi, Ethernet). */
export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export function ensureDevCert() {
  const ips = lanAddresses();
  const hosts = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const fresh =
    existsSync(KEY_FILE) &&
    existsSync(CERT_FILE) &&
    existsSync(HOSTS_FILE) &&
    readFileSync(HOSTS_FILE, 'utf8') === hosts &&
    Date.now() - statSync(CERT_FILE).mtimeMs < RENEW_AFTER_MS;
  if (!fresh) {
    mkdirSync(CERT_DIR, { recursive: true });
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(DAYS),
          '-keyout', KEY_FILE, '-out', CERT_FILE, '-subj', '/CN=NavWeather dev',
          '-addext', `subjectAltName=${hosts}`,
          '-addext', 'extendedKeyUsage=serverAuth',
          '-addext', 'basicConstraints=critical,CA:FALSE',
        ],
        { stdio: 'pipe' },
      );
    } catch (e) {
      throw new Error(`Could not make the HTTPS certificate with openssl (is it installed?): ${e.stderr?.toString() || e.message}`);
    }
    writeFileSync(HOSTS_FILE, hosts);
  }
  return { ips };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ips } = ensureDevCert();
  console.log(`Certificate in ${CERT_DIR}/ for localhost${ips.length ? `, ${ips.join(', ')}` : ''}`);
}
