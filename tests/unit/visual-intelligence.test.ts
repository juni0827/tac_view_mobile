import { describe, expect, it } from 'vitest';
import {
  buildVisualIntelligenceState,
  detectGroups,
} from '../../src/intelligence/visualIntelligence';
import type { Flight } from '../../src/hooks/useFlights';
import type { Ship } from '../../src/hooks/useShips';
import type { SatellitePosition } from '../../src/hooks/useSatellites';
import type { CameraFeed } from '../../src/types/camera';
import type { TrackedEntityInfo } from '../../src/types/trackedEntity';

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

function makeShip(overrides: Partial<Ship> = {}): Ship {
  return {
    mmsi: '123456789',
    name: 'WV MERIDIAN',
    latitude: 37.78,
    longitude: -122.5,
    heading: 180,
    cog: 182,
    sog: 14,
    navStatus: 0,
    shipType: 70,
    destination: 'San Pedro',
    imo: 9990001,
    callSign: 'WVM1',
    length: 210,
    width: 32,
    country: 'US',
    countryCode: 'US',
    timestamp: '2026-03-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeCamera(overrides: Partial<CameraFeed> = {}): CameraFeed {
  return {
    id: 'cam-1',
    name: 'SFO Corridor',
    source: 'caltrans',
    country: 'US',
    countryName: 'United States',
    region: 'California',
    latitude: 37.61,
    longitude: -122.3,
    imageUrl: 'https://example.com/cam.jpg',
    available: true,
    lastUpdated: '2026-03-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeSatellite(overrides: Partial<SatellitePosition> = {}): SatellitePosition {
  return {
    name: 'ISS (ZARYA)',
    noradId: 25544,
    latitude: 37.7,
    longitude: -122.4,
    altitude: 420,
    orbitPath: [
      { latitude: 37.7, longitude: -122.4, altitude: 420 },
      { latitude: 38.4, longitude: -120.5, altitude: 421 },
      { latitude: 39.6, longitude: -117.8, altitude: 421 },
      { latitude: 40.8, longitude: -114.6, altitude: 422 },
      { latitude: 42.1, longitude: -110.4, altitude: 422 },
    ],
    satrec: {} as SatellitePosition['satrec'],
    ...overrides,
  };
}

describe('visual intelligence engine', () => {
  it('detects co-movement groups for nearby flights', () => {
    const flights = [
      makeFlight({ icao24: 'group-a', callsign: 'GROUP01', latitude: 37.62, longitude: -122.38, heading: 92 }),
      makeFlight({ icao24: 'group-b', callsign: 'GROUP02', latitude: 37.66, longitude: -122.33, heading: 95 }),
    ];

    const groups = detectGroups(flights, [], [makeCamera()]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toEqual(expect.arrayContaining(['flight-group-a', 'flight-group-b']));
    expect(groups[0]?.label).toContain('MICRO AIR');
    expect(groups[0]?.confidence).toBeGreaterThan(0);
  });

  it('builds top-3 predicted paths and ontology overlays for a selected aircraft', () => {
    const flights = [
      makeFlight({ icao24: 'focus-1', callsign: 'FOCUS1' }),
      makeFlight({
        icao24: 'peer-1',
        callsign: 'PEER1',
        latitude: 37.66,
        longitude: -122.33,
        heading: 97,
        originAirport: 'SFO',
        destAirport: 'LAX',
      }),
    ];
    const trackedEntity: TrackedEntityInfo = {
      id: 'flight-focus-1',
      name: 'FOCUS1',
      entityType: 'aircraft',
      description: '',
    };

    const state = buildVisualIntelligenceState(
      trackedEntity,
      flights,
      [],
      [],
      [makeCamera()],
    );

    expect(state.selectionContext).not.toBeNull();
    expect(state.selectionContext?.predictedPaths).toHaveLength(3);
    expect(state.selectionContext?.destinationCandidates.length).toBeGreaterThan(0);
    expect(state.selectionContext?.altitudeStem).not.toBeNull();
    expect(state.selectionContext?.relationships.length).toBeGreaterThan(0);
    expect(state.selectionContext?.relatedEntities.some((entity) => entity.id === 'flight-peer-1')).toBe(true);
    expect(state.stats.microCount).toBeGreaterThanOrEqual(1);
  });

  it('builds satellite coverage overlays and linked facilities for a selected satellite', () => {
    const trackedEntity: TrackedEntityInfo = {
      id: 'sat-25544',
      name: 'ISS (ZARYA)',
      entityType: 'satellite',
      description: '',
    };

    const state = buildVisualIntelligenceState(
      trackedEntity,
      [],
      [makeShip()],
      [makeSatellite()],
      [makeCamera()],
    );

    expect(state.selectionContext).not.toBeNull();
    expect(state.selectionContext?.predictedPaths.length).toBeGreaterThan(0);
    expect(state.selectionContext?.coverageOverlays).toHaveLength(1);
    expect(state.selectionContext?.coverageOverlays[0]?.radiusKm).toBeGreaterThan(0);
    expect(state.selectionContext?.relatedEntities.some((entity) => entity.id.startsWith('cctv-'))).toBe(true);
  });
});
