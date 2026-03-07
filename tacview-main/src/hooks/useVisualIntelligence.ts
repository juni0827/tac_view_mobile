import { useMemo } from 'react';
import type { Flight } from './useFlights';
import type { Ship } from './useShips';
import type { SatellitePosition } from './useSatellites';
import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import {
  buildVisualIntelligenceState,
  type VisualIntelligenceState,
} from '../intelligence/visualIntelligence';

export function useVisualIntelligence(
  trackedEntity: TrackedEntityInfo | null,
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
  cameras: CameraFeed[],
): VisualIntelligenceState {
  return useMemo(
    () => buildVisualIntelligenceState(trackedEntity, flights, ships, satellites, cameras),
    [cameras, flights, satellites, ships, trackedEntity],
  );
}
