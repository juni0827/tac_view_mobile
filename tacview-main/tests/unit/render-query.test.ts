import { describe, expect, it } from 'vitest';
import { GridSpatialIndex, deriveRenderPriorityIds, selectPriorityItems } from '../../src/lib/renderQuery';
import type { RenderCameraState } from '../../src/types/rendering';

interface TestItem {
  id: string;
  latitude: number;
  longitude: number;
  value: number;
}

const CAMERA: RenderCameraState = {
  latitude: 37.62,
  longitude: -122.38,
  altitude: 500_000,
  heading: 0,
  pitch: -60,
  timestamp: 1,
};

describe('render query helpers', () => {
  it('prioritizes tracked and related ids ahead of closer but unrelated items', () => {
    const items: TestItem[] = [
      { id: 'tracked', latitude: 38.5, longitude: -121.9, value: 1 },
      { id: 'related', latitude: 38.0, longitude: -122.0, value: 2 },
      { id: 'close-a', latitude: 37.63, longitude: -122.39, value: 3 },
      { id: 'close-b', latitude: 37.64, longitude: -122.4, value: 4 },
    ];

    const selected = selectPriorityItems(items, {
      budget: 2,
      camera: CAMERA,
      trackedId: 'tracked',
      priorityIds: new Set(['related']),
      index: new GridSpatialIndex(items, 2),
    });

    expect(selected.map((item) => item.id)).toEqual(['tracked', 'related']);
  });

  it('builds a stable priority id set from selection context', () => {
    const ids = deriveRenderPriorityIds({
      entityId: 'flight-focus',
      relatedEntities: [{ id: 'flight-peer' }],
      relationships: [{ sourceId: 'flight-focus', targetId: 'facility-airport-sfo' }],
      relatedMicroGroups: [{ id: 'micro-air-1', memberIds: ['flight-focus', 'flight-peer'] }],
      relatedMesoGroups: [{ id: 'meso-air-1', representativeTrackIds: ['flight-focus'], microGroupIds: ['micro-air-1'] }],
      relatedClouds: [{ id: 'cloud-air-1', cells: [{ representativeIds: ['flight-focus'] }] }],
      destinationCandidates: [{ id: 'facility-airport-sfo' }],
    });

    expect(ids.has('flight-focus')).toBe(true);
    expect(ids.has('flight-peer')).toBe(true);
    expect(ids.has('facility-airport-sfo')).toBe(true);
    expect(ids.has('micro-air-1')).toBe(true);
    expect(ids.has('meso-air-1')).toBe(true);
    expect(ids.has('cloud-air-1')).toBe(true);
  });
});
