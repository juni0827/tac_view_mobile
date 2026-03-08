import type { RenderBudget, RenderCameraState } from '../types/rendering';
import { GridSpatialIndex, estimateQueryRadiusKm } from '../lib/renderQuery';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import {
  EMPTY_TIERED_GROUPS,
  type ActivityCloud,
  type ActivityCloudCell,
  type GroupDomain,
  type GroupSourceSnapshot,
  type MesoGroupTrack,
  type MicroGroupTrack,
  type MotionTrack,
  type TieredGroupSnapshot,
  type TrackHistorySample,
} from './groupModel';
import {
  applyGroupInputPatch,
  createGroupStore,
  replaceTieredSnapshot,
  setGroupStoreCameraState,
  type GroupStoreState,
} from './groupStore';

const MICRO_INTERVAL_MS = 84;
const MESO_INTERVAL_MS = 334;
const CLOUD_INTERVAL_MS = 1_000;

const MICRO_THRESHOLDS = {
  air: {
    distanceKm: 12,
    headingDelta: 12,
    speedDelta: 80,
    altitudeDeltaMeters: 1_200,
    minPersistenceMs: 20_000,
    maxMembers: 6,
  },
  surface: {
    distanceKm: 4,
    headingDelta: 18,
    speedDelta: 10,
    altitudeDeltaMeters: 200,
    minPersistenceMs: 20_000,
    maxMembers: 6,
  },
} as const;

const MESO_THRESHOLDS = {
  air: {
    distanceKm: 40,
    headingDelta: 18,
    maxMicros: 5,
  },
  surface: {
    distanceKm: 12,
    headingDelta: 20,
    maxMicros: 5,
  },
} as const;

const CLOUD_MIN_ALTITUDE = 1_500_000;
const CLOUD_MAX_CELLS = 64;

interface GroupEngineOptions {
  forceMicro?: boolean;
  forceMeso?: boolean;
  forceCloud?: boolean;
}

interface MicroThreshold {
  distanceKm: number;
  headingDelta: number;
  speedDelta: number;
  altitudeDeltaMeters: number;
  minPersistenceMs: number;
  maxMembers: number;
}

interface MesoThreshold {
  distanceKm: number;
  headingDelta: number;
  maxMicros: number;
}

interface SpatialTrack {
  id: string;
  latitude: number;
  longitude: number;
  track: MotionTrack;
}

interface SpatialMicro {
  id: string;
  latitude: number;
  longitude: number;
  group: MicroGroupTrack;
}

export function buildTieredGroupSnapshot(
  input: GroupSourceSnapshot,
  frameBudget: RenderBudget | null,
  cameraState: RenderCameraState,
  selection: TrackedEntityInfo | null,
): TieredGroupSnapshot {
  void frameBudget;
  void selection;
  const store = createGroupStore();
  applyGroupInputPatch(store, {
    at: Date.now(),
    flights: { upsert: input.flights, removeIds: [] },
    ships: { upsert: input.ships, removeIds: [] },
    satellites: { upsert: input.satellites, removeIds: [] },
    cameras: { upsert: input.cameras, removeIds: [] },
  });
  setGroupStoreCameraState(store, cameraState);
  return runTieredGroupEngine(store, Date.now(), {
    forceMicro: true,
    forceMeso: true,
    forceCloud: true,
  });
}

