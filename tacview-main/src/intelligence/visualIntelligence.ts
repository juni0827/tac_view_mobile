import { AIRPORTS, getAirportCoords } from '../data/airports';
import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';
import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import type { IntelFeedItem } from '../components/ui/IntelFeed';

const EARTH_RADIUS_KM = 6371;
const MIN_GROUP_SIZE = 2;
const MAX_GROUP_SIZE = 6;

export interface GlobePoint {
  latitude: number;
  longitude: number;
  altitude: number;
}

export interface PredictedPath {
  id: string;
  label: string;
  confidence: number;
  points: GlobePoint[];
}

export interface DestinationCandidate {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
  kind: 'airport' | 'facility' | 'projected' | 'coverage';
}

export interface RelatedEntitySummary {
  id: string;
  name: string;
  entityType: 'aircraft' | 'ship' | 'satellite' | 'facility' | 'group';
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
}

export interface RelationshipArc {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  inferred: boolean;
  confidence: number;
  positions: GlobePoint[];
}

export interface CoverageOverlay {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  confidence: number;
}

export interface FacilityRing {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  confidence: number;
}

export interface AnomalyMarker {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  altitude: number;
  severity: 'low' | 'medium' | 'high';
}

export interface AltitudeStem {
  from: GlobePoint;
  to: GlobePoint;
}

export interface DetectedGroup {
  id: string;
  label: string;
  groupType: 'aircraft' | 'ship';
  memberIds: string[];
  centroid: GlobePoint;
  hull: GlobePoint[];
  confidence: number;
  predictedPaths: PredictedPath[];
  destinationCandidates: DestinationCandidate[];
}

export interface SelectionContext {
  entityId: string;
  entityType: TrackedEntityInfo['entityType'];
  entityName: string;
  focus: GlobePoint;
  altitudeStem: AltitudeStem | null;
  predictedPaths: PredictedPath[];
  destinationCandidates: DestinationCandidate[];
  relatedEntities: RelatedEntitySummary[];
  relationships: RelationshipArc[];
  coverageOverlays: CoverageOverlay[];
  facilityRings: FacilityRing[];
  anomalyMarkers: AnomalyMarker[];
  relatedGroups: DetectedGroup[];
}

export interface VisualIntelligenceState {
  groups: DetectedGroup[];
  selectionContext: SelectionContext | null;
  feedItems: IntelFeedItem[];
}

interface MotionSample {
  id: string;
  name: string;
  entityType: 'aircraft' | 'ship';
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number | null;
  speed: number | null;
}

interface FacilityPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  altitude: number;
  kind: DestinationCandidate['kind'];
}

export function buildVisualIntelligenceState(
  trackedEntity: TrackedEntityInfo | null,
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
  cameras: CameraFeed[],
): VisualIntelligenceState {
  const groups = detectGroups(flights, ships, cameras);
  const selectionContext = trackedEntity
    ? buildSelectionContext(trackedEntity, flights, ships, satellites, cameras, groups)
    : null;

  const feedItems: IntelFeedItem[] = [];
  if (groups.length > 0) {
    feedItems.push({
      id: `intel-groups-${groups.length}`,
      time: new Date().toISOString().slice(11, 19),
      type: 'system',
      message: `${groups.length} auto-detected co-movement groups visualised on globe`,
    });
  }
  if (selectionContext && selectionContext.predictedPaths.length > 0) {
    feedItems.push({
      id: `intel-selection-${selectionContext.entityId}`,
      time: new Date().toISOString().slice(11, 19),
      type: 'system',
      message: `${selectionContext.entityName} expanded with ${selectionContext.predictedPaths.length} AI path hypotheses`,
    });
  }

  return {
    groups,
    selectionContext,
    feedItems,
  };
}

export function detectGroups(
  flights: Flight[],
  ships: Ship[],
  cameras: CameraFeed[],
): DetectedGroup[] {
  const groups: DetectedGroup[] = [];
  let sequence = 1;

  const aircraftSamples: MotionSample[] = flights.map((flight) => ({
    id: `flight-${flight.icao24}`,
    name: flight.callsign || flight.registration || flight.icao24,
    entityType: 'aircraft',
    latitude: flight.latitude,
    longitude: flight.longitude,
    altitude: flight.altitude,
    heading: flight.heading,
    speed: flight.velocityKnots,
  }));
  const shipSamples: MotionSample[] = ships.map((ship) => ({
    id: `ship-${ship.mmsi}`,
    name: ship.name || ship.mmsi,
    entityType: 'ship',
    latitude: ship.latitude,
    longitude: ship.longitude,
    altitude: 0,
    heading: ship.heading ?? ship.cog,
    speed: ship.sog,
  }));

  for (const result of [
    detectMotionClusters(aircraftSamples, 120, 25, 120),
    detectMotionClusters(shipSamples, 35, 30, 12),
  ]) {
    for (const cluster of result) {
      if (cluster.length < MIN_GROUP_SIZE || cluster.length > MAX_GROUP_SIZE) continue;

      const centroid = {
        latitude: average(cluster.map((sample) => sample.latitude)),
        longitude: average(cluster.map((sample) => sample.longitude)),
        altitude: average(cluster.map((sample) => sample.altitude)),
      };
      const hull = buildEnvelopeHull(cluster);
      const meanHeading = averageHeading(cluster.map((sample) => sample.heading));
      const meanSpeed = average(cluster.map((sample) => sample.speed ?? 0));
      const groupType = cluster[0]?.entityType ?? 'aircraft';
      const labelPrefix = groupType === 'aircraft' ? 'AIR GROUP' : 'SURFACE GROUP';
      const groupId = `group-${groupType}-${sequence}`;
      const predictedPaths = buildGroupPredictions(groupId, centroid, meanHeading, meanSpeed);
      const destinationCandidates = findGroupDestinations(groupId, predictedPaths, cameras);

      groups.push({
        id: groupId,
        label: `${labelPrefix} ${sequence}`,
        groupType,
        memberIds: cluster.map((sample) => sample.id),
        centroid,
        hull,
        confidence: clamp01(0.45 + cluster.length * 0.12),
        predictedPaths,
        destinationCandidates,
      });
      sequence += 1;
    }
  }

  return groups;
}

