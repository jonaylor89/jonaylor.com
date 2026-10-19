import { describe, expect, it } from 'vitest';
import { charFor, encodeString } from '../src/rom/text';

describe('charmap', () => {
  it('encodes and decodes names', () => {
    const bytes = encodeString('ASH-2!');
    expect(bytes).toEqual([0x80, 0x92, 0x87, 0xe3, 0xf8, 0xe7]);
    expect(bytes.map(charFor).join('')).toBe('ASH-2!');
  });
  it('renders control characters as tokens', () => {
    expect(charFor(0x52)).toBe('{player}');
    expect(charFor(0x54)).toBe('{poke}');
  });
});