export function runTieredGroupEngine(
  store: GroupStoreState,
  now: number,
  options: GroupEngineOptions = {},
): TieredGroupSnapshot {
  const shouldComputeMicro = options.forceMicro
    || (store.dirty.micro && now - store.lastComputedAt.micro >= MICRO_INTERVAL_MS);

  let microGroups = store.tieredSnapshot.microGroups;
  if (shouldComputeMicro) {
    microGroups = buildMicroGroups(store, now);
    store.lastComputedAt.micro = now;
    store.dirty.micro = false;
    store.dirty.meso = true;
    store.dirty.selection = true;
  }

  const shouldComputeMeso = options.forceMeso
    || (store.dirty.meso && now - store.lastComputedAt.meso >= MESO_INTERVAL_MS);

  let mesoGroups = store.tieredSnapshot.mesoGroups;
  if (shouldComputeMeso) {
    mesoGroups = buildMesoGroups(store, microGroups, now);
    microGroups = applyMicroParents(microGroups, mesoGroups);
    store.lastComputedAt.meso = now;
    store.dirty.meso = false;
    store.dirty.selection = true;
  }

  const shouldComputeCloud = options.forceCloud
    || (store.dirty.cloud && now - store.lastComputedAt.cloud >= CLOUD_INTERVAL_MS);

  let activityClouds = store.tieredSnapshot.activityClouds;
  if (shouldComputeCloud) {
    activityClouds = buildActivityClouds(store, now);
    store.lastComputedAt.cloud = now;
    store.dirty.cloud = false;
    store.dirty.selection = true;
  }

  if (!shouldComputeMicro && !shouldComputeMeso && !shouldComputeCloud) {
    return store.tieredSnapshot;
  }

  const nextSnapshot: TieredGroupSnapshot = {
    microGroups,
    mesoGroups,
    activityClouds,
    revision: store.snapshotRevision + 1,
    computedAt: now,
  };

  replaceTieredSnapshot(store, nextSnapshot);
  return nextSnapshot;
}

function buildMicroGroups(store: GroupStoreState, now: number): MicroGroupTrack[] {
  const groups: MicroGroupTrack[] = [];

  for (const domain of ['air', 'surface'] as const) {
    const threshold = MICRO_THRESHOLDS[domain];
    const tracks = Array.from(store.tracksById.values())
      .filter((track) => track.domain === domain)
      .sort((left, right) => {
        const leftPersistence = getTrackPersistenceMs(store.historyByTrackId.get(left.id));
        const rightPersistence = getTrackPersistenceMs(store.historyByTrackId.get(right.id));
        return rightPersistence - leftPersistence || left.id.localeCompare(right.id);
      });

    if (tracks.length < 2) {
      continue;
    }

    const index = new GridSpatialIndex<SpatialTrack>(
      tracks.map((track) => ({
        id: track.id,
        latitude: track.latitude,
        longitude: track.longitude,
        track,
      })),
      Math.max(0.25, threshold.distanceKm / 111),
    );

    const assigned = new Set<string>();

    for (const track of tracks) {
      if (assigned.has(track.id)) {
        continue;
      }

      const nearby = index.queryRadius(track.latitude, track.longitude, threshold.distanceKm)
        .map((candidate) => candidate.track)
        .filter((candidate) =>
          candidate.id !== track.id
          && !assigned.has(candidate.id)
          && isMicroCompatible(track, candidate, threshold),
        )
        .sort((left, right) => distanceMeters(track, left) - distanceMeters(track, right));

      if (nearby.length === 0) {
        continue;
      }

      const cluster: MotionTrack[] = [track, nearby[0]!];
      for (const candidate of nearby.slice(1)) {
        if (cluster.length >= threshold.maxMembers) {
          break;
        }
        if (cluster.every((member) => isMicroCompatible(member, candidate, threshold))) {
          cluster.push(candidate);
        }
      }

      const persistenceMs = Math.min(...cluster.map((member) => getTrackPersistenceMs(store.historyByTrackId.get(member.id))));
      if (persistenceMs < threshold.minPersistenceMs) {
        continue;
      }

      cluster.forEach((member) => assigned.add(member.id));
      groups.push(toMicroGroup(store, cluster, domain, threshold, now));
    }
  }

  return relabelMicroGroups(groups
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id)));
}