function buildSelectionContext(
  trackedEntity: TrackedEntityInfo,
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
  cameras: CameraFeed[],
  groups: DetectedGroup[],
): SelectionContext | null {
  if (trackedEntity.id.startsWith('flight-')) {
    const flight = flights.find((candidate) => trackedEntity.id === `flight-${candidate.icao24}`);
    if (!flight) return null;
    return buildFlightSelectionContext(trackedEntity, flight, flights, cameras, groups);
  }

  if (trackedEntity.id.startsWith('ship-')) {
    const ship = ships.find((candidate) => trackedEntity.id === `ship-${candidate.mmsi}`);
    if (!ship) return null;
    return buildShipSelectionContext(trackedEntity, ship, ships, cameras, groups);
  }

  if (trackedEntity.id.startsWith('sat-')) {
    const noradId = Number.parseInt(trackedEntity.id.slice(4), 10);
    const satellite = satellites.find((candidate) => candidate.noradId === noradId);
    if (!satellite) return null;
    return buildSatelliteSelectionContext(trackedEntity, satellite, cameras, groups);
  }

  if (trackedEntity.id.startsWith('group-')) {
    const group = groups.find((candidate) => candidate.id === trackedEntity.id);
    if (!group) return null;
    return buildGroupSelectionContext(trackedEntity, group, flights, ships, cameras);
  }

  if (trackedEntity.id.startsWith('cctv-')) {
    const cameraId = trackedEntity.id.slice(5);
    const camera = cameras.find((candidate) => candidate.id === cameraId);
    if (!camera) return null;
    return buildFacilitySelectionContext(trackedEntity, camera, flights, ships, satellites);
  }

  if (trackedEntity.id.startsWith('facility-airport-')) {
    const airportCode = trackedEntity.id.slice('facility-airport-'.length);
    const coords = getAirportCoords(airportCode);
    if (!coords) return null;
    return buildAirportSelectionContext(trackedEntity, airportCode, coords, flights, ships, satellites);
  }

  return null;
}

