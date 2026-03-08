import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import type { RenderCameraState } from '../types/rendering';
import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';
import {
  EMPTY_TIERED_GROUPS,
  type ActivityCloud,
  type GroupInputPatch,
  type GroupSourceSnapshot,
  type MesoGroupTrack,
  type MicroGroupTrack,
  type MotionTrack,
  type TieredGroupSnapshot,
  type TrackHistorySample,
} from './groupModel';

const HISTORY_WINDOW_MS = 60_000;
const HISTORY_SAMPLE_INTERVAL_MS = 500;
const HISTORY_MAX_SAMPLES = 120;

const DEFAULT_CAMERA_STATE: RenderCameraState = {
  latitude: 0,
  longitude: 0,
  altitude: 20_000_000,
  heading: 0,
  pitch: -90,
  timestamp: 0,
};

export interface MembershipIndexes {
  microByTrackId: Map<string, string[]>;
  mesoByTrackId: Map<string, string[]>;
  cloudByTrackId: Map<string, string[]>;
}

export interface GroupStoreState {
  flightsById: Map<string, Flight>;
  shipsById: Map<string, Ship>;
  satellitesById: Map<number, SatellitePosition>;
  camerasById: Map<string, CameraFeed>;
  tracksById: Map<string, MotionTrack>;
  historyByTrackId: Map<string, TrackHistorySample[]>;
  microById: Map<string, MicroGroupTrack>;
  mesoById: Map<string, MesoGroupTrack>;
  cloudById: Map<string, ActivityCloud>;
  membershipIndexes: MembershipIndexes;
  cameraState: RenderCameraState;
  selection: TrackedEntityInfo | null;
  tieredSnapshot: TieredGroupSnapshot;
  inputRevision: number;
  snapshotRevision: number;
  lastComputedAt: {
    micro: number;
    meso: number;
    cloud: number;
    selection: number;
  };
  dirty: {
    micro: boolean;
    meso: boolean;
    cloud: boolean;
    selection: boolean;
  };
}

export function createGroupStore(): GroupStoreState {
  return {
    flightsById: new Map<string, Flight>(),
    shipsById: new Map<string, Ship>(),
    satellitesById: new Map<number, SatellitePosition>(),
    camerasById: new Map<string, CameraFeed>(),
    tracksById: new Map<string, MotionTrack>(),
    historyByTrackId: new Map<string, TrackHistorySample[]>(),
    microById: new Map<string, MicroGroupTrack>(),
    mesoById: new Map<string, MesoGroupTrack>(),
    cloudById: new Map<string, ActivityCloud>(),
    membershipIndexes: {
      microByTrackId: new Map<string, string[]>(),
      mesoByTrackId: new Map<string, string[]>(),
      cloudByTrackId: new Map<string, string[]>(),
    },
    cameraState: DEFAULT_CAMERA_STATE,
    selection: null,
    tieredSnapshot: EMPTY_TIERED_GROUPS,
    inputRevision: 0,
    snapshotRevision: 0,
    lastComputedAt: {
      micro: 0,
      meso: 0,
      cloud: 0,
      selection: 0,
    },
    dirty: {
      micro: false,
      meso: false,
      cloud: false,
      selection: false,
    },
  };
}

function toFlightTrack(flight: Flight, updatedAt: number): MotionTrack {
  return {
    id: `flight-${flight.icao24}`,
    name: flight.callsign || flight.registration || flight.icao24,
    domain: 'air',
    entityType: 'aircraft',
    latitude: flight.latitude,
    longitude: flight.longitude,
    altitude: flight.altitude,
    heading: flight.heading,
    speedKnots: flight.velocityKnots,
    updatedAt,
  };
}

function toShipTrack(ship: Ship, updatedAt: number): MotionTrack {
  return {
    id: `ship-${ship.mmsi}`,
    name: ship.name || ship.mmsi,
    domain: 'surface',
    entityType: 'ship',
    latitude: ship.latitude,
    longitude: ship.longitude,
    altitude: 0,
    heading: ship.heading ?? ship.cog,
    speedKnots: ship.sog,
    updatedAt,
  };
}

function pruneHistory(history: TrackHistorySample[], now: number) {
  while (history.length > 0 && now - history[0]!.timestamp > HISTORY_WINDOW_MS) {
    history.shift();
  }
  while (history.length > HISTORY_MAX_SAMPLES) {
    history.shift();
  }
}

function appendHistory(
  historyByTrackId: Map<string, TrackHistorySample[]>,
  track: MotionTrack,
  now: number,
) {
  const history = historyByTrackId.get(track.id) ?? [];
  const last = history[history.length - 1];
  if (last && now - last.timestamp < HISTORY_SAMPLE_INTERVAL_MS) {
    history[history.length - 1] = {
      timestamp: now,
      latitude: track.latitude,
      longitude: track.longitude,
      altitude: track.altitude,
      heading: track.heading,
      speedKnots: track.speedKnots,
    };
  } else {
    history.push({
      timestamp: now,
      latitude: track.latitude,
      longitude: track.longitude,
      altitude: track.altitude,
      heading: track.heading,
      speedKnots: track.speedKnots,
    });
  }
  pruneHistory(history, now);
  historyByTrackId.set(track.id, history);
}

function removeTrack(
  tracksById: Map<string, MotionTrack>,
  historyByTrackId: Map<string, TrackHistorySample[]>,
  trackId: string,
) {
  tracksById.delete(trackId);
  historyByTrackId.delete(trackId);
}