function buildMesoGroups(
  store: GroupStoreState,
  microGroups: MicroGroupTrack[],
  now: number,
): MesoGroupTrack[] {
  const groups: MesoGroupTrack[] = [];

  for (const domain of ['air', 'surface'] as const) {
    const threshold = MESO_THRESHOLDS[domain];
    const domainGroups = microGroups
      .filter((group) => group.domain === domain)
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));

    if (domainGroups.length < 2) {
      continue;
    }

    const index = new GridSpatialIndex<SpatialMicro>(
      domainGroups.map((group) => ({
        id: group.id,
        latitude: group.centroid.latitude,
        longitude: group.centroid.longitude,
        group,
      })),
      Math.max(0.25, threshold.distanceKm / 111),
    );

    const assigned = new Set<string>();

    for (const micro of domainGroups) {
      if (assigned.has(micro.id)) {
        continue;
      }

      const nearby = index.queryRadius(micro.centroid.latitude, micro.centroid.longitude, threshold.distanceKm)
        .map((candidate) => candidate.group)
        .filter((candidate) =>
          candidate.id !== micro.id
          && !assigned.has(candidate.id)
          && isMesoCompatible(micro, candidate, threshold),
        )
        .sort((left, right) => distanceMeters(left.centroid, right.centroid) - distanceMeters(micro.centroid, right.centroid));

      if (nearby.length === 0) {
        continue;
      }

      const cluster: MicroGroupTrack[] = [micro, nearby[0]!];
      for (const candidate of nearby.slice(1)) {
        if (cluster.length >= threshold.maxMicros) {
          break;
        }
        if (cluster.every((member) => isMesoCompatible(member, candidate, threshold))) {
          cluster.push(candidate);
        }
      }

      cluster.forEach((member) => assigned.add(member.id));
      groups.push(toMesoGroup(store, cluster, domain, now));
    }
  }

  return relabelMesoGroups(groups
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id)));
}

function buildActivityClouds(store: GroupStoreState, now: number): ActivityCloud[] {
  if (!shouldShowCloud(store.cameraState)) {
    return [];
  }

  const cellSizeKm = getCloudCellSizeKm(store.cameraState.altitude);
  const viewportKey = buildViewportKey(store.cameraState, cellSizeKm);
  const queryRadiusKm = estimateQueryRadiusKm(store.cameraState);
  const clouds: ActivityCloud[] = [];

  for (const domain of ['air', 'surface'] as const) {
    const tracks = Array.from(store.tracksById.values())
      .filter((track) => track.domain === domain)
      .filter((track) =>
        haversineKm(
          track.latitude,
          track.longitude,
          store.cameraState.latitude,
          store.cameraState.longitude,
        ) <= queryRadiusKm,
      );

    if (tracks.length === 0) {
      continue;
    }

    const cells = buildCloudCells(tracks, cellSizeKm).slice(0, CLOUD_MAX_CELLS);
    if (cells.length === 0) {
      continue;
    }

    clouds.push({
      id: `cloud-${domain}-${viewportKey}`,
      label: domain === 'air' ? 'ACTIVITY CLOUD AIR' : 'ACTIVITY CLOUD SURFACE',
      scale: 'cloud',
      domain,
      cellSizeKm,
      cells,
      densityScore: average(cells.map((cell) => cell.density)),
      dominantHeading: averageHeading(cells.map((cell) => cell.dominantHeading)),
      confidence: clamp01(0.45 + average(cells.map((cell) => cell.density)) * 0.5),
      viewportKey,
      lastComputedAt: now,
    });
  }

  return clouds.sort((left, right) => right.densityScore - left.densityScore || left.id.localeCompare(right.id));
}

