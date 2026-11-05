import { describe, expect, it } from 'vitest';

import {
  getContrastColor,
  isValidHexColor,
  makeIcon,
  parseIcon,
} from './iconUtils';

describe('parseIcon', () => {
  it('parses tabler and bank icons', () => {
    expect(parseIcon('tabler:shopping-cart')).toEqual({
      set: 'tabler',
      name: 'shopping-cart',
    });
    expect(parseIcon('bank:nubank')).toEqual({ set: 'bank', name: 'nubank' });
  });

  it('round-trips with makeIcon', () => {
    expect(parseIcon(makeIcon('tabler', 'wallet'))).toEqual({
      set: 'tabler',
      name: 'wallet',
    });
  });

  it('returns undefined for empty, malformed or unknown-set values', () => {
    expect(parseIcon(null)).toBeUndefined();
    expect(parseIcon(undefined)).toBeUndefined();
    expect(parseIcon('')).toBeUndefined();
    expect(parseIcon('wallet')).toBeUndefined();
    expect(parseIcon('tabler:')).toBeUndefined();
    expect(parseIcon('emoji:smile')).toBeUndefined();
  });
});

describe('isValidHexColor', () => {
  it('accepts 6-digit hex colors only', () => {
    expect(isValidHexColor('#820ad1')).toBe(true);
    expect(isValidHexColor('#ABCDEF')).toBe(true);
    expect(isValidHexColor('#fff')).toBe(false);
    expect(isValidHexColor('#820ad1ff')).toBe(false);
    expect(isValidHexColor('red')).toBe(false);
    expect(isValidHexColor(null)).toBe(false);
  });
});

describe('getContrastColor', () => {
  it('uses white on dark backgrounds and black on light ones', () => {
    expect(getContrastColor('#000000')).toBe('#ffffff');
    expect(getContrastColor('#820ad1')).toBe('#ffffff');
    expect(getContrastColor('#ffffff')).toBe('#000000');
    expect(getContrastColor('#ffe700')).toBe('#000000');
  });

  it('falls back to white for invalid colors', () => {
    expect(getContrastColor('nope')).toBe('#ffffff');
  });
});