export function applyGroupInputPatch(store: GroupStoreState, patch: GroupInputPatch) {
  const now = patch.at ?? Date.now();
  let changedTracks = false;
  let changedStatic = false;

  if (patch.flights) {
    for (const id of patch.flights.removeIds) {
      store.flightsById.delete(id);
      removeTrack(store.tracksById, store.historyByTrackId, `flight-${id}`);
      changedTracks = true;
    }
    for (const flight of patch.flights.upsert) {
      store.flightsById.set(flight.icao24, flight);
      const track = toFlightTrack(flight, now);
      store.tracksById.set(track.id, track);
      appendHistory(store.historyByTrackId, track, now);
      changedTracks = true;
    }
  }

  if (patch.ships) {
    for (const id of patch.ships.removeIds) {
      store.shipsById.delete(id);
      removeTrack(store.tracksById, store.historyByTrackId, `ship-${id}`);
      changedTracks = true;
    }
    for (const ship of patch.ships.upsert) {
      store.shipsById.set(ship.mmsi, ship);
      const track = toShipTrack(ship, now);
      store.tracksById.set(track.id, track);
      appendHistory(store.historyByTrackId, track, now);
      changedTracks = true;
    }
  }

  if (patch.satellites) {
    for (const id of patch.satellites.removeIds) {
      const parsed = Number.parseInt(id, 10);
      if (Number.isFinite(parsed)) {
        store.satellitesById.delete(parsed);
      }
      changedStatic = true;
    }
    for (const satellite of patch.satellites.upsert) {
      store.satellitesById.set(satellite.noradId, satellite);
      changedStatic = true;
    }
  }

  if (patch.cameras) {
    for (const id of patch.cameras.removeIds) {
      store.camerasById.delete(id);
      changedStatic = true;
    }
    for (const camera of patch.cameras.upsert) {
      store.camerasById.set(camera.id, camera);
      changedStatic = true;
    }
  }

  if (changedTracks || changedStatic) {
    store.inputRevision += 1;
    store.dirty.selection = true;
  }
  if (changedTracks) {
    store.dirty.micro = true;
    store.dirty.meso = true;
    store.dirty.cloud = true;
  }
}

export function setGroupStoreCameraState(store: GroupStoreState, camera: RenderCameraState) {
  store.cameraState = camera;
  store.dirty.cloud = true;
  store.dirty.selection = true;
}

export function setGroupStoreSelection(store: GroupStoreState, selection: TrackedEntityInfo | null) {
  store.selection = selection;
  store.dirty.selection = true;
}

export function getGroupSourceSnapshot(store: GroupStoreState): GroupSourceSnapshot {
  return {
    flights: Array.from(store.flightsById.values()),
    ships: Array.from(store.shipsById.values()),
    satellites: Array.from(store.satellitesById.values()),
    cameras: Array.from(store.camerasById.values()),
  };
}

export function replaceTieredSnapshot(store: GroupStoreState, snapshot: TieredGroupSnapshot) {
  store.tieredSnapshot = snapshot;
  store.snapshotRevision = snapshot.revision;
  store.microById = new Map(snapshot.microGroups.map((group) => [group.id, group]));
  store.mesoById = new Map(snapshot.mesoGroups.map((group) => [group.id, group]));
  store.cloudById = new Map(snapshot.activityClouds.map((cloud) => [cloud.id, cloud]));
  store.membershipIndexes = buildMembershipIndexes(snapshot);
}

function buildMembershipIndexes(snapshot: TieredGroupSnapshot): MembershipIndexes {
  const microByTrackId = new Map<string, string[]>();
  const mesoByTrackId = new Map<string, string[]>();
  const cloudByTrackId = new Map<string, string[]>();
  const mesoByMicroId = new Map<string, string[]>();

  for (const group of snapshot.mesoGroups) {
    for (const microId of group.microGroupIds) {
      const ids = mesoByMicroId.get(microId);
      if (ids) {
        ids.push(group.id);
      } else {
        mesoByMicroId.set(microId, [group.id]);
      }
    }
    for (const trackId of group.representativeTrackIds) {
      const ids = mesoByTrackId.get(trackId);
      if (ids) {
        ids.push(group.id);
      } else {
        mesoByTrackId.set(trackId, [group.id]);
      }
    }
  }

  for (const group of snapshot.microGroups) {
    for (const trackId of group.memberIds) {
      const ids = microByTrackId.get(trackId);
      if (ids) {
        ids.push(group.id);
      } else {
        microByTrackId.set(trackId, [group.id]);
      }
      const mesoIds = mesoByMicroId.get(group.id);
      if (mesoIds) {
        const trackMesoIds = mesoByTrackId.get(trackId);
        if (trackMesoIds) {
          trackMesoIds.push(...mesoIds.filter((mesoId) => !trackMesoIds.includes(mesoId)));
        } else {
          mesoByTrackId.set(trackId, [...mesoIds]);
        }
      }
    }
  }

  for (const cloud of snapshot.activityClouds) {
    for (const cell of cloud.cells) {
      for (const trackId of cell.representativeIds) {
        const ids = cloudByTrackId.get(trackId);
        if (ids) {
          if (!ids.includes(cloud.id)) {
            ids.push(cloud.id);
          }
        } else {
          cloudByTrackId.set(trackId, [cloud.id]);
        }
      }
    }
  }

  return {
    microByTrackId,
    mesoByTrackId,
    cloudByTrackId,
  };
}
