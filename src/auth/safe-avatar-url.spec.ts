import { describe, expect, it } from 'vitest';
import { safeAvatarUrl } from './auth.service.js';

describe('safeAvatarUrl', () => {
  it('keeps https URLs', () => {
    const url = 'https://lh3.googleusercontent.com/a/abc=s96-c';
    expect(safeAvatarUrl(url)).toBe(url);
  });

  it('drops missing, non-https, malformed and oversized values', () => {
    expect(safeAvatarUrl(undefined)).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl('http://example.com/a.png')).toBeNull();
    expect(safeAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(safeAvatarUrl('not a url')).toBeNull();
    expect(safeAvatarUrl(`https://x.com/${'a'.repeat(2100)}`)).toBeNull();
  });
});
