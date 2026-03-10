import { useEffect, useRef } from 'react';
import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';
import type { Earthquake } from '../hooks/useEarthquakes';
import type { RoadSegment } from '../hooks/useTraffic';
import type { CameraFeed } from '../types/camera';
import { syncOntologySnapshot } from './api';

interface OntologySyncPayload {
  flights: Flight[];
  ships: Ship[];
  satellites: SatellitePosition[];
  cameras: CameraFeed[];
  earthquakes: Earthquake[];
  roads: RoadSegment[];
}

function buildFingerprint(payload: OntologySyncPayload) {
  return [
    payload.flights.length,
    payload.flights[0]?.icao24 ?? '',
    payload.flights[payload.flights.length - 1]?.icao24 ?? '',
    payload.ships.length,
    payload.ships[0]?.mmsi ?? '',
    payload.satellites.length,
    payload.satellites[0]?.noradId ?? '',
    payload.cameras.length,
    payload.cameras[0]?.id ?? '',
    payload.earthquakes.length,
    payload.earthquakes[0]?.id ?? '',
    payload.roads.length,
    payload.roads[0]?.id ?? '',
  ].join('|');
}

export function useOntologySync(payload: OntologySyncPayload, enabled = true) {
  const lastFingerprintRef = useRef('');

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const fingerprint = buildFingerprint(payload);
    if (fingerprint === lastFingerprintRef.current) {
      return;
    }

    const hasAnyData = Object.values(payload).some((items) => items.length > 0);
    if (!hasAnyData) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void syncOntologySnapshot(payload as unknown as Record<string, unknown>)
        .then(() => {
          lastFingerprintRef.current = fingerprint;
        })
        .catch((error) => {
          console.warn('[ONTOLOGY] Sync failed:', error);
        });
    }, 800);

    return () => window.clearTimeout(timeoutId);
  }, [enabled, payload]);
}
