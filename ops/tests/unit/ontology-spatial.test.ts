import { describe, expect, it } from 'vitest';
import { calculateRadiusBbox, filterEntitiesByRadius, haversineKm } from '../../../app/src/ontology/spatial';
import type { OntologyEntity } from '../../../app/src/types/ontology';

function makeEntity(overrides: Partial<OntologyEntity> = {}): OntologyEntity {
  return {
    id: 'facility-1',
    canonicalType: 'facility',
    subtype: null,
    label: 'Test Facility',
    origin: 'observed',
    confidence: 0.8,
    countryCode: 'US',
    operator: null,
    sourceCount: 1,
    observationCount: 1,
    lastObservedAt: '2026-03-12T00:00:00.000Z',
    layerIds: ['ontology-facilities'],
    geometry: {
      type: 'Point',
      latitude: 37.62,
      longitude: -122.38,
      altitude: 0,
      bbox: {},
      data: {},
    },
    metadata: {},
    ...overrides,
  };
}

describe('ontology spatial helpers', () => {
  it('builds a bbox sized from a km radius around the camera center', () => {
    const bbox = calculateRadiusBbox(37.62, -122.38, 160);

    expect(bbox.south).toBeLessThan(37.62);
    expect(bbox.north).toBeGreaterThan(37.62);
    expect(bbox.west).toBeLessThan(-122.38);
    expect(bbox.east).toBeGreaterThan(-122.38);
    expect(haversineKm(37.62, -122.38, bbox.north, -122.38)).toBeGreaterThan(150);
    expect(haversineKm(37.62, -122.38, bbox.north, -122.38)).toBeLessThan(170);
  });

  it('keeps only ontology entities inside the requested circular radius', () => {
    const items = [
      makeEntity({ id: 'nearby', label: 'Nearby', geometry: { type: 'Point', latitude: 37.62, longitude: -122.38, altitude: 0, bbox: {}, data: {} } }),
      makeEntity({ id: 'edge', label: 'Edge', geometry: { type: 'Point', latitude: 38.29, longitude: -122.38, altitude: 0, bbox: {}, data: {} } }),
      makeEntity({ id: 'far', label: 'Far', geometry: { type: 'Point', latitude: 39.8, longitude: -122.38, altitude: 0, bbox: {}, data: {} } }),
    ];

    const filtered = filterEntitiesByRadius(items, 37.62, -122.38, 80);

    expect(filtered.map((item) => item.id)).toEqual(['nearby', 'edge']);
  });

  it('uses line geometry centroids when point coordinates are unavailable', () => {
    const lineEntity = makeEntity({
      id: 'road-1',
      canonicalType: 'road_segment',
      geometry: {
        type: 'LineString',
        latitude: null,
        longitude: null,
        altitude: 0,
        bbox: {},
        data: {
          points: [
            { latitude: 37.6, longitude: -122.4 },
            { latitude: 37.61, longitude: -122.39 },
          ],
        },
      },
    });

    const filtered = filterEntitiesByRadius([lineEntity], 37.605, -122.395, 3);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('road-1');
  });
});
