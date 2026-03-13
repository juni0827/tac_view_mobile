import { describe, expect, it } from 'vitest';
import { RenderBudgetController, buildRenderBudget, shouldRefreshCameraQuery } from '../../../app/src/lib/renderBudget';
import type { RenderCameraState } from '../../../app/src/types/rendering';

function makeCamera(overrides: Partial<RenderCameraState> = {}): RenderCameraState {
  return {
    latitude: -33.8688,
    longitude: 151.2093,
    altitude: 2_000_000,
    heading: 0,
    pitch: -90,
    timestamp: 1,
    ...overrides,
  };
}

describe('render budget helpers', () => {
  it('uses tighter budgets for tracked or near-camera views', () => {
    const world = buildRenderBudget(makeCamera({ altitude: 18_000_000 }), false);
    const close = buildRenderBudget(makeCamera({ altitude: 150_000 }), false);
    const tracked = buildRenderBudget(makeCamera({ altitude: 8_000_000 }), true);

    expect(close.flights).toBeGreaterThan(world.flights);
    expect(tracked.dynamicLayerIntervalMs).toBeLessThan(world.dynamicLayerIntervalMs);
  });

  it('applies camera hysteresis to small movements', () => {
    const previous = makeCamera({ altitude: 1_000_000, latitude: 37.5, longitude: -122.3 });

    expect(shouldRefreshCameraQuery(previous, makeCamera({
      altitude: 1_010_000,
      latitude: 37.53,
      longitude: -122.34,
    }))).toBe(false);

    expect(shouldRefreshCameraQuery(previous, makeCamera({
      altitude: 1_300_000,
      latitude: 37.53,
      longitude: -122.34,
    }))).toBe(true);
  });

  it('reduces Google 3D resolution scale when fps stays under target', () => {
    const controller = new RenderBudgetController();

    for (let index = 0; index < 200; index += 1) {
      controller.pushFrame(index * 20, 20, 'google');
    }

    expect(controller.getResolutionScale()).toBeLessThan(1);
    expect(controller.isGovernorActive()).toBe(true);
  });

  it('restores full resolution outside Google 3D mode', () => {
    const controller = new RenderBudgetController();

    for (let index = 0; index < 200; index += 1) {
      controller.pushFrame(index * 20, 20, 'google');
    }
    controller.pushFrame(4_500, 16, 'osm');

    expect(controller.getResolutionScale()).toBe(1);
    expect(controller.isGovernorActive()).toBe(false);
  });
});
