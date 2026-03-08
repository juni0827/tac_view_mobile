import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';
import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import type { RenderCameraState } from '../types/rendering';
import {
  EMPTY_VISUAL_INTELLIGENCE_STATE,
  type TieredGroupSnapshot,
  type VisualIntelligenceState,
} from './groupModel';
import { runTieredGroupEngine } from './groupEngine';
import {
  applyGroupInputPatch,
  createGroupStore,
  getGroupSourceSnapshot,
  setGroupStoreCameraState,
  type GroupStoreState,
} from './groupStore';
import { buildSelectionContext } from './selectionContext';

const DEFAULT_CAMERA_STATE: RenderCameraState = {
  latitude: 0,
  longitude: 0,
  altitude: 20_000_000,
  heading: 0,
  pitch: -90,
  timestamp: 0,
};

function buildStats(tieredGroups: TieredGroupSnapshot): VisualIntelligenceState['stats'] {
  return {
    microCount: tieredGroups.microGroups.length,
    mesoCount: tieredGroups.mesoGroups.length,
    cloudCount: tieredGroups.activityClouds.length,
    cloudCellCount: tieredGroups.activityClouds.reduce((sum, cloud) => sum + cloud.cells.length, 0),
    revision: tieredGroups.revision,
  };
}

function buildFeedItems(
  trackedEntity: TrackedEntityInfo | null,
  tieredGroups: TieredGroupSnapshot,
  selectionContext: VisualIntelligenceState['selectionContext'],
): VisualIntelligenceState['feedItems'] {
  const items: VisualIntelligenceState['feedItems'] = [];

  if (tieredGroups.microGroups.length > 0 || tieredGroups.mesoGroups.length > 0 || tieredGroups.activityClouds.length > 0) {
    items.push({
      id: `intel-groups-${tieredGroups.revision}`,
      time: new Date().toISOString().slice(11, 19),
      type: 'system',
      message: [
        `${tieredGroups.microGroups.length} micro`,
        `${tieredGroups.mesoGroups.length} meso`,
        `${tieredGroups.activityClouds.length} cloud`,
      ].join(' / '),
    });
  }

  if (trackedEntity && selectionContext && selectionContext.predictedPaths.length > 0) {
    items.push({
      id: `intel-selection-${selectionContext.entityId}-${tieredGroups.revision}`,
      time: new Date().toISOString().slice(11, 19),
      type: 'system',
      message: `${selectionContext.entityName} expanded with ${selectionContext.predictedPaths.length} prediction layers`,
    });
  }

  return items;
}

export function buildVisualIntelligenceStateFromStore(
  store: GroupStoreState,
  options: {
    now?: number;
    forceMicro?: boolean;
    forceMeso?: boolean;
    forceCloud?: boolean;
  } = {},
): VisualIntelligenceState {
  const now = options.now ?? Date.now();
  const tieredGroups = runTieredGroupEngine(store, now, options);
  const sources = getGroupSourceSnapshot(store);
  const selectionContext = buildSelectionContext(store.selection, sources, tieredGroups);

  return {
    tieredGroups,
    selectionContext,
    feedItems: buildFeedItems(store.selection, tieredGroups, selectionContext),
    stats: buildStats(tieredGroups),
  };
}

export function buildVisualIntelligenceState(
  trackedEntity: TrackedEntityInfo | null,
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
  cameras: CameraFeed[],
  cameraState: RenderCameraState = DEFAULT_CAMERA_STATE,
): VisualIntelligenceState {
  if (
    flights.length === 0
    && ships.length === 0
    && satellites.length === 0
    && cameras.length === 0
    && !trackedEntity
  ) {
    return EMPTY_VISUAL_INTELLIGENCE_STATE;
  }

  const store = createGroupStore();
  const now = Date.now();

  applyGroupInputPatch(store, {
    at: now - 30_000,
    flights: { upsert: flights, removeIds: [] },
    ships: { upsert: ships, removeIds: [] },
    satellites: { upsert: satellites, removeIds: [] },
    cameras: { upsert: cameras, removeIds: [] },
  });
  applyGroupInputPatch(store, {
    at: now,
    flights: { upsert: flights, removeIds: [] },
    ships: { upsert: ships, removeIds: [] },
    satellites: { upsert: satellites, removeIds: [] },
    cameras: { upsert: cameras, removeIds: [] },
  });
  store.selection = trackedEntity;
  setGroupStoreCameraState(store, cameraState);

  return buildVisualIntelligenceStateFromStore(store, {
    now,
    forceMicro: true,
    forceMeso: true,
    forceCloud: true,
  });
}

export function detectGroups(
  flights: Flight[],
  ships: Ship[],
  cameras: CameraFeed[],
  cameraState: RenderCameraState = DEFAULT_CAMERA_STATE,
) {
  return buildVisualIntelligenceState(
    null,
    flights,
    ships,
    [],
    cameras,
    cameraState,
  ).tieredGroups.microGroups;
}

export { EMPTY_VISUAL_INTELLIGENCE_STATE };
export * from './groupModel';
