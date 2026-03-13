import { describe, expect, it } from 'vitest';
import { runTieredGroupEngine } from '../../../app/src/intelligence/groupEngine';
import { applyGroupInputPatch, createGroupStore, setGroupStoreCameraState } from '../../../app/src/intelligence/groupStore';
import type { Flight } from '../../../app/src/hooks/useFlights';

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    icao24: 'abc123',
    callsign: 'TEST123',
    registration: 'N123TV',
    aircraftType: 'B738',
    description: 'Boeing 737-800',
    operator: 'Tac View Air',
    country: 'US',
    latitude: 37.62,
    longitude: -122.38,
    altitude: 11000,
    altitudeFeet: 36089,
    onGround: false,
    velocity: 220,
    velocityKnots: 427,
    heading: 95,
    verticalRate: 0,
    squawk: '1200',
    category: 'A3',
    originAirport: 'SFO',
    destAirport: 'LAX',
    airline: 'WV',
    ...overrides,
  };
}

function seedFlights(store: ReturnType<typeof createGroupStore>, flights: Flight[]) {
  applyGroupInputPatch(store, {
    at: 0,
    flights: { upsert: flights, removeIds: [] },
  });
  applyGroupInputPatch(store, {
    at: 30_000,
    flights: { upsert: flights, removeIds: [] },
  });
}

describe('group engine', () => {
  it('keeps micro grouping non-transitive', () => {
    const store = createGroupStore();
    seedFlights(store, [
      makeFlight({ icao24: 'a', latitude: 37.60, longitude: -122.40 }),
      makeFlight({ icao24: 'b', latitude: 37.65, longitude: -122.35 }),
      makeFlight({ icao24: 'c', latitude: 37.70, longitude: -122.30 }),
    ]);

    const snapshot = runTieredGroupEngine(store, 30_000, {
      forceMicro: true,
      forceMeso: true,
      forceCloud: true,
    });

    expect(snapshot.microGroups).toHaveLength(1);
    expect(snapshot.microGroups[0]?.memberIds).toEqual(['flight-a', 'flight-b']);
  });

  it('builds meso groups from micro groups instead of raw tracks', () => {
    const store = createGroupStore();
    seedFlights(store, [
      makeFlight({ icao24: 'a', latitude: 37.60, longitude: -122.40 }),
      makeFlight({ icao24: 'b', latitude: 37.64, longitude: -122.36 }),
      makeFlight({ icao24: 'c', latitude: 37.78, longitude: -122.20 }),
      makeFlight({ icao24: 'd', latitude: 37.82, longitude: -122.16 }),
    ]);

    const snapshot = runTieredGroupEngine(store, 30_000, {
      forceMicro: true,
      forceMeso: true,
    });

    expect(snapshot.microGroups).toHaveLength(2);
    expect(snapshot.mesoGroups).toHaveLength(1);
    expect(snapshot.mesoGroups[0]?.microGroupIds).toHaveLength(2);
  });

  it('gates activity clouds behind altitude', () => {
    const store = createGroupStore();
    seedFlights(store, [
      makeFlight({ icao24: 'a', latitude: 37.60, longitude: -122.40 }),
      makeFlight({ icao24: 'b', latitude: 37.64, longitude: -122.36 }),
      makeFlight({ icao24: 'c', latitude: 37.78, longitude: -122.20 }),
      makeFlight({ icao24: 'd', latitude: 37.82, longitude: -122.16 }),
    ]);

    setGroupStoreCameraState(store, {
      latitude: 37.62,
      longitude: -122.38,
      altitude: 500_000,
      heading: 0,
      pitch: -60,
      timestamp: 30_000,
    });
    let snapshot = runTieredGroupEngine(store, 30_000, {
      forceMicro: true,
      forceMeso: true,
      forceCloud: true,
    });
    expect(snapshot.activityClouds).toHaveLength(0);

    setGroupStoreCameraState(store, {
      latitude: 37.62,
      longitude: -122.38,
      altitude: 4_000_000,
      heading: 0,
      pitch: -60,
      timestamp: 31_000,
    });
    snapshot = runTieredGroupEngine(store, 31_000, {
      forceCloud: true,
    });
    expect(snapshot.activityClouds.length).toBeGreaterThan(0);
  });
});
