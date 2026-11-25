import { describe, expect, it } from 'vitest';
import { perfTierFrom } from './perfTier';

describe('rendering tier', () => {
  it('is full on ordinary phones and computers', () => {
    expect(perfTierFrom({ cores: 6 })).toBe('full');
    expect(perfTierFrom({ cores: 8, memoryGb: 8 })).toBe('full');
    expect(perfTierFrom({})).toBe('full');
  });

  it('is lite on weak devices, with Data Saver and in battery saver', () => {
    expect(perfTierFrom({ cores: 2 })).toBe('lite');
    expect(perfTierFrom({ cores: 8, memoryGb: 2 })).toBe('lite');
    expect(perfTierFrom({ cores: 8, saveData: true })).toBe('lite');
    expect(perfTierFrom({ cores: 8, batterySaver: true })).toBe('lite');
  });
});