function buildCloudCells(tracks: MotionTrack[], cellSizeKm: number): ActivityCloudCell[] {
  const cellSizeDeg = cellSizeKm / 111;
  const cells = new Map<string, {
    latitude: number;
    longitude: number;
    sampleCount: number;
    headings: Array<number | null>;
    representativeIds: string[];
  }>();

  for (const track of tracks) {
    const latCell = Math.floor(track.latitude / cellSizeDeg);
    const lonCell = Math.floor(track.longitude / cellSizeDeg);
    const cellId = `${latCell}:${lonCell}`;
    const existing = cells.get(cellId);
    if (existing) {
      existing.latitude += track.latitude;
      existing.longitude += track.longitude;
      existing.sampleCount += 1;
      existing.headings.push(track.heading);
      if (existing.representativeIds.length < 4) {
        existing.representativeIds.push(track.id);
      }
    } else {
      cells.set(cellId, {
        latitude: track.latitude,
        longitude: track.longitude,
        sampleCount: 1,
        headings: [track.heading],
        representativeIds: [track.id],
      });
    }
  }

  const maxSampleCount = Math.max(1, ...Array.from(cells.values()).map((cell) => cell.sampleCount));

  return Array.from(cells.entries())
    .map(([cellId, cell]) => ({
      cellId,
      latitude: cell.latitude / cell.sampleCount,
      longitude: cell.longitude / cell.sampleCount,
      density: clamp01(cell.sampleCount / maxSampleCount),
      sampleCount: cell.sampleCount,
      dominantHeading: averageHeading(cell.headings),
      representativeIds: cell.representativeIds,
    }))
    .sort((left, right) => right.sampleCount - left.sampleCount || left.cellId.localeCompare(right.cellId));
}

function toMicroGroup(
  store: GroupStoreState,
  cluster: MotionTrack[],
  domain: GroupDomain,
  threshold: MicroThreshold,
  now: number,
): MicroGroupTrack {
  const memberIds = cluster.map((member) => member.id).sort();
  const centroid = {
    latitude: average(cluster.map((member) => member.latitude)),
    longitude: average(cluster.map((member) => member.longitude)),
    altitude: average(cluster.map((member) => member.altitude)),
  };
  const dominantHeading = averageHeading(cluster.map((member) => member.heading));
  const dominantSpeed = average(cluster.map((member) => member.speedKnots ?? 0));
  const dispersionMeters = Math.max(
    200,
    ...cluster.map((member) => distanceMeters(centroid, member)),
  );
  const pairCompatibilities = buildPairCompatibilities(cluster, threshold);
  const cohesionScore = average(pairCompatibilities);
  const persistenceScore = clamp01(
    Math.min(...cluster.map((member) => getTrackPersistenceMs(store.historyByTrackId.get(member.id)))) / 60_000,
  );
  const confidence = clamp01(0.3 + cohesionScore * 0.35 + persistenceScore * 0.2 + cluster.length * 0.05);
  const anchorTrackId = cluster
    .slice()
    .sort((left, right) => {
      const leftPersistence = getTrackPersistenceMs(store.historyByTrackId.get(left.id));
      const rightPersistence = getTrackPersistenceMs(store.historyByTrackId.get(right.id));
      return rightPersistence - leftPersistence || left.id.localeCompare(right.id);
    })[0]!.id;
  const previous = store.microById.get(`micro-${domain}-${memberIds.join('__')}`);

  return {
    id: `micro-${domain}-${memberIds.join('__')}`,
    label: domain === 'air' ? 'MICRO AIR' : 'MICRO SURFACE',
    scale: 'micro',
    domain,
    memberIds,
    representativeTrackIds: memberIds.slice(0, 3),
    centroid,
    dominantHeading,
    dominantSpeed,
    dispersionMeters,
    uncertaintyRadiusMeters: Math.max(400, Math.round(dispersionMeters * 1.35)),
    cohesionScore,
    persistenceScore,
    confidence,
    anchorTrackId,
    lastSeenAt: previous?.lastSeenAt ?? now,
    parentMesoId: null,
  };
}

