/**
 * Time-based one-time passwords (RFC 6238), the 6-digit 2FA codes. The secret
 * is a base32 string or an otpauth://totp/ URI as shown in a site's QR code.
 */

export interface TotpConfig {
  secret: Uint8Array<ArrayBuffer>;
  digits: 6 | 7 | 8;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('The 2FA secret is not valid base32.');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const ALGORITHMS: Record<string, TotpConfig['algorithm']> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** Reads a base32 secret or an otpauth://totp/ URI. Throws a readable error. */
export function parseTotp(input: string): TotpConfig {
  const value = input.trim();
  if (!/^otpauth:/i.test(value)) return { secret: decodeBase32(value), digits: 6, period: 30, algorithm: 'SHA-1' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The 2FA link is not valid.');
  }
  if (url.host.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) 2FA codes are supported.');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('The 2FA link has no secret.');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  const algorithm = ALGORITHMS[(url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()];
  if (digits !== 6 && digits !== 7 && digits !== 8) throw new Error('The 2FA link asks for an unsupported code length.');
  if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error('The 2FA link has an unsupported period.');
  if (!algorithm) throw new Error('The 2FA link uses an unsupported algorithm.');
  return { secret: decodeBase32(secret), digits, period, algorithm };
}

/** True when `input` can produce codes. */
export function isValidTotp(input: string): boolean {
  try {
    return parseTotp(input).secret.length > 0;
  } catch {
    return false;
  }
}

/** The code for `timeMs`, and seconds until it changes. */
export async function totpCode(input: string | TotpConfig, timeMs = Date.now()): Promise<{ code: string; remaining: number }> {
  const config = typeof input === 'string' ? parseTotp(input) : input;
  const counter = Math.floor(timeMs / 1000 / config.period);
  const message = new Uint8Array(8);
  // 8-byte big-endian counter; the high half stays 0 until the year 10889.
  new DataView(message.buffer).setUint32(4, counter);
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const key = await crypto.subtle.importKey('raw', config.secret, { name: 'HMAC', hash: config.algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const code = (binary % 10 ** config.digits).toString().padStart(config.digits, '0');
  const remaining = config.period - (Math.floor(timeMs / 1000) % config.period);
  return { code, remaining };
}
