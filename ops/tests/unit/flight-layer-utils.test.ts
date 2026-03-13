import { describe, expect, it } from 'vitest';
import { getAltitudeBand } from '../../../app/src/components/layers/flightLayerUtils';

describe('flight layer utils', () => {
  it('classifies altitude bands consistently', () => {
    expect(getAltitudeBand(41000)).toBe('cruise');
    expect(getAltitudeBand(24000)).toBe('high');
    expect(getAltitudeBand(12000)).toBe('mid');
    expect(getAltitudeBand(4500)).toBe('low');
    expect(getAltitudeBand(500)).toBe('ground');
  });
});