function toMesoGroup(
  store: GroupStoreState,
  cluster: MicroGroupTrack[],
  domain: GroupDomain,
  now: number,
): MesoGroupTrack {
  const microGroupIds = cluster.map((group) => group.id).sort();
  const representativeTrackIds = Array.from(new Set(cluster.flatMap((group) => group.representativeTrackIds))).slice(0, 6);
  const centroid = {
    latitude: average(cluster.map((group) => group.centroid.latitude)),
    longitude: average(cluster.map((group) => group.centroid.longitude)),
    altitude: average(cluster.map((group) => group.centroid.altitude)),
  };
  const dominantHeading = averageHeading(cluster.map((group) => group.dominantHeading));
  const dominantSpeed = average(cluster.map((group) => group.dominantSpeed));
  const footprintRadiusMeters = Math.max(
    1_000,
    ...cluster.map((group) => distanceMeters(centroid, group.centroid) + group.dispersionMeters),
  );
  const persistenceScore = average(cluster.map((group) => group.persistenceScore));
  const confidence = clamp01(0.35 + persistenceScore * 0.3 + average(cluster.map((group) => group.confidence)) * 0.35);
  const previous = store.mesoById.get(`meso-${domain}-${microGroupIds.join('__')}`);

  return {
    id: `meso-${domain}-${microGroupIds.join('__')}`,
    label: domain === 'air' ? 'MESO AIR' : 'MESO SURFACE',
    scale: 'meso',
    domain,
    microGroupIds,
    representativeTrackIds,
    centroid,
    dominantHeading,
    dominantSpeed,
    footprintRadiusMeters,
    persistenceScore,
    confidence,
    lastSeenAt: previous?.lastSeenAt ?? now,
  };
}

function relabelMicroGroups(groups: MicroGroupTrack[]) {
  const counters = {
    air: 0,
    surface: 0,
  };

  return groups.map((group) => {
    if (group.domain === 'air') {
      counters.air += 1;
      return { ...group, label: `MICRO AIR ${counters.air}` };
    }
    counters.surface += 1;
    return { ...group, label: `MICRO SURFACE ${counters.surface}` };
  });
}

function relabelMesoGroups(groups: MesoGroupTrack[]) {
  const counters = {
    air: 0,
    surface: 0,
  };

  return groups.map((group) => {
    if (group.domain === 'air') {
      counters.air += 1;
      return { ...group, label: `MESO AIR ${counters.air}` };
    }
    counters.surface += 1;
    return { ...group, label: `MESO SURFACE ${counters.surface}` };
  });
}

function applyMicroParents(
  microGroups: MicroGroupTrack[],
  mesoGroups: MesoGroupTrack[],
): MicroGroupTrack[] {
  const parentMap = new Map<string, string>();
  for (const meso of mesoGroups) {
    for (const microId of meso.microGroupIds) {
      parentMap.set(microId, meso.id);
    }
  }

  return microGroups.map((group) => ({
    ...group,
    parentMesoId: parentMap.get(group.id) ?? null,
  }));
}

function buildPairCompatibilities(cluster: MotionTrack[], threshold: MicroThreshold) {
  const compatibilities: number[] = [];
  for (let i = 0; i < cluster.length; i += 1) {
    for (let j = i + 1; j < cluster.length; j += 1) {
      compatibilities.push(computeTrackCompatibility(cluster[i]!, cluster[j]!, threshold));
    }
  }
  return compatibilities.length > 0 ? compatibilities : [0.5];
}

function isMicroCompatible(left: MotionTrack, right: MotionTrack, threshold: MicroThreshold) {
  if (left.domain !== right.domain) {
    return false;
  }
  if (haversineKm(left.latitude, left.longitude, right.latitude, right.longitude) > threshold.distanceKm) {
    return false;
  }
  if (Math.abs(left.altitude - right.altitude) > threshold.altitudeDeltaMeters) {
    return false;
  }
  if (left.heading != null && right.heading != null && headingDelta(left.heading, right.heading) > threshold.headingDelta) {
    return false;
  }

  const leftSpeed = left.speedKnots ?? 0;
  const rightSpeed = right.speedKnots ?? 0;
  return Math.abs(leftSpeed - rightSpeed) <= threshold.speedDelta;
}

