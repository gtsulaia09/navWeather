import { describe, expect, it } from 'vitest';
import { firstTopLabelLayerId, placeholderStyleImage } from './mapLayers';

describe('images the basemap style lacks (B-15)', () => {
  it('"circle-11" becomes an 11 px dot with a transparent corner', () => {
    const img = placeholderStyleImage('circle-11');
    expect([img.width, img.height]).toEqual([11, 11]);
    expect(img.data.length).toBe(11 * 11 * 4);
    const alpha = (x: number, y: number) => img.data[(y * 11 + x) * 4 + 3];
    expect(alpha(5, 5)).toBe(255); // centre
    expect(alpha(0, 0)).toBe(0); // corner
  });

  it('anything else (e.g. a fill pattern) is invisible', () => {
    const img = placeholderStyleImage('wood-pattern');
    expect([img.width, img.height]).toEqual([1, 1]);
    expect([...img.data]).toEqual([0, 0, 0, 0]);
  });
});

describe('route layer insertion above basemap fills (B-44)', () => {
  it('picks the first symbol layer in a single-tier style (OpenFreeMap)', () => {
    const layers = [
      { id: 'background', type: 'background' },
      { id: 'water', type: 'fill' },
      { id: 'roads', type: 'line' },
      { id: 'road-labels', type: 'symbol' },
      { id: 'place-labels', type: 'symbol' },
    ];
    expect(firstTopLabelLayerId(layers)).toBe('road-labels');
  });

  it('picks regional labels above r-earth in our two-tier Protomaps style (never w-* labels buried under r-earth)', () => {
    const layers = [
      { id: 'w-earth', type: 'fill' },
      { id: 'w-roads', type: 'line' },
      { id: 'w-address_label', type: 'symbol' },
      { id: 'w-places_country', type: 'symbol' },
      { id: 'r-earth', type: 'fill' },
      { id: 'r-water', type: 'fill' },
      { id: 'r-roads_highway', type: 'line' },
      { id: 'r-address_label', type: 'symbol' },
      { id: 'r-places_country', type: 'symbol' },
    ];
    expect(firstTopLabelLayerId(layers)).toBe('r-address_label');
  });

  it('returns undefined when no symbol layer sits at the top (route draws on top)', () => {
    expect(firstTopLabelLayerId([{ id: 'earth', type: 'fill' }])).toBeUndefined();
    expect(firstTopLabelLayerId(undefined)).toBeUndefined();
  });
});