function buildFlightSelectionContext(
  trackedEntity: TrackedEntityInfo,
  flight: Flight,
  flights: Flight[],
  cameras: CameraFeed[],
  groups: DetectedGroup[],
): SelectionContext {
  const focus = toPoint(flight.latitude, flight.longitude, flight.altitude);
  const heading = flight.heading ?? 0;
  const speed = flight.velocityKnots ?? 430;
  const primaryPath = buildProjectedPath(
    `${trackedEntity.id}-path-1`,
    'KINEMATIC',
    focus,
    heading,
    speed * 1.852,
    [0, 10, 25, 45],
    0.82,
  );
  const routeDestination = flight.destAirport ? toAirportFacility(flight.destAirport) : null;
  const routePath = routeDestination
    ? buildPathToTarget(`${trackedEntity.id}-path-2`, 'ROUTE DEST', focus, routeDestination, 0.76)
    : buildProjectedPath(
      `${trackedEntity.id}-path-2`,
      'OFFSET RIGHT',
      focus,
      heading + 18,
      speed * 1.7,
      [0, 10, 20, 35],
      0.58,
    );
  const contingencyPath = buildProjectedPath(
    `${trackedEntity.id}-path-3`,
    'OFFSET LEFT',
    focus,
    heading - 18,
    speed * 1.45,
    [0, 8, 18, 30],
    0.49,
  );
  const predictedPaths = [primaryPath, routePath, contingencyPath];

  const destinationCandidates = dedupeDestinations([
    routeDestination ? toDestinationCandidate(routeDestination, 0.86) : null,
    toProjectedDestination(`${trackedEntity.id}-dest-primary`, 'Projected endpoint', primaryPath, 0.74),
    findNearestAirportCandidate(primaryPath.points[primaryPath.points.length - 1], 320, 0.58),
  ]);

  const relatedFlights = flights
    .filter((candidate) => candidate.icao24 !== flight.icao24)
    .map((candidate) => ({
      entity: candidate,
      score: scoreFlightRelationship(flight, candidate),
    }))
    .filter((candidate) => candidate.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);

  const relatedEntities: RelatedEntitySummary[] = relatedFlights.map(({ entity, score }) => ({
    id: `flight-${entity.icao24}`,
    name: entity.callsign || entity.registration || entity.icao24,
    entityType: 'aircraft',
    latitude: entity.latitude,
    longitude: entity.longitude,
    altitude: entity.altitude,
    confidence: score,
  }));

  const activeGroup = groups.filter((group) => group.memberIds.includes(trackedEntity.id));
  const relationships: RelationshipArc[] = [
    ...relatedEntities.map((entity, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-air-${index}`,
      trackedEntity.id,
      entity.id,
      entity.confidence >= 0.65 ? 'formation / peer pattern' : 'route affinity',
      true,
      entity.confidence,
      focus,
      toPoint(entity.latitude, entity.longitude, entity.altitude),
    )),
    ...destinationCandidates.map((candidate, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-dest-${index}`,
      trackedEntity.id,
      candidate.id,
      candidate.kind === 'airport' ? 'destination candidate' : 'predicted arrival',
      candidate.kind !== 'airport',
      candidate.confidence,
      focus,
      toPoint(candidate.latitude, candidate.longitude, candidate.altitude),
    )),
    ...activeGroup.map((group, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-group-${index}`,
      trackedEntity.id,
      group.id,
      'co-movement group',
      false,
      group.confidence,
      focus,
      group.centroid,
    )),
  ];

  const facilityRings = destinationCandidates.map((candidate, index) => ({
    id: `${trackedEntity.id}-facility-${index}`,
    label: candidate.label,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    radiusKm: candidate.kind === 'airport' ? 45 : 25,
    confidence: candidate.confidence,
  }));

  const anomalyMarkers: AnomalyMarker[] = [];
  if (!flight.destAirport && (flight.velocityKnots ?? 0) > 300) {
    anomalyMarkers.push({
      id: `${trackedEntity.id}-anomaly-route`,
      label: 'route uncertainty',
      latitude: primaryPath.points[2]?.latitude ?? flight.latitude,
      longitude: primaryPath.points[2]?.longitude ?? flight.longitude,
      altitude: primaryPath.points[2]?.altitude ?? flight.altitude,
      severity: 'medium',
    });
  }
  if (activeGroup.length > 0) {
    anomalyMarkers.push({
      id: `${trackedEntity.id}-anomaly-group`,
      label: 'co-movement',
      latitude: flight.latitude,
      longitude: flight.longitude,
      altitude: flight.altitude,
      severity: 'high',
    });
  }

  const nearbyCameras = cameras
    .map((camera) => ({ camera, distanceKm: haversineKm(flight.latitude, flight.longitude, camera.latitude, camera.longitude) }))
    .filter((candidate) => candidate.distanceKm < 250)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 2);
  for (const [index, { camera, distanceKm }] of nearbyCameras.entries()) {
    relationships.push(buildRelationshipArc(
      `${trackedEntity.id}-rel-cctv-${index}`,
      trackedEntity.id,
      `cctv-${camera.id}`,
      `sensor overlap ${Math.round(distanceKm)}km`,
      true,
      clamp01(0.7 - distanceKm / 500),
      focus,
      toPoint(camera.latitude, camera.longitude, 0),
    ));
    relatedEntities.push({
      id: `cctv-${camera.id}`,
      name: camera.name,
      entityType: 'facility',
      latitude: camera.latitude,
      longitude: camera.longitude,
      altitude: 0,
      confidence: clamp01(0.7 - distanceKm / 500),
    });
  }

  return {
    entityId: trackedEntity.id,
    entityType: trackedEntity.entityType,
    entityName: trackedEntity.name,
    focus,
    altitudeStem: {
      from: toPoint(flight.latitude, flight.longitude, 0),
      to: focus,
    },
    predictedPaths,
    destinationCandidates,
    relatedEntities,
    relationships,
    coverageOverlays: [],
    facilityRings,
    anomalyMarkers,
    relatedGroups: activeGroup,
  };
}

function buildShipSelectionContext(
  trackedEntity: TrackedEntityInfo,
  ship: Ship,
  ships: Ship[],
  cameras: CameraFeed[],
  groups: DetectedGroup[],
): SelectionContext {
  const focus = toPoint(ship.latitude, ship.longitude, 0);
  const heading = ship.heading ?? ship.cog ?? 0;
  const speed = ship.sog || 12;
  const predictedPaths = [
    buildProjectedPath(`${trackedEntity.id}-path-1`, 'SURFACE TRACK', focus, heading, speed * 1.852, [0, 10, 25, 45], 0.79),
    buildProjectedPath(`${trackedEntity.id}-path-2`, 'STARBOARD DRIFT', focus, heading + 12, speed * 1.5, [0, 10, 20, 35], 0.57),
    buildProjectedPath(`${trackedEntity.id}-path-3`, 'PORT DRIFT', focus, heading - 12, speed * 1.5, [0, 10, 20, 35], 0.53),
  ];

  const nearbyFacilities = cameras
    .map((camera) => ({ camera, distanceKm: haversineKm(ship.latitude, ship.longitude, camera.latitude, camera.longitude) }))
    .filter((candidate) => candidate.distanceKm < 180)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 3);

  const destinationCandidates = dedupeDestinations([
    toProjectedDestination(`${trackedEntity.id}-dest-1`, 'Projected endpoint', predictedPaths[0], 0.76),
    ...nearbyFacilities.map(({ camera }, index) => ({
      id: `facility-camera-${camera.id}-${index}`,
      label: camera.name,
      latitude: camera.latitude,
      longitude: camera.longitude,
      altitude: 0,
      confidence: 0.55,
      kind: 'facility' as const,
    })),
  ]);

  const relatedShips = ships
    .filter((candidate) => candidate.mmsi !== ship.mmsi)
    .map((candidate) => ({
      entity: candidate,
      score: scoreShipRelationship(ship, candidate),
    }))
    .filter((candidate) => candidate.score > 0.25)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);

  const relatedEntities: RelatedEntitySummary[] = relatedShips.map(({ entity, score }) => ({
    id: `ship-${entity.mmsi}`,
    name: entity.name || entity.mmsi,
    entityType: 'ship',
    latitude: entity.latitude,
    longitude: entity.longitude,
    altitude: 0,
    confidence: score,
  }));

  const activeGroup = groups.filter((group) => group.memberIds.includes(trackedEntity.id));
  const relationships: RelationshipArc[] = [
    ...relatedEntities.map((entity, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-ship-${index}`,
      trackedEntity.id,
      entity.id,
      entity.confidence >= 0.6 ? 'convoy / co-movement' : 'surface proximity',
      true,
      entity.confidence,
      focus,
      toPoint(entity.latitude, entity.longitude, entity.altitude),
    )),
    ...destinationCandidates.map((candidate, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-dest-${index}`,
      trackedEntity.id,
      candidate.id,
      candidate.kind === 'facility' ? 'coastal facility' : 'predicted surface endpoint',
      true,
      candidate.confidence,
      focus,
      toPoint(candidate.latitude, candidate.longitude, candidate.altitude),
    )),
    ...activeGroup.map((group, index) => buildRelationshipArc(
      `${trackedEntity.id}-rel-group-${index}`,
      trackedEntity.id,
      group.id,
      'surface group',
      false,
      group.confidence,
      focus,
      group.centroid,
    )),
  ];

  const anomalyMarkers: AnomalyMarker[] = [];
  if (!ship.destination && ship.sog > 6) {
    anomalyMarkers.push({
      id: `${trackedEntity.id}-anomaly-destination`,
      label: 'destination unknown',
      latitude: predictedPaths[0].points[2]?.latitude ?? ship.latitude,
      longitude: predictedPaths[0].points[2]?.longitude ?? ship.longitude,
      altitude: 0,
      severity: 'medium',
    });
  }

  return {
    entityId: trackedEntity.id,
    entityType: trackedEntity.entityType,
    entityName: trackedEntity.name,
    focus,
    altitudeStem: null,
    predictedPaths,
    destinationCandidates,
    relatedEntities,
    relationships,
    coverageOverlays: [],
    facilityRings: destinationCandidates.map((candidate, index) => ({
      id: `${trackedEntity.id}-facility-ring-${index}`,
      label: candidate.label,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      radiusKm: candidate.kind === 'facility' ? 18 : 28,
      confidence: candidate.confidence,
    })),
    anomalyMarkers,
    relatedGroups: activeGroup,
  };
}

function buildSatelliteSelectionContext(
  trackedEntity: TrackedEntityInfo,
  satellite: SatellitePosition,
  cameras: CameraFeed[],
  groups: DetectedGroup[],
): SelectionContext {
  const focus = toPoint(satellite.latitude, satellite.longitude, satellite.altitude * 1000);
  const coverageRadiusKm = computeSatelliteCoverageKm(satellite.altitude);
  const predictedPaths = buildSatellitePredictions(trackedEntity.id, satellite);
  const visibleFacilities = cameras
    .map((camera) => ({
      camera,
      distanceKm: haversineKm(satellite.latitude, satellite.longitude, camera.latitude, camera.longitude),
    }))
    .filter((candidate) => candidate.distanceKm <= coverageRadiusKm)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 4);

  const destinationCandidates = dedupeDestinations([
    ...visibleFacilities.map(({ camera }, index) => ({
      id: `facility-camera-${camera.id}-${index}`,
      label: camera.name,
      latitude: camera.latitude,
      longitude: camera.longitude,
      altitude: 0,
      confidence: clamp01(0.88 - index * 0.15),
      kind: 'coverage' as const,
    })),
    toProjectedDestination(`${trackedEntity.id}-coverage-1`, 'Next coverage point', predictedPaths[0], 0.62),
  ]);

  const relationships = destinationCandidates.map((candidate, index) => buildRelationshipArc(
    `${trackedEntity.id}-rel-coverage-${index}`,
    trackedEntity.id,
    candidate.id,
    candidate.kind === 'coverage' ? 'coverage overlap' : 'next pass',
    true,
    candidate.confidence,
    focus,
    toPoint(candidate.latitude, candidate.longitude, candidate.altitude),
  ));

  return {
    entityId: trackedEntity.id,
    entityType: trackedEntity.entityType,
    entityName: trackedEntity.name,
    focus,
    altitudeStem: {
      from: toPoint(satellite.latitude, satellite.longitude, 0),
      to: focus,
    },
    predictedPaths,
    destinationCandidates,
    relatedEntities: visibleFacilities.map(({ camera }, index) => ({
      id: `cctv-${camera.id}`,
      name: camera.name,
      entityType: 'facility',
      latitude: camera.latitude,
      longitude: camera.longitude,
      altitude: 0,
      confidence: clamp01(0.88 - index * 0.15),
    })),
    relationships,
    coverageOverlays: [
      {
        id: `${trackedEntity.id}-coverage`,
        label: `${Math.round(coverageRadiusKm)} km footprint`,
        latitude: satellite.latitude,
        longitude: satellite.longitude,
        radiusKm: coverageRadiusKm,
        confidence: 0.92,
      },
    ],
    facilityRings: [],
    anomalyMarkers: visibleFacilities.length > 0
      ? [{
        id: `${trackedEntity.id}-coverage-alert`,
        label: 'coverage intersection',
        latitude: visibleFacilities[0]?.camera.latitude ?? satellite.latitude,
        longitude: visibleFacilities[0]?.camera.longitude ?? satellite.longitude,
        altitude: 0,
        severity: 'medium',
      }]
      : [],
    relatedGroups: groups.filter((group) =>
      group.destinationCandidates.some((candidate) =>
        haversineKm(candidate.latitude, candidate.longitude, satellite.latitude, satellite.longitude) <= coverageRadiusKm,
      ),
    ),
  };
}

function buildGroupSelectionContext(
  trackedEntity: TrackedEntityInfo,
  group: DetectedGroup,
  flights: Flight[],
  ships: Ship[],
  cameras: CameraFeed[],
): SelectionContext {
  const relatedEntities: RelatedEntitySummary[] = group.memberIds.map((memberId) => {
    if (memberId.startsWith('flight-')) {
      const flight = flights.find((candidate) => `flight-${candidate.icao24}` === memberId);
      if (flight) {
        return {
          id: memberId,
          name: flight.callsign || flight.registration || flight.icao24,
          entityType: 'aircraft' as const,
          latitude: flight.latitude,
          longitude: flight.longitude,
          altitude: flight.altitude,
          confidence: group.confidence,
        };
      }
    }

    const ship = ships.find((candidate) => `ship-${candidate.mmsi}` === memberId);
    return {
      id: memberId,
      name: ship?.name || memberId,
      entityType: 'ship',
      latitude: ship?.latitude ?? group.centroid.latitude,
      longitude: ship?.longitude ?? group.centroid.longitude,
      altitude: 0,
      confidence: group.confidence,
    };
  });

  const relationships = relatedEntities.map((entity, index) => buildRelationshipArc(
    `${trackedEntity.id}-member-${index}`,
    trackedEntity.id,
    entity.id,
    'member',
    false,
    entity.confidence,
    group.centroid,
    toPoint(entity.latitude, entity.longitude, entity.altitude),
  ));

  const nearbyFacilities = cameras
    .map((camera) => ({ camera, distanceKm: haversineKm(group.centroid.latitude, group.centroid.longitude, camera.latitude, camera.longitude) }))
    .filter((candidate) => candidate.distanceKm < 220)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 3);
  for (const [index, { camera, distanceKm }] of nearbyFacilities.entries()) {
    relationships.push(buildRelationshipArc(
      `${trackedEntity.id}-facility-${index}`,
      trackedEntity.id,
      `cctv-${camera.id}`,
      `facility affinity ${Math.round(distanceKm)}km`,
      true,
      clamp01(0.7 - distanceKm / 300),
      group.centroid,
      toPoint(camera.latitude, camera.longitude, 0),
    ));
  }

  return {
    entityId: trackedEntity.id,
    entityType: trackedEntity.entityType,
    entityName: trackedEntity.name,
    focus: group.centroid,
    altitudeStem: null,
    predictedPaths: group.predictedPaths,
    destinationCandidates: group.destinationCandidates,
    relatedEntities,
    relationships,
    coverageOverlays: [],
    facilityRings: group.destinationCandidates.map((candidate, index) => ({
      id: `${trackedEntity.id}-ring-${index}`,
      label: candidate.label,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      radiusKm: 22,
      confidence: candidate.confidence,
    })),
    anomalyMarkers: [{
      id: `${trackedEntity.id}-group-alert`,
      label: 'group cohesion',
      latitude: group.centroid.latitude,
      longitude: group.centroid.longitude,
      altitude: group.centroid.altitude,
      severity: 'high',
    }],
    relatedGroups: [group],
  };
}

function buildFacilitySelectionContext(
  trackedEntity: TrackedEntityInfo,
  camera: CameraFeed,
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
): SelectionContext {
  const focus = toPoint(camera.latitude, camera.longitude, 0);
  const nearbyFlightLinks = flights
    .map((flight) => ({
      id: `flight-${flight.icao24}`,
      name: flight.callsign || flight.registration || flight.icao24,
      entityType: 'aircraft' as const,
      latitude: flight.latitude,
      longitude: flight.longitude,
      altitude: flight.altitude,
      confidence: 1 - Math.min(haversineKm(camera.latitude, camera.longitude, flight.latitude, flight.longitude) / 300, 1),
    }))
    .filter((candidate) => candidate.confidence > 0.35)
    .slice(0, 3);
  const nearbyShips = ships
    .map((ship) => ({
      id: `ship-${ship.mmsi}`,
      name: ship.name || ship.mmsi,
      entityType: 'ship' as const,
      latitude: ship.latitude,
      longitude: ship.longitude,
      altitude: 0,
      confidence: 1 - Math.min(haversineKm(camera.latitude, camera.longitude, ship.latitude, ship.longitude) / 200, 1),
    }))
    .filter((candidate) => candidate.confidence > 0.35)
    .slice(0, 3);
  const satelliteCoverage = satellites
    .map((satellite) => ({
      satellite,
      radiusKm: computeSatelliteCoverageKm(satellite.altitude),
    }))
    .filter((candidate) =>
      haversineKm(camera.latitude, camera.longitude, candidate.satellite.latitude, candidate.satellite.longitude) <= candidate.radiusKm,
    )
    .slice(0, 2);

  const relatedEntities = [...nearbyFlightLinks, ...nearbyShips, ...satelliteCoverage.map(({ satellite }) => ({
    id: `sat-${satellite.noradId}`,
    name: satellite.name,
    entityType: 'satellite' as const,
    latitude: satellite.latitude,
    longitude: satellite.longitude,
    altitude: satellite.altitude * 1000,
    confidence: 0.75,
  }))];

  const relationships = relatedEntities.map((entity, index) => buildRelationshipArc(
    `${trackedEntity.id}-facility-rel-${index}`,
    trackedEntity.id,
    entity.id,
    entity.entityType === 'satellite' ? 'coverage' : 'approach corridor',
    true,
    entity.confidence,
    focus,
    toPoint(entity.latitude, entity.longitude, entity.altitude),
  ));

  return {
    entityId: trackedEntity.id,
    entityType: trackedEntity.entityType,
    entityName: trackedEntity.name,
    focus,
    altitudeStem: null,
    predictedPaths: [],
    destinationCandidates: [],
    relatedEntities,
    relationships,
    coverageOverlays: [],
    facilityRings: [
      {
        id: `${trackedEntity.id}-inner-ring`,
        label: `${camera.name} sensor ring`,
        latitude: camera.latitude,
        longitude: camera.longitude,
        radiusKm: 8,
        confidence: 0.9,
      },
      {
        id: `${trackedEntity.id}-outer-ring`,
        label: `${camera.name} context ring`,
        latitude: camera.latitude,
        longitude: camera.longitude,
        radiusKm: 30,
        confidence: 0.55,
      },
    ],
    anomalyMarkers: relatedEntities.length >= 4
      ? [{
        id: `${trackedEntity.id}-facility-alert`,
        label: 'multi-asset activity',
        latitude: camera.latitude,
        longitude: camera.longitude,
        altitude: 0,
        severity: 'medium',
      }]
      : [],
    relatedGroups: [],
  };
}

function buildAirportSelectionContext(
  trackedEntity: TrackedEntityInfo,
  airportCode: string,
  coords: { lat: number; lon: number; name?: string },
  flights: Flight[],
  ships: Ship[],
  satellites: SatellitePosition[],
): SelectionContext {
  const focus = toPoint(coords.lat, coords.lon, 0);
  const relatedFlights = flights
    .filter((flight) => flight.originAirport === airportCode || flight.destAirport === airportCode)
    .slice(0, 5)
    .map((flight) => ({
      id: `flight-${flight.icao24}`,
      name: flight.callsign || flight.registration || flight.icao24,
      entityType: 'aircraft' as const,
      latitude: flight.latitude,
      longitude: flight.longitude,
      altitude: flight.altitude,
      confidence: 0.75,
    }));
  const satelliteLinks = satellites
    .map((satellite) => ({
      satellite,
      radiusKm: computeSatelliteCoverageKm(satellite.altitude),
    }))
    .filter((candidate) => haversineKm(coords.lat, coords.lon, candidate.satellite.latitude, candidate.satellite.longitude) <= candidate.radiusKm)
    .slice(0, 2);
  const relatedEntities = [
    ...relatedFlights,
    ...satelliteLinks.map(({ satellite }) => ({
      id: `sat-${satellite.noradId}`,
      name: satellite.name,
      entityType: 'satellite' as const,
      latitude: satellite.latitude,
      longitude: satellite.longitude,
      altitude: satellite.altitude * 1000,
      confidence: 0.72,
    })),
  ];

  return {
    entityId: trackedEntity.id,
    entityType: 'facility',
    entityName: coords.name || airportCode,
    focus,
    altitudeStem: null,
    predictedPaths: [],
    destinationCandidates: [],
    relatedEntities,
    relationships: relatedEntities.map((entity, index) => buildRelationshipArc(
      `${trackedEntity.id}-airport-rel-${index}`,
      trackedEntity.id,
      entity.id,
      entity.entityType === 'satellite' ? 'coverage' : 'airport traffic',
      true,
      entity.confidence,
      focus,
      toPoint(entity.latitude, entity.longitude, entity.altitude),
    )),
    coverageOverlays: [],
    facilityRings: [{
      id: `${trackedEntity.id}-airport-ring`,
      label: coords.name || airportCode,
      latitude: coords.lat,
      longitude: coords.lon,
      radiusKm: 36,
      confidence: 0.8,
    }],
    anomalyMarkers: ships.length > 0
      ? [{
        id: `${trackedEntity.id}-airport-alert`,
        label: `${relatedFlights.length} linked aircraft`,
        latitude: coords.lat,
        longitude: coords.lon,
        altitude: 0,
        severity: relatedFlights.length >= 3 ? 'medium' : 'low',
      }]
      : [],
    relatedGroups: [],
  };
}

function detectMotionClusters(
  samples: MotionSample[],
  maxDistanceKm: number,
  maxHeadingDelta: number,
  maxSpeedDelta: number,
): MotionSample[][] {
  if (samples.length < MIN_GROUP_SIZE) {
    return [];
  }

  const visited = new Set<string>();
  const groups: MotionSample[][] = [];

  for (const sample of samples) {
    if (visited.has(sample.id)) continue;

    const cluster: MotionSample[] = [];
    const queue = [sample];
    visited.add(sample.id);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      cluster.push(current);

      for (const candidate of samples) {
        if (visited.has(candidate.id)) continue;
        if (!isMotionLinked(current, candidate, maxDistanceKm, maxHeadingDelta, maxSpeedDelta)) continue;

        visited.add(candidate.id);
        queue.push(candidate);
      }
    }

    if (cluster.length >= MIN_GROUP_SIZE) {
      groups.push(cluster);
    }
  }

  return groups;
}

function isMotionLinked(
  left: MotionSample,
  right: MotionSample,
  maxDistanceKm: number,
  maxHeadingDelta: number,
  maxSpeedDelta: number,
): boolean {
  const distanceKm = haversineKm(left.latitude, left.longitude, right.latitude, right.longitude);
  if (distanceKm > maxDistanceKm) return false;

  if (left.heading != null && right.heading != null && headingDelta(left.heading, right.heading) > maxHeadingDelta) {
    return false;
  }

  const speedLeft = left.speed ?? 0;
  const speedRight = right.speed ?? 0;
  return Math.abs(speedLeft - speedRight) <= maxSpeedDelta;
}

function buildGroupPredictions(
  groupId: string,
  centroid: GlobePoint,
  heading: number | null,
  speed: number,
): PredictedPath[] {
  const baseHeading = heading ?? 0;
  const speedKph = Math.max(speed, 20);
  return [
    buildProjectedPath(`${groupId}-path-1`, 'GROUP VECTOR', centroid, baseHeading, speedKph, [0, 10, 25, 45], 0.78),
    buildProjectedPath(`${groupId}-path-2`, 'GROUP RIGHT', centroid, baseHeading + 12, speedKph * 0.9, [0, 10, 20, 35], 0.56),
    buildProjectedPath(`${groupId}-path-3`, 'GROUP LEFT', centroid, baseHeading - 12, speedKph * 0.9, [0, 10, 20, 35], 0.52),
  ];
}

function findGroupDestinations(
  groupId: string,
  predictedPaths: PredictedPath[],
  cameras: CameraFeed[],
): DestinationCandidate[] {
  const primaryEndpoint = predictedPaths[0]?.points[predictedPaths[0].points.length - 1];
  if (!primaryEndpoint) {
    return [];
  }

  const nearbyFacilities = cameras
    .map((camera) => ({
      camera,
      distanceKm: haversineKm(primaryEndpoint.latitude, primaryEndpoint.longitude, camera.latitude, camera.longitude),
    }))
    .filter((candidate) => candidate.distanceKm < 180)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, 2)
    .map(({ camera }, index) => ({
      id: `facility-camera-${camera.id}-${index}`,
      label: camera.name,
      latitude: camera.latitude,
      longitude: camera.longitude,
      altitude: 0,
      confidence: 0.6 - index * 0.1,
      kind: 'facility' as const,
    }));

  return dedupeDestinations([
    toProjectedDestination(`${groupId}-dest-project`, 'Projected group endpoint', predictedPaths[0], 0.74),
    findNearestAirportCandidate(primaryEndpoint, 320, 0.58),
    ...nearbyFacilities,
  ]);
}

function buildSatellitePredictions(entityId: string, satellite: SatellitePosition): PredictedPath[] {
  const futurePoints = satellite.orbitPath.slice(0, 60);
  const waypoints = [
    futurePoints.slice(0, 12),
    futurePoints.slice(0, 25),
    futurePoints.slice(0, 45),
  ].filter((points) => points.length >= 2);

  return waypoints.map((points, index) => ({
    id: `${entityId}-path-${index + 1}`,
    label: index === 0 ? 'NEXT PASS' : index === 1 ? 'MID PASS' : 'LONG PASS',
    confidence: index === 0 ? 0.8 : index === 1 ? 0.64 : 0.52,
    points: [
      toPoint(satellite.latitude, satellite.longitude, satellite.altitude * 1000),
      ...points
        .filter((_, pointIndex) => pointIndex === 3 || pointIndex === Math.floor(points.length / 2) || pointIndex === points.length - 1)
        .map((point) => toPoint(point.latitude, point.longitude, point.altitude * 1000)),
    ].slice(0, 4),
  }));
}

function buildProjectedPath(
  id: string,
  label: string,
  origin: GlobePoint,
  headingDeg: number,
  speedKph: number,
  horizonMinutes: number[],
  confidence: number,
): PredictedPath {
  const points = horizonMinutes.map((minute) => {
    if (minute === 0) {
      return origin;
    }
    const distanceKm = speedKph * (minute / 60);
    const projected = projectPoint(origin.latitude, origin.longitude, headingDeg, distanceKm);
    return {
      latitude: projected.latitude,
      longitude: projected.longitude,
      altitude: origin.altitude,
    };
  });

  return {
    id,
    label,
    confidence,
    points,
  };
}

function buildPathToTarget(
  id: string,
  label: string,
  origin: GlobePoint,
  target: FacilityPoint,
  confidence: number,
): PredictedPath {
  const midOne = lerpPoint(origin, target, 0.33);
  const midTwo = lerpPoint(origin, target, 0.66);
  return {
    id,
    label,
    confidence,
    points: [
      origin,
      midOne,
      midTwo,
      toPoint(target.latitude, target.longitude, target.altitude),
    ],
  };
}

function buildRelationshipArc(
  id: string,
  sourceId: string,
  targetId: string,
  label: string,
  inferred: boolean,
  confidence: number,
  source: GlobePoint,
  target: GlobePoint,
): RelationshipArc {
  return {
    id,
    sourceId,
    targetId,
    label,
    inferred,
    confidence,
    positions: [
      source,
      lerpPoint(source, target, 0.5, Math.max(source.altitude, target.altitude) + 60000),
      target,
    ],
  };
}

function buildEnvelopeHull(samples: MotionSample[]): GlobePoint[] {
  const latitudes = samples.map((sample) => sample.latitude);
  const longitudes = samples.map((sample) => sample.longitude);
  const minLat = Math.min(...latitudes) - 0.06;
  const maxLat = Math.max(...latitudes) + 0.06;
  const minLon = Math.min(...longitudes) - 0.06;
  const maxLon = Math.max(...longitudes) + 0.06;

  return [
    toPoint(minLat, minLon, 0),
    toPoint(minLat, maxLon, 0),
    toPoint(maxLat, maxLon, 0),
    toPoint(maxLat, minLon, 0),
  ];
}

function computeSatelliteCoverageKm(altitudeKm: number): number {
  const orbitRadius = EARTH_RADIUS_KM + altitudeKm;
  return Math.sqrt(Math.max(orbitRadius * orbitRadius - EARTH_RADIUS_KM * EARTH_RADIUS_KM, 0));
}

function toPoint(latitude: number, longitude: number, altitude: number): GlobePoint {
  return {
    latitude,
    longitude,
    altitude,
  };
}

function toAirportFacility(code: string): FacilityPoint | null {
  const airport = getAirportCoords(code);
  if (!airport) return null;
  return {
    id: `facility-airport-${code.toUpperCase()}`,
    label: airport.name || code.toUpperCase(),
    latitude: airport.lat,
    longitude: airport.lon,
    altitude: 0,
    kind: 'airport',
  };
}

function toDestinationCandidate(facility: FacilityPoint, confidence: number): DestinationCandidate {
  return {
    id: facility.id,
    label: facility.label,
    latitude: facility.latitude,
    longitude: facility.longitude,
    altitude: facility.altitude,
    confidence,
    kind: facility.kind,
  };
}

function toProjectedDestination(
  id: string,
  label: string,
  path: PredictedPath,
  confidence: number,
): DestinationCandidate | null {
  const endpoint = path.points[path.points.length - 1];
  if (!endpoint) return null;
  return {
    id,
    label,
    latitude: endpoint.latitude,
    longitude: endpoint.longitude,
    altitude: endpoint.altitude,
    confidence,
    kind: 'projected',
  };
}

function findNearestAirportCandidate(point: GlobePoint, maxDistanceKm: number, confidence: number): DestinationCandidate | null {
  let bestCode: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [code, airport] of Object.entries(AIRPORTS)) {
    const distanceKm = haversineKm(point.latitude, point.longitude, airport.lat, airport.lon);
    if (distanceKm < bestDistance && distanceKm <= maxDistanceKm) {
      bestCode = code;
      bestDistance = distanceKm;
    }
  }

  if (!bestCode) return null;
  const facility = toAirportFacility(bestCode);
  return facility ? toDestinationCandidate(facility, confidence) : null;
}

function dedupeDestinations(
  candidates: Array<DestinationCandidate | null>,
): DestinationCandidate[] {
  const next = new Map<string, DestinationCandidate>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!next.has(candidate.id)) {
      next.set(candidate.id, candidate);
    }
  }
  return Array.from(next.values()).slice(0, 3);
}

function scoreFlightRelationship(source: Flight, candidate: Flight): number {
  let score = 0;
  const distanceKm = haversineKm(source.latitude, source.longitude, candidate.latitude, candidate.longitude);
  if (distanceKm < 250) score += 0.35;
  if (source.airline && candidate.airline && source.airline === candidate.airline) score += 0.25;
  if (source.originAirport && source.originAirport === candidate.originAirport) score += 0.12;
  if (source.destAirport && source.destAirport === candidate.destAirport) score += 0.18;
  if (source.heading != null && candidate.heading != null && headingDelta(source.heading, candidate.heading) < 18) score += 0.18;
  return clamp01(score);
}

function scoreShipRelationship(source: Ship, candidate: Ship): number {
  let score = 0;
  const distanceKm = haversineKm(source.latitude, source.longitude, candidate.latitude, candidate.longitude);
  if (distanceKm < 80) score += 0.4;
  if (source.destination && candidate.destination && source.destination === candidate.destination) score += 0.2;
  const sourceHeading = source.heading ?? source.cog;
  const candidateHeading = candidate.heading ?? candidate.cog;
  if (sourceHeading != null && candidateHeading != null && headingDelta(sourceHeading, candidateHeading) < 22) score += 0.2;
  if ((source.shipType ?? 0) > 0 && source.shipType === candidate.shipType) score += 0.1;
  return clamp01(score);
}

function projectPoint(latitude: number, longitude: number, headingDeg: number, distanceKm: number) {
  const distanceRad = distanceKm / EARTH_RADIUS_KM;
  const headingRad = degreesToRadians(headingDeg);
  const latitudeRad = degreesToRadians(latitude);
  const longitudeRad = degreesToRadians(longitude);

  const nextLatitude = Math.asin(
    Math.sin(latitudeRad) * Math.cos(distanceRad) +
      Math.cos(latitudeRad) * Math.sin(distanceRad) * Math.cos(headingRad),
  );
  const nextLongitude = longitudeRad + Math.atan2(
    Math.sin(headingRad) * Math.sin(distanceRad) * Math.cos(latitudeRad),
    Math.cos(distanceRad) - Math.sin(latitudeRad) * Math.sin(nextLatitude),
  );

  return {
    latitude: radiansToDegrees(nextLatitude),
    longitude: normalizeLongitude(radiansToDegrees(nextLongitude)),
  };
}

function lerpPoint(
  origin: GlobePoint,
  target: Pick<GlobePoint, 'latitude' | 'longitude' | 'altitude'>,
  fraction: number,
  altitudeOverride?: number,
): GlobePoint {
  return {
    latitude: origin.latitude + (target.latitude - origin.latitude) * fraction,
    longitude: normalizeLongitude(origin.longitude + (target.longitude - origin.longitude) * fraction),
    altitude: altitudeOverride ?? origin.altitude + (target.altitude - origin.altitude) * fraction,
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const lat1Rad = degreesToRadians(lat1);
  const lat2Rad = degreesToRadians(lat2);
  const deltaLat = degreesToRadians(lat2 - lat1);
  const deltaLon = degreesToRadians(lon2 - lon1);

  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function headingDelta(left: number, right: number) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageHeading(values: Array<number | null>) {
  const filtered = values.filter((value): value is number => value != null);
  if (filtered.length === 0) return null;

  const x = filtered.reduce((sum, value) => sum + Math.cos(degreesToRadians(value)), 0);
  const y = filtered.reduce((sum, value) => sum + Math.sin(degreesToRadians(value)), 0);
  return normalizeHeading(radiansToDegrees(Math.atan2(y, x)));
}

function normalizeHeading(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeLongitude(value: number) {
  let longitude = value;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return longitude;
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