function isMesoCompatible(left: MicroGroupTrack, right: MicroGroupTrack, threshold: MesoThreshold) {
  if (left.domain !== right.domain) {
    return false;
  }
  if (haversineKm(left.centroid.latitude, left.centroid.longitude, right.centroid.latitude, right.centroid.longitude) > threshold.distanceKm) {
    return false;
  }
  if (left.dominantHeading != null && right.dominantHeading != null && headingDelta(left.dominantHeading, right.dominantHeading) > threshold.headingDelta) {
    return false;
  }
  return true;
}

function computeTrackCompatibility(left: MotionTrack, right: MotionTrack, threshold: MicroThreshold) {
  const distanceScore = clamp01(1 - haversineKm(left.latitude, left.longitude, right.latitude, right.longitude) / threshold.distanceKm);
  const altitudeScore = clamp01(1 - Math.abs(left.altitude - right.altitude) / Math.max(1, threshold.altitudeDeltaMeters));
  const headingScore = left.heading != null && right.heading != null
    ? clamp01(1 - headingDelta(left.heading, right.heading) / Math.max(1, threshold.headingDelta))
    : 0.75;
  const speedScore = clamp01(1 - Math.abs((left.speedKnots ?? 0) - (right.speedKnots ?? 0)) / Math.max(1, threshold.speedDelta));
  return average([distanceScore, altitudeScore, headingScore, speedScore]);
}

function getTrackPersistenceMs(history: TrackHistorySample[] | undefined) {
  if (!history || history.length < 2) {
    return 0;
  }
  return history[history.length - 1]!.timestamp - history[0]!.timestamp;
}

function shouldShowCloud(camera: RenderCameraState) {
  return camera.altitude >= CLOUD_MIN_ALTITUDE;
}

function getCloudCellSizeKm(altitude: number) {
  if (altitude < 2_500_000) return 25;
  if (altitude < 8_000_000) return 75;
  return 200;
}

function buildViewportKey(camera: RenderCameraState, cellSizeKm: number) {
  const latStep = Math.max(0.25, cellSizeKm / 111);
  const lonStep = latStep;
  const altitudeBucket = altitudeToBucket(camera.altitude);
  return [
    altitudeBucket,
    Math.round(camera.latitude / latStep),
    Math.round(camera.longitude / lonStep),
  ].join(':');
}

function altitudeToBucket(altitude: number) {
  if (altitude < 2_500_000) return 'regional';
  if (altitude < 8_000_000) return 'continental';
  return 'global';
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthRadiusKm = 6371;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const lat1Rad = degreesToRadians(lat1);
  const lat2Rad = degreesToRadians(lat2);

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function distanceMeters(
  left: Pick<MotionTrack, 'latitude' | 'longitude' | 'altitude'> | { latitude: number; longitude: number; altitude: number },
  right: Pick<MotionTrack, 'latitude' | 'longitude' | 'altitude'> | { latitude: number; longitude: number; altitude: number },
) {
  const groundDistanceMeters = haversineKm(left.latitude, left.longitude, right.latitude, right.longitude) * 1000;
  const altitudeDistance = Math.abs(left.altitude - right.altitude);
  return Math.sqrt(groundDistanceMeters ** 2 + altitudeDistance ** 2);
}

function headingDelta(left: number, right: number) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageHeading(values: Array<number | null>) {
  const filtered = values.filter((value): value is number => value != null);
  if (filtered.length === 0) {
    return null;
  }

  const x = filtered.reduce((sum, value) => sum + Math.cos(degreesToRadians(value)), 0);
  const y = filtered.reduce((sum, value) => sum + Math.sin(degreesToRadians(value)), 0);
  return normalizeHeading(radiansToDegrees(Math.atan2(y, x)));
}

function normalizeHeading(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function clamp01(value: number) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function createEmptyTieredSnapshot() {
  return EMPTY_TIERED_GROUPS;
}
