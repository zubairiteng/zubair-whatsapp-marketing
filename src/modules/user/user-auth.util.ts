import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const [salt, key] = parts;
    const hash = scryptSync(password, salt, 64);
    const keyBuf = Buffer.from(key, 'hex');
    if (hash.length !== keyBuf.length) return false;
    return timingSafeEqual(hash, keyBuf);
  } catch {
    return false;
  }
}
