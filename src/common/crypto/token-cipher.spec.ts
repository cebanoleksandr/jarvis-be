import { randomBytes } from 'node:crypto';
import { TokenCipher } from './token-cipher.js';

describe('TokenCipher', () => {
  const cipher = new TokenCipher(randomBytes(32));

  it('round-trips', () => {
    const secret = '1//0g-refresh-token';
    const enc = cipher.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(cipher.decrypt(enc)).toBe(secret);
  });

  it('uses a fresh IV each time', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('rejects tampered ciphertext', () => {
    const parts = cipher.encrypt('secret').split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'))).toThrow();
  });

  it('rejects a different key', () => {
    const other = new TokenCipher(randomBytes(32));
    expect(() => other.decrypt(cipher.encrypt('secret'))).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new TokenCipher(randomBytes(16))).toThrow();
  });
});
