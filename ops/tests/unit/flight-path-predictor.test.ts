import { describe, expect, it } from 'vitest';
import type { Flight } from '../../../app/src/hooks/useFlights';
import { appendFlightTrackSample, buildFlightPathGeometry } from '../../../app/src/lib/flightPathPredictor';

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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthRadiusKm = 6371;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const deltaLat = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

describe('flight path predictor', () => {
  it('uses accumulated history for the completed track', () => {
    const now = Date.now();
    const baseFlight = makeFlight({ latitude: 36.7, longitude: -121.9, altitude: 9800, altitudeFeet: 32152 });

    let history = appendFlightTrackSample([], makeFlight({
      icao24: baseFlight.icao24,
      latitude: 37.4,
      longitude: -122.5,
      altitude: 10400,
      altitudeFeet: 34120,
      heading: 138,
    }), now - 40_000);
    history = appendFlightTrackSample(history, makeFlight({
      icao24: baseFlight.icao24,
      latitude: 37.0,
      longitude: -122.2,
      altitude: 10100,
      altitudeFeet: 33136,
      heading: 141,
    }), now - 20_000);
    history = appendFlightTrackSample(history, baseFlight, now);

    const geometry = buildFlightPathGeometry(baseFlight, {
      history,
      nearbyFlights: [baseFlight],
    });

    expect(geometry.completed.length).toBeGreaterThanOrEqual(3);
    expect(geometry.completed[0]?.latitude).toBeCloseTo(37.4, 1);
    expect(geometry.completed.at(-1)?.latitude).toBeCloseTo(baseFlight.latitude, 3);
    expect(geometry.completed.at(-1)?.longitude).toBeCloseTo(baseFlight.longitude, 3);
  });

  it('drives the remaining track toward destination and lower altitude on descent', () => {
    const flight = makeFlight({
      latitude: 35.8,
      longitude: -120.4,
      altitude: 6200,
      altitudeFeet: 20341,
      heading: 15,
      velocityKnots: 320,
      verticalRate: -9,
      destAirport: 'LAX',
    });
    const destination = { lat: 33.9425, lon: -118.4081 };
    const peers = [
      flight,
      makeFlight({
        icao24: 'peer-1',
        latitude: 35.4,
        longitude: -119.8,
        altitude: 5900,
        altitudeFeet: 19357,
        heading: 145,
        velocityKnots: 295,
        verticalRate: -7,
        destAirport: 'LAX',
      }),
      makeFlight({
        icao24: 'peer-2',
        latitude: 35.2,
        longitude: -119.5,
        altitude: 5400,
        altitudeFeet: 17717,
        heading: 148,
        velocityKnots: 288,
        verticalRate: -8,
        destAirport: 'LAX',
      }),
    ];

    const geometry = buildFlightPathGeometry(flight, {
      destination,
      history: [appendFlightTrackSample([], flight, Date.now())[0]!],
      nearbyFlights: peers,
      airspaceRangeKm: 320,
    });

    const lastPoint = geometry.remaining.at(-1);
    expect(lastPoint).toBeDefined();
    expect(lastPoint!.latitude).toBeLessThan(flight.latitude);
    expect(lastPoint!.longitude).toBeGreaterThan(flight.longitude);
    expect(lastPoint!.altitude).toBeLessThan(flight.altitude);
    expect(
      haversineKm(lastPoint!.latitude, lastPoint!.longitude, destination.lat, destination.lon),
    ).toBeLessThan(
      haversineKm(flight.latitude, flight.longitude, destination.lat, destination.lon),
    );
  });

  it('changes prediction shape when the airspace range expands', () => {
    const flight = makeFlight({
      latitude: 34.8,
      longitude: -121.2,
      altitude: 9800,
      altitudeFeet: 32152,
      heading: 0,
      velocityKnots: 410,
      verticalRate: 0,
      destAirport: '',
    });
    const distantFlowPeer = makeFlight({
      icao24: 'peer-flow',
      latitude: 34.9,
      longitude: -118.9,
      altitude: 10000,
      altitudeFeet: 32808,
      heading: 105,
      velocityKnots: 430,
      verticalRate: 0,
      destAirport: '',
    });
    const history = [
      appendFlightTrackSample([], makeFlight({
        icao24: flight.icao24,
        latitude: 34.4,
        longitude: -121.2,
        altitude: 9600,
        altitudeFeet: 31496,
        heading: 0,
      }), Date.now() - 20_000)[0]!,
      appendFlightTrackSample([], flight, Date.now())[0]!,
    ];

    const narrow = buildFlightPathGeometry(flight, {
      history,
      nearbyFlights: [flight, distantFlowPeer],
      airspaceRangeKm: 80,
    });
    const wide = buildFlightPathGeometry(flight, {
      history,
      nearbyFlights: [flight, distantFlowPeer],
      airspaceRangeKm: 640,
    });

    expect(wide.remaining.at(-1)!.longitude).toBeGreaterThan(narrow.remaining.at(-1)!.longitude);
  });
});
