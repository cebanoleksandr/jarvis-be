import { sanitizeForHistory } from './anthropic.provider.js';

describe('sanitizeForHistory', () => {
  it('leaves content without a fallback untouched', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'hi' },
    ];
    expect(sanitizeForHistory(content)).toBe(content);
  });

  it('keeps only text before the last fallback marker and drops the marker', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'text', text: 'partial ' },
      { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } },
      { type: 'thinking', thinking: '', signature: 'b' },
      { type: 'text', text: 'rest' },
    ];
    expect(sanitizeForHistory(content)).toEqual([
      { type: 'text', text: 'partial ' },
      { type: 'thinking', thinking: '', signature: 'b' },
      { type: 'text', text: 'rest' },
    ]);
  });
});
