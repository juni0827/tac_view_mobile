import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OVERPASS_URLS, fetchOverpassElementsByTiles, fetchOverpassJson } from '../../../app/server/overpass.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function parseBounds(init: RequestInit | undefined) {
  const rawBody = String(init?.body ?? '');
  const decodedBody = decodeURIComponent(rawBody.replace(/^data=/, ''));
  const match = decodedBody.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
  if (!match) {
    return null;
  }

  return {
    south: Number(match[1]),
    west: Number(match[2]),
    north: Number(match[3]),
    east: Number(match[4]),
  };
}

describe('fetchOverpassElementsByTiles', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tiles large bounding boxes and deduplicates repeated OSM elements', async () => {
    fetchMock.mockImplementation((_url: URL | RequestInfo, init?: RequestInit) => {
      const bounds = parseBounds(init);
      if (!bounds) {
        throw new Error('Missing bounds in query');
      }

      const tileId = Math.round((bounds.south * 100) + (bounds.west * 1000)) + 1000;
      return Promise.resolve(jsonResponse({
        elements: [
          {
            type: 'way',
            id: 42,
            tags: { highway: 'primary', name: 'Shared Corridor' },
            geometry: [
              { lat: bounds.south, lon: bounds.west },
              { lat: bounds.north, lon: bounds.east },
            ],
          },
          {
            type: 'way',
            id: tileId,
            tags: { highway: 'secondary', name: `Tile ${tileId}` },
            geometry: [
              { lat: bounds.south, lon: bounds.west },
              { lat: bounds.north, lon: bounds.east },
            ],
          },
        ],
      }));
    });

    const result = await fetchOverpassElementsByTiles({
      bbox: { south: 0, west: 0, north: 1, east: 1 },
      buildQuery: (tile) => `
[out:json];
way["highway"](${tile.south},${tile.west},${tile.north},${tile.east});
out geom;
`,
      maxTileSpan: 0.5,
      minTileSpan: 0.25,
      timeoutMs: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4 * DEFAULT_OVERPASS_URLS.length);
    expect(result.failedTiles).toHaveLength(0);
    expect(result.elements).toHaveLength(5);
    expect(result.elements.filter((element) => element.id === 42)).toHaveLength(1);
  });

  it('retries failed tiles with smaller subdivisions before giving up', async () => {
    fetchMock.mockImplementation((_url: URL | RequestInfo, init?: RequestInit) => {
      const bounds = parseBounds(init);
      if (!bounds) {
        throw new Error('Missing bounds in query');
      }

      const span = Math.max(bounds.north - bounds.south, bounds.east - bounds.west);
      if (span > 0.2) {
        return Promise.reject(new Error('ETIMEDOUT'));
      }

      const tileId = Math.round((bounds.south * 1000) + (bounds.west * 1000)) + 2000;
      return Promise.resolve(jsonResponse({
        elements: [
          {
            type: 'way',
            id: tileId,
            tags: { highway: 'residential' },
            geometry: [
              { lat: bounds.south, lon: bounds.west },
              { lat: bounds.north, lon: bounds.east },
            ],
          },
        ],
      }));
    });

    const result = await fetchOverpassElementsByTiles({
      bbox: { south: 0, west: 0, north: 0.4, east: 0.4 },
      buildQuery: (tile) => `
[out:json];
way["highway"](${tile.south},${tile.west},${tile.north},${tile.east});
out geom;
`,
      maxTileSpan: 0.4,
      minTileSpan: 0.1,
      timeoutMs: 100,
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
    expect(result.failedTiles).toHaveLength(0);
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it('races mirrors and returns the first successful overpass payload', async () => {
    fetchMock.mockImplementation((url: URL | RequestInfo) => {
      const asText = String(url);
      if (asText.includes('slow.example')) {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('ETIMEDOUT')), 50);
        });
      }

      if (asText.includes('fast.example')) {
        return Promise.resolve(jsonResponse({ elements: [{ type: 'node', id: 7 }] }));
      }

      return Promise.reject(new Error('Unexpected mirror'));
    });

    const payload = await fetchOverpassJson('[out:json];node(0,0,1,1);out;', {
      urls: [
        'https://slow.example/api/interpreter',
        'https://fast.example/api/interpreter',
      ],
      timeoutMs: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload).toEqual({ elements: [{ type: 'node', id: 7 }] });
  });
});
