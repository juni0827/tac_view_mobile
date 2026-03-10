import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Viewer as CesiumViewer, Cartesian3, Color, ConstantProperty, Math as CesiumMath, Entity as CesiumEntity } from 'cesium';
import type { CameraFeed } from './types/camera';
import GlobeViewer from './components/globe/GlobeViewer';
import EarthquakeLayer from './components/layers/EarthquakeLayer';
import SatelliteLayer from './components/layers/SatelliteLayer';
import FlightLayer from './components/layers/FlightLayer';
import TrafficLayer from './components/layers/TrafficLayer';
import CCTVLayer from './components/layers/CCTVLayer';
import ShipLayer from './components/layers/ShipLayer';
import OntologyLayer from './components/layers/OntologyLayer';
import type { SatelliteCategory } from './components/layers/SatelliteLayer';
import type { AltitudeBand } from './components/layers/flightLayerUtils';
import OperationsPanel from './components/ui/OperationsPanel';
import StatusBar from './components/ui/StatusBar';
import IntelFeed from './components/ui/IntelFeed';
import AudioToggle from './components/ui/AudioToggle';
import CCTVPanel from './components/ui/CCTVPanel';
import Crosshair from './components/ui/Crosshair';
import TrackedEntityPanel from './components/ui/TrackedEntityPanel';
import FilmGrain from './components/ui/FilmGrain';
import VisualIntelligenceLayer from './components/layers/VisualIntelligenceLayer';
import OntologyWorkbench from './components/ui/OntologyWorkbench';
import { useEarthquakes, type Earthquake } from './hooks/useEarthquakes';
import { useSatellites, type SatellitePosition } from './hooks/useSatellites';
import { useFlights, type Flight } from './hooks/useFlights';
import { useFlightsLive } from './hooks/useFlightsLive';
import { useTraffic } from './hooks/useTraffic';
import { useCameras } from './hooks/useCameras';
import { useShips, type Ship } from './hooks/useShips';
import { useGeolocation } from './hooks/useGeolocation';
import { useIsMobile } from './hooks/useIsMobile';
import { useAudio } from './hooks/useAudio';
import { useVisualIntelligence } from './hooks/useVisualIntelligence';
import { groupController } from './intelligence/groupController';
import type {
  SelectionContext,
  TieredGroupSnapshot,
} from './intelligence/visualIntelligence';
import type { ShaderMode } from './shaders/postprocess';
import type { IntelFeedItem } from './components/ui/IntelFeed';
import type { TrackedEntityInfo } from './types/trackedEntity';
import type { RenderCameraState } from './types/rendering';
import type { OntologyEntity } from './types/ontology';
import {
  isRenderableAltitude,
  isRenderableLatitude,
  isRenderableLongitude,
  normalizeLongitude,
  sanitizeHeading,
  sanitizeNullableNumber,
} from './lib/cesiumSafety';
import { buildRenderBudget, shouldRefreshCameraQuery } from './lib/renderBudget';
import { GridSpatialIndex, deriveRenderPriorityIds, selectPriorityItems } from './lib/renderQuery';
import { useOntologySync } from './ontology/useOntologySync';
import { useOntologyWorkbench } from './ontology/useOntologyWorkbench';
import {
  buildOntologyTrackedEntityInfo,
  getOntologyEntityFocus,
  isOntologyMapRenderable,
  mergeOntologySelectionContext,
} from './ontology/presentation';

interface CameraState {
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  pitch: number;
}

interface RenderEntry<T> {
  id: string;
  latitude: number;
  longitude: number;
  item: T;
}

type AirspaceRangeKm = 80 | 160 | 320 | 640;

interface DesignatableGroup {
  id: string;
  label: string;
  kind: 'MESO' | 'MICRO';
  confidence: number;
  memberCount: number;
  latitude: number;
  longitude: number;
  altitude: number;
  distanceKm: number;
}

const DEFAULT_AIRSPACE_RANGE_KM: AirspaceRangeKm = 160;

const DEFAULT_ALTITUDE_FILTER: Record<AltitudeBand, boolean> = {
  cruise: false,
  high: true,
  mid: true,
  low: true,
  ground: true,
};

const DEFAULT_SATELLITE_FILTER: Record<SatelliteCategory, boolean> = {
  iss: true,
  other: true,
};

const DEFAULT_CAMERA: CameraState = {
  latitude: -33.8688,
  longitude: 151.2093,
  altitude: 20_000_000,
  heading: 0,
  pitch: -90,
};

function toRenderCameraState(camera: CameraState, timestamp = Date.now()): RenderCameraState {
  return {
    ...camera,
    timestamp,
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

function filterTieredGroupsByRange(
  tieredGroups: TieredGroupSnapshot,
  cameraState: RenderCameraState,
  airspaceRangeKm: number,
  pinnedGroupId: string | null,
): TieredGroupSnapshot {
  const inRange = (latitude: number, longitude: number) =>
    haversineKm(cameraState.latitude, cameraState.longitude, latitude, longitude) <= airspaceRangeKm;

  return {
    ...tieredGroups,
    microGroups: tieredGroups.microGroups.filter((group) =>
      group.id === pinnedGroupId || inRange(group.centroid.latitude, group.centroid.longitude),
    ),
    mesoGroups: tieredGroups.mesoGroups.filter((group) =>
      group.id === pinnedGroupId || inRange(group.centroid.latitude, group.centroid.longitude),
    ),
    activityClouds: tieredGroups.activityClouds
      .map((cloud) => ({
        ...cloud,
        cells: cloud.cells.filter((cell) =>
          cloud.id === pinnedGroupId || inRange(cell.latitude, cell.longitude),
        ),
      }))
      .filter((cloud) => cloud.id === pinnedGroupId || cloud.cells.length > 0),
  };
}

function buildDesignatableGroups(
  groups: TieredGroupSnapshot,
  cameraState: RenderCameraState,
): DesignatableGroup[] {
  const micro = groups.microGroups.map((group): DesignatableGroup => ({
    id: group.id,
    label: group.label,
    kind: 'MICRO',
    confidence: group.confidence,
    memberCount: group.memberIds.length,
    latitude: group.centroid.latitude,
    longitude: group.centroid.longitude,
    altitude: group.centroid.altitude,
    distanceKm: haversineKm(cameraState.latitude, cameraState.longitude, group.centroid.latitude, group.centroid.longitude),
  }));
  const meso = groups.mesoGroups.map((group): DesignatableGroup => ({
    id: group.id,
    label: group.label,
    kind: 'MESO',
    confidence: group.confidence,
    memberCount: group.microGroupIds.length,
    latitude: group.centroid.latitude,
    longitude: group.centroid.longitude,
    altitude: group.centroid.altitude,
    distanceKm: haversineKm(cameraState.latitude, cameraState.longitude, group.centroid.latitude, group.centroid.longitude),
  }));

  return [...meso, ...micro]
    .sort((left, right) =>
      right.confidence - left.confidence || left.distanceKm - right.distanceKm,
    )
    .slice(0, 6);
}

function stripSelectionPredictions(
  selectionContext: SelectionContext | null,
  enabled: boolean,
) {
  if (!selectionContext || enabled) {
    return selectionContext;
  }

  return {
    ...selectionContext,
    predictedPaths: [],
    destinationCandidates: [],
  };
}

function findViewerEntity(viewer: CesiumViewer, entityId: string) {
  const rootEntity = viewer.entities.getById(entityId);
  if (rootEntity) {
    return rootEntity;
  }

  for (let index = 0; index < viewer.dataSources.length; index += 1) {
    const entity = viewer.dataSources.get(index)?.entities.getById(entityId);
    if (entity) {
      return entity;
    }
  }

  return null;
}

function getTrackedViewOffset(entityType: TrackedEntityInfo['entityType']) {
  if (entityType === 'satellite') {
    return new Cartesian3(0, -500_000, 500_000);
  }
  if (entityType === 'aircraft') {
    return new Cartesian3(0, -30_000, 30_000);
  }
  if (entityType === 'ship') {
    return new Cartesian3(0, -1_200, 2_100);
  }
  if (entityType === 'facility' || entityType === 'cctv') {
    return new Cartesian3(0, -3_500, 5_500);
  }
  if (entityType === 'earthquake') {
    return new Cartesian3(0, -40_000, 40_000);
  }
  return new Cartesian3(0, -200_000, 200_000);
}

const DEFAULT_LAYERS = {
  flights: false,
  satellites: false,
  earthquakes: false,
  traffic: false,
  cctv: false,
  ships: false,
};

const RECOVERY_LAYERS = {
  flights: false,
  satellites: false,
  earthquakes: false,
  traffic: false,
  cctv: false,
  ships: false,
};

function sanitizeFlight(flight: Flight): Flight | null {
  if (
    !isRenderableLatitude(flight.latitude) ||
    !isRenderableLongitude(flight.longitude) ||
    !isRenderableAltitude(flight.altitude, { min: 0, max: 100_000 })
  ) {
    return null;
  }

  return {
    ...flight,
    longitude: normalizeLongitude(flight.longitude),
    altitudeFeet: isRenderableAltitude(flight.altitudeFeet, { min: 0, max: 350_000 }) ? flight.altitudeFeet : 0,
    heading: sanitizeHeading(flight.heading),
    velocity: sanitizeNullableNumber(flight.velocity, { min: 0, max: 20_000 }),
    velocityKnots: sanitizeNullableNumber(flight.velocityKnots, { min: 0, max: 20_000 }),
    verticalRate: sanitizeNullableNumber(flight.verticalRate, { min: -20_000, max: 20_000 }),
  };
}

function sanitizeSatellitePosition(satellite: SatellitePosition): SatellitePosition | null {
  if (
    !isRenderableLatitude(satellite.latitude) ||
    !isRenderableLongitude(satellite.longitude) ||
    !isRenderableAltitude(satellite.altitude, { min: 0, max: 500_000 })
  ) {
    return null;
  }

  return {
    ...satellite,
    longitude: normalizeLongitude(satellite.longitude),
    orbitPath: satellite.orbitPath.filter((point) =>
      isRenderableLatitude(point.latitude) &&
      isRenderableLongitude(point.longitude) &&
      isRenderableAltitude(point.altitude, { min: 0, max: 500_000 }),
    ).map((point) => ({
      latitude: point.latitude,
      longitude: normalizeLongitude(point.longitude),
      altitude: point.altitude,
    })),
  };
}

function sanitizeEarthquake(earthquake: Earthquake): Earthquake | null {
  if (
    !isRenderableLatitude(earthquake.latitude) ||
    !isRenderableLongitude(earthquake.longitude)
  ) {
    return null;
  }

  return {
    ...earthquake,
    longitude: normalizeLongitude(earthquake.longitude),
    mag: sanitizeNullableNumber(earthquake.mag, { min: -5, max: 15 }) ?? 0,
    depth: sanitizeNullableNumber(earthquake.depth, { min: -20, max: 1_000 }) ?? 0,
  };
}

function sanitizeCamera(camera: CameraFeed): CameraFeed | null {
  if (
    !isRenderableLatitude(camera.latitude) ||
    !isRenderableLongitude(camera.longitude)
  ) {
    return null;
  }

  return {
    ...camera,
    longitude: normalizeLongitude(camera.longitude),
  };
}

function sanitizeShip(ship: Ship): Ship | null {
  if (
    !isRenderableLatitude(ship.latitude) ||
    !isRenderableLongitude(ship.longitude)
  ) {
    return null;
  }

  return {
    ...ship,
    longitude: normalizeLongitude(ship.longitude),
    heading: sanitizeHeading(ship.heading),
    cog: sanitizeHeading(ship.cog),
    sog: sanitizeNullableNumber(ship.sog, { min: 0, max: 200 }) ?? 0,
  };
}

function compactSanitized<T>(items: T[], sanitizer: (item: T) => T | null): T[] {
  const safeItems: T[] = [];

  for (const item of items) {
    const safeItem = sanitizer(item);
    if (safeItem) {
      safeItems.push(safeItem);
    }
  }

  return safeItems;
}

/**
 * Convert a viewDirection compass string (e.g. "East", "N-W") to heading
 * degrees clockwise from North.  Returns null if the string is absent or
 * unrecognised.
 */
function parseViewDirection(dir?: string): number | null {
  if (!dir) return null;
  const normalised = dir.trim().toUpperCase().replace(/\s+/g, '');
  const map: Record<string, number> = {
    N: 0, NORTH: 0,
    NE: 45, 'N-E': 45, NORTHEAST: 45, 'NORTH-EAST': 45,
    E: 90, EAST: 90,
    SE: 135, 'S-E': 135, SOUTHEAST: 135, 'SOUTH-EAST': 135,
    S: 180, SOUTH: 180,
    SW: 225, 'S-W': 225, SOUTHWEST: 225, 'SOUTH-WEST': 225,
    W: 270, WEST: 270,
    NW: 315, 'N-W': 315, NORTHWEST: 315, 'NORTH-WEST': 315,
  };
  return map[normalised] ?? null;
}

function App() {
  // Responsive breakpoint
  const isMobile = useIsMobile();

  // Audio engine
  const audio = useAudio();

  // Viewer ref for reset-view functionality
  const viewerRef = useRef<CesiumViewer | null>(null);

  const [globeInstanceKey, setGlobeInstanceKey] = useState(0);
  const [renderRecoveryNotice, setRenderRecoveryNotice] = useState<string | null>(null);

  // State: shader mode
  const [shaderMode, setShaderMode] = useState<ShaderMode>('none');

  // State: map tiles (google 3D vs OSM for testing)
  const [mapTiles, setMapTiles] = useState<'google' | 'osm'>('osm');

  // State: data layer visibility
  const [layers, setLayers] = useState(DEFAULT_LAYERS);

  // State: CCTV country filter
  const [cctvCountryFilter, setCctvCountryFilter] = useState('ALL');
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);

  // State: flight sub-toggles
  const [showPaths, setShowPaths] = useState(false);
  const [showPredictions, setShowPredictions] = useState(true);
  const [airspaceRangeKm, setAirspaceRangeKm] = useState<AirspaceRangeKm>(DEFAULT_AIRSPACE_RANGE_KM);
  const [altitudeFilter, setAltitudeFilter] = useState<Record<AltitudeBand, boolean>>(DEFAULT_ALTITUDE_FILTER);

  // State: satellite sub-toggles
  const [showSatPaths, setShowSatPaths] = useState(false);
  const [satCategoryFilter, setSatCategoryFilter] = useState<Record<SatelliteCategory, boolean>>(DEFAULT_SATELLITE_FILTER);

  // State: camera position
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [renderCamera, setRenderCamera] = useState<RenderCameraState>(() => toRenderCameraState(DEFAULT_CAMERA));
  const [queryCamera, setQueryCamera] = useState<RenderCameraState>(() => toRenderCameraState(DEFAULT_CAMERA));
  const latestCameraRef = useRef<RenderCameraState>(toRenderCameraState(DEFAULT_CAMERA));
  const lastQueryCameraRef = useRef<RenderCameraState>(toRenderCameraState(DEFAULT_CAMERA));
  const renderCameraFlushTimerRef = useRef<number | null>(null);
  const statusCameraFlushTimerRef = useRef<number | null>(null);

  // State: tracked entity (lock view)
  const [trackedEntity, setTrackedEntity] = useState<TrackedEntityInfo | null>(null);
  const cctvTrackEntityRef = useRef<CesiumEntity | null>(null);
  const ontologyTrackEntityRef = useRef<CesiumEntity | null>(null);
  const ontologyTrackSourceIdRef = useRef<string | null>(null);

  /** Remove the temporary Cesium Entity used for CCTV lock-on */
  const cleanupCctvEntity = useCallback(() => {
    if (cctvTrackEntityRef.current) {
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) {
        viewer.entities.remove(cctvTrackEntityRef.current);
      }
      cctvTrackEntityRef.current = null;
    }
  }, []);

  const cleanupOntologyTrackEntity = useCallback(() => {
    if (ontologyTrackEntityRef.current) {
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) {
        viewer.entities.remove(ontologyTrackEntityRef.current);
      }
      ontologyTrackEntityRef.current = null;
      ontologyTrackSourceIdRef.current = null;
    }
  }, []);

  const handleTrackEntity = useCallback((info: TrackedEntityInfo | null) => {
    setTrackedEntity(info);
    // When tracking something else or clearing, clean up CCTV entity
    if (!info || info.entityType !== 'cctv') {
      cleanupCctvEntity();
    }
    if (!info || info.id !== ontologyTrackSourceIdRef.current) {
      cleanupOntologyTrackEntity();
    }
  }, [cleanupCctvEntity, cleanupOntologyTrackEntity]);

  const handleViewerReady = useCallback((viewer: CesiumViewer) => {
    viewerRef.current = viewer;
    setRenderRecoveryNotice(null);
  }, []);

  const handleRenderFailure = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TAC_VIEW] Resetting viewer in safe mode after render failure:', error);

    setTrackedEntity(null);
    setSelectedCameraId(null);
    cleanupCctvEntity();
    cleanupOntologyTrackEntity();
    setShaderMode('none');
    setMapTiles('osm');
    setLayers(RECOVERY_LAYERS);
    setRenderRecoveryNotice(`SAFE STARTUP MODE ACTIVE: ${message}`);
    setGlobeInstanceKey((value) => value + 1);
  }, [cleanupCctvEntity, cleanupOntologyTrackEntity]);

  const handleUnlockTrackedEntity = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed()) {
      viewer.trackedEntity = undefined;
      viewer.selectedEntity = undefined;
    }
    setTrackedEntity(null);
    cleanupCctvEntity();
    cleanupOntologyTrackEntity();
  }, [cleanupCctvEntity, cleanupOntologyTrackEntity]);

  const handleDesignateGroup = useCallback((group: DesignatableGroup) => {
    const viewer = viewerRef.current;
    const nextTrackedEntity: TrackedEntityInfo = {
      id: group.id,
      name: group.label,
      entityType: 'group',
      description: [
        `<p><b>Group:</b> ${group.label}</p>`,
        `<p><b>Type:</b> ${group.kind}</p>`,
        `<p><b>Members:</b> ${group.memberCount}</p>`,
        `<p><b>Confidence:</b> ${(group.confidence * 100).toFixed(0)}%</p>`,
      ].join(''),
    };

    cleanupCctvEntity();
    setTrackedEntity(nextTrackedEntity);

    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const targetEntity = findViewerEntity(viewer, group.id);
    if (targetEntity) {
      targetEntity.viewFrom = new ConstantProperty(new Cartesian3(0, -160_000, 160_000)) as unknown as never;
      viewer.selectedEntity = targetEntity;
      viewer.trackedEntity = targetEntity;
      return;
    }

    viewer.trackedEntity = undefined;
    viewer.selectedEntity = undefined;
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        group.longitude,
        group.latitude,
        Math.max(220_000, group.altitude + 120_000),
      ),
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-70),
        roll: 0,
      },
      duration: 1.8,
    });
  }, [cleanupCctvEntity]);

  useEffect(() => {
    return () => {
      if (renderCameraFlushTimerRef.current !== null) {
        window.clearTimeout(renderCameraFlushTimerRef.current);
      }
      if (statusCameraFlushTimerRef.current !== null) {
        window.clearTimeout(statusCameraFlushTimerRef.current);
      }
    };
  }, []);

  const handleResetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.trackedEntity = undefined;
    setTrackedEntity(null);
    cleanupCctvEntity();
    cleanupOntologyTrackEntity();
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(151.2093, -33.8688, 20_000_000),
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
      duration: 2,
    });
  }, [cleanupCctvEntity, cleanupOntologyTrackEntity]);

  const renderBudget = useMemo(
    () => buildRenderBudget(renderCamera, Boolean(trackedEntity)),
    [renderCamera, trackedEntity],
  );

  // Data hooks
  const { earthquakes: rawEarthquakes, feedItems: eqFeedItems } = useEarthquakes(layers.earthquakes);
  const { satellites: rawSatellites, feedItems: satFeedItems } = useSatellites(layers.satellites);
  const { flights: flightsGlobal, feedItems: fltFeedItems } = useFlights(layers.flights);
  const { flightsLive } = useFlightsLive(
    layers.flights,
    queryCamera.latitude,
    queryCamera.longitude,
    queryCamera.altitude,
    !!trackedEntity,
  );
  const { roads: trafficRoads, vehicles: trafficVehicles, loading: trafficLoading } = useTraffic(
    layers.traffic,
    queryCamera.latitude,
    queryCamera.longitude,
    queryCamera.altitude,
    renderBudget.trafficReactUpdateMs,
  );
  const { ships: rawShips, feedItems: shipFeedItems, isLoading: shipsLoading } = useShips(layers.ships);
  const {
    cameras: rawCctvCameras,
    feedItems: cctvFeedItems,
    isLoading: cctvLoading,
    error: cctvError,
    totalOnline: cctvOnline,
    totalCameras: cctvTotal,
    availableCountries: cctvCountries,
  } = useCameras(layers.cctv, cctvCountryFilter);

  // Geolocation hook — browser GPS (consent) + IP fallback
  const { location: geoLocation, status: geoStatus, locate: geoLocate } = useGeolocation();

  // Fly to user's location when geolocation succeeds
  useEffect(() => {
    if (!geoLocation || geoStatus !== 'success') return;
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    // Choose altitude based on precision: GPS → street level, IP → city level
    const flyAltitude = geoLocation.source === 'gps' ? 5_000 : 200_000;

    viewer.trackedEntity = undefined;
    const clearTrackingFrame = window.requestAnimationFrame(() => {
      setTrackedEntity(null);
    });
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        geoLocation.longitude,
        geoLocation.latitude,
        flyAltitude,
      ),
      orientation: {
        heading: CesiumMath.toRadians(0),
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
      duration: 2.5,
    });
    return () => window.cancelAnimationFrame(clearTrackingFrame);
  }, [geoLocation, geoStatus]);

  // Smart layer swap: live (adsb.fi 5s) replaces global (FR24 30s) for matching aircraft.
  // Global aircraft outside the live region remain visible. Zero duplicates guaranteed.
  const rawFlights = useMemo(() => {
    if (flightsLive.length === 0) return flightsGlobal;
    if (flightsGlobal.length === 0) return flightsLive;

    // Set of icao24s in the live feed — these are EXCLUDED from global to prevent duplicates
    const liveIcaos = new Set(flightsLive.map((f) => f.icao24));

    // Global flights NOT covered by live feed (outside the adsb.fi 250nm region)
    const globalOnly = flightsGlobal.filter((f) => !liveIcaos.has(f.icao24));

    // Enrich live flights with FR24 route info where the live data is missing it
    const routeMap = new Map<string, { originAirport: string; destAirport: string; airline: string }>();
    for (const f of flightsGlobal) {
      if (f.originAirport || f.destAirport) {
        routeMap.set(f.icao24, {
          originAirport: f.originAirport,
          destAirport: f.destAirport,
          airline: f.airline,
        });
      }
    }
    const enrichedLive = flightsLive.map((f) => {
      const route = routeMap.get(f.icao24);
      if (route) {
        return {
          ...f,
          originAirport: f.originAirport || route.originAirport,
          destAirport: f.destAirport || route.destAirport,
          airline: f.airline || route.airline,
        };
      }
      return f;
    });

    return [...globalOnly, ...enrichedLive];
  }, [flightsGlobal, flightsLive]);

  const flights = useMemo(() => compactSanitized(rawFlights, sanitizeFlight), [rawFlights]);
  const satellites = useMemo(() => compactSanitized(rawSatellites, sanitizeSatellitePosition), [rawSatellites]);
  const earthquakes = useMemo(() => compactSanitized(rawEarthquakes, sanitizeEarthquake), [rawEarthquakes]);
  const cctvCameras = useMemo(() => compactSanitized(rawCctvCameras, sanitizeCamera), [rawCctvCameras]);
  const ships = useMemo(() => compactSanitized(rawShips, sanitizeShip), [rawShips]);
  const ontologyWorkbench = useOntologyWorkbench(renderCamera, trackedEntity?.id ?? null);
  const setOntologySelectedEntityId = ontologyWorkbench.setSelectedEntityId;

  useOntologySync({
    flights,
    ships,
    satellites,
    cameras: cctvCameras,
    earthquakes,
    roads: trafficRoads,
  });

  const ontologyRenderableEntities = useMemo(
    () => ontologyWorkbench.mapEntities.filter(isOntologyMapRenderable),
    [ontologyWorkbench.mapEntities],
  );

  useEffect(() => {
    groupController.pushSources({
      flights,
      ships,
      satellites,
      cameras: cctvCameras,
    });
  }, [cctvCameras, flights, satellites, ships]);

  useEffect(() => {
    groupController.setSelection(trackedEntity);
  }, [trackedEntity]);

  useEffect(() => {
    if (trackedEntity?.id) {
      setOntologySelectedEntityId(trackedEntity.id);
    }
  }, [setOntologySelectedEntityId, trackedEntity?.id]);

  useEffect(() => {
    groupController.setCameraState(renderCamera);
  }, [renderCamera]);

  const visualIntelligence = useVisualIntelligence();
  const pinnedGroupId = trackedEntity?.entityType === 'group' ? trackedEntity.id : null;
  const visibleTieredGroups = useMemo(
    () => filterTieredGroupsByRange(visualIntelligence.tieredGroups, renderCamera, airspaceRangeKm, pinnedGroupId),
    [airspaceRangeKm, pinnedGroupId, renderCamera, visualIntelligence.tieredGroups],
  );
  const visibleSelectionContext = useMemo(
    () => mergeOntologySelectionContext(
      stripSelectionPredictions(visualIntelligence.selectionContext, showPredictions),
      trackedEntity,
      ontologyWorkbench.trackedEntityDetail,
    ),
    [ontologyWorkbench.trackedEntityDetail, showPredictions, trackedEntity, visualIntelligence.selectionContext],
  );
  const designatableGroups = useMemo(
    () => buildDesignatableGroups(visibleTieredGroups, renderCamera),
    [renderCamera, visibleTieredGroups],
  );

  const flightEntries = useMemo<RenderEntry<Flight>[]>(
    () => flights.map((flight) => ({
      id: `flight-${flight.icao24}`,
      latitude: flight.latitude,
      longitude: flight.longitude,
      item: flight,
    })),
    [flights],
  );
  const flightIndex = useMemo(() => new GridSpatialIndex(flightEntries, 4), [flightEntries]);

  const satelliteEntries = useMemo<RenderEntry<SatellitePosition>[]>(
    () => satellites.map((satellite) => ({
      id: `sat-${satellite.noradId}`,
      latitude: satellite.latitude,
      longitude: satellite.longitude,
      item: satellite,
    })),
    [satellites],
  );
  const satelliteIndex = useMemo(() => new GridSpatialIndex(satelliteEntries, 6), [satelliteEntries]);

  const earthquakeEntries = useMemo<RenderEntry<Earthquake>[]>(
    () => earthquakes.map((earthquake) => ({
      id: `eq-${earthquake.id}`,
      latitude: earthquake.latitude,
      longitude: earthquake.longitude,
      item: earthquake,
    })),
    [earthquakes],
  );
  const earthquakeIndex = useMemo(() => new GridSpatialIndex(earthquakeEntries, 5), [earthquakeEntries]);

  const cameraEntries = useMemo<RenderEntry<CameraFeed>[]>(
    () => cctvCameras.map((cctvCamera) => ({
      id: cctvCamera.id,
      latitude: cctvCamera.latitude,
      longitude: cctvCamera.longitude,
      item: cctvCamera,
    })),
    [cctvCameras],
  );
  const cameraIndex = useMemo(() => new GridSpatialIndex(cameraEntries, 2), [cameraEntries]);

  const shipEntries = useMemo<RenderEntry<Ship>[]>(
    () => ships.map((ship) => ({
      id: `ship-${ship.mmsi}`,
      latitude: ship.latitude,
      longitude: ship.longitude,
      item: ship,
    })),
    [ships],
  );
  const shipIndex = useMemo(() => new GridSpatialIndex(shipEntries, 4), [shipEntries]);

  const selectionPriorityIds = useMemo(
    () => deriveRenderPriorityIds(visibleSelectionContext),
    [visibleSelectionContext],
  );

  const globeFlights = useMemo(
    () => selectPriorityItems(flightEntries, {
      budget: renderBudget.flights,
      camera: renderCamera,
      trackedId: trackedEntity?.id,
      priorityIds: selectionPriorityIds,
      index: flightIndex,
    }).map((entry) => entry.item),
    [flightEntries, flightIndex, renderBudget.flights, renderCamera, selectionPriorityIds, trackedEntity?.id],
  );

  const globeSatellites = useMemo(
    () => selectPriorityItems(satelliteEntries, {
      budget: renderBudget.satellites,
      camera: renderCamera,
      trackedId: trackedEntity?.id,
      priorityIds: selectionPriorityIds,
      index: satelliteIndex,
    }).map((entry) => entry.item),
    [renderBudget.satellites, renderCamera, satelliteEntries, satelliteIndex, selectionPriorityIds, trackedEntity?.id],
  );

  const globeEarthquakes = useMemo(
    () => selectPriorityItems(earthquakeEntries, {
      budget: renderBudget.earthquakes,
      camera: renderCamera,
      trackedId: trackedEntity?.id,
      priorityIds: selectionPriorityIds,
      index: earthquakeIndex,
    }).map((entry) => entry.item),
    [earthquakeEntries, earthquakeIndex, renderBudget.earthquakes, renderCamera, selectionPriorityIds, trackedEntity?.id],
  );

  const cctvPriorityIds = useMemo(() => {
    const ids = new Set(selectionPriorityIds);
    if (selectedCameraId) {
      ids.add(selectedCameraId);
    }
    if (trackedEntity?.entityType === 'cctv' && trackedEntity.id.startsWith('cctv-')) {
      ids.add(trackedEntity.id.slice(5));
    }
    return ids;
  }, [selectedCameraId, selectionPriorityIds, trackedEntity]);

  const globeCameras = useMemo(
    () => layers.cctv
      ? selectPriorityItems(cameraEntries, {
        budget: renderBudget.cctv,
        camera: renderCamera,
        selectedId: selectedCameraId,
        priorityIds: cctvPriorityIds,
        index: cameraIndex,
      }).map((entry) => entry.item)
      : [],
    [cameraEntries, cameraIndex, cctvPriorityIds, layers.cctv, renderBudget.cctv, renderCamera, selectedCameraId],
  );

  const globeShips = useMemo(
    () => selectPriorityItems(shipEntries, {
      budget: renderBudget.ships,
      camera: renderCamera,
      trackedId: trackedEntity?.id,
      priorityIds: selectionPriorityIds,
      index: shipIndex,
    }).map((entry) => entry.item),
    [renderBudget.ships, renderCamera, selectionPriorityIds, shipEntries, shipIndex, trackedEntity?.id],
  );

  // Combine intel feed items
  const allFeedItems: IntelFeedItem[] = useMemo(
    () => [
      ...fltFeedItems,
      ...satFeedItems,
      ...eqFeedItems,
      ...cctvFeedItems,
      ...shipFeedItems,
      ...visualIntelligence.feedItems,
    ],
    [cctvFeedItems, eqFeedItems, fltFeedItems, satFeedItems, shipFeedItems, visualIntelligence.feedItems],
  );

  // Handlers
  const handleCameraChange = useCallback(
    (lat: number, lon: number, alt: number, heading: number, pitch: number) => {
      const nextCamera = {
        latitude: lat,
        longitude: lon,
        altitude: alt,
        heading,
        pitch,
        timestamp: Date.now(),
      };
      latestCameraRef.current = nextCamera;

      if (shouldRefreshCameraQuery(lastQueryCameraRef.current, nextCamera)) {
        lastQueryCameraRef.current = nextCamera;
        setQueryCamera(nextCamera);
      }

      if (renderCameraFlushTimerRef.current === null) {
        renderCameraFlushTimerRef.current = window.setTimeout(() => {
          renderCameraFlushTimerRef.current = null;
          setRenderCamera(latestCameraRef.current);
        }, 80);
      }

      if (statusCameraFlushTimerRef.current === null) {
        statusCameraFlushTimerRef.current = window.setTimeout(() => {
          statusCameraFlushTimerRef.current = null;
          setCamera({
            latitude: latestCameraRef.current.latitude,
            longitude: latestCameraRef.current.longitude,
            altitude: latestCameraRef.current.altitude,
            heading: latestCameraRef.current.heading,
            pitch: latestCameraRef.current.pitch,
          });
        }, 250);
      }
    },
    [],
  );

  const handleCameraMoveEnd = useCallback(
    (lat: number, lon: number, alt: number, heading: number, pitch: number) => {
      const nextCamera = {
        latitude: lat,
        longitude: lon,
        altitude: alt,
        heading,
        pitch,
        timestamp: Date.now(),
      };
      latestCameraRef.current = nextCamera;
      lastQueryCameraRef.current = nextCamera;

      if (renderCameraFlushTimerRef.current !== null) {
        window.clearTimeout(renderCameraFlushTimerRef.current);
        renderCameraFlushTimerRef.current = null;
      }
      if (statusCameraFlushTimerRef.current !== null) {
        window.clearTimeout(statusCameraFlushTimerRef.current);
        statusCameraFlushTimerRef.current = null;
      }

      setRenderCamera(nextCamera);
      setQueryCamera(nextCamera);
      setCamera({
        latitude: lat,
        longitude: lon,
        altitude: alt,
        heading,
        pitch,
      });
    },
    [],
  );

  const handleLayerToggle = useCallback((layer: 'flights' | 'satellites' | 'earthquakes' | 'traffic' | 'cctv' | 'ships') => {
    setLayers((prev) => {
      const next = !prev[layer];
      audio.play(next ? 'toggleOn' : 'toggleOff');
      return { ...prev, [layer]: next };
    });
  }, [audio]);

  /** Select a camera in the panel (shows feed preview, no fly) */
  const handleSelectCamera = useCallback((cam: CameraFeed | null) => {
    setSelectedCameraId(cam ? cam.id : null);
  }, []);

  /** Lock-on to a CCTV camera: select, create entity, set trackedEntity */
  const handleCctvLockOn = useCallback((cam: CameraFeed) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    setSelectedCameraId(cam.id);

    // Clean up any previous CCTV tracking entity
    cleanupCctvEntity();

    // Create a temporary Cesium Entity at the camera position for lock-on
    const entity = viewer.entities.add({
      id: `cctv-${cam.id}`,
      position: Cartesian3.fromDegrees(cam.longitude, cam.latitude, 0),
      name: cam.name,
      description: [
        `<b>Source:</b> ${cam.source.toUpperCase()}`,
        `<b>Country:</b> ${cam.countryName}`,
        `<b>Region:</b> ${cam.region || 'N/A'}`,
        `<b>Status:</b> ${cam.available ? 'ONLINE' : 'OFFLINE'}`,
        `<b>Coords:</b> ${cam.latitude.toFixed(4)}°, ${cam.longitude.toFixed(4)}°`,
      ].join('<br/>'),
    });

    // Street-level viewFrom: close-in with optional heading match
    // viewFrom is in the entity's local ENU frame (x=East, y=North, z=Up)
    const ALT = 300;  // metres above ground
    const DEFAULT_HDG = 160; // degrees — default viewing heading when camera has none
    const DIST = 200; // metres behind the look-point
    const headingDeg = parseViewDirection(cam.viewDirection) ?? DEFAULT_HDG;
    const hRad = CesiumMath.toRadians(headingDeg);
    entity.viewFrom = new ConstantProperty(new Cartesian3(
      -DIST * Math.sin(hRad), // east component (negative = behind heading)
      -DIST * Math.cos(hRad), // north component
      ALT,
    )) as unknown as never;

    cctvTrackEntityRef.current = entity;

    // Lock on — Cesium flies to and centres the entity
    viewer.trackedEntity = entity;

    // Set React tracked-entity state for the tracking panel UI
    setTrackedEntity({
      id: `cctv-${cam.id}`,
      name: cam.name,
      entityType: 'cctv',
      description: [
        `<b>Source:</b> ${cam.source.toUpperCase()}`,
        `<b>Country:</b> ${cam.countryName}`,
        `<b>Region:</b> ${cam.region || 'N/A'}`,
        `<b>Status:</b> ${cam.available ? 'ONLINE' : 'OFFLINE'}`,
      ].join('<br/>'),
    });
  }, [cleanupCctvEntity]);

  /** Handle FLY TO from CCTVPanel — locks on (same as globe click) */
  const handleFlyToCamera = useCallback((cam: CameraFeed) => {
    handleCctvLockOn(cam);
  }, [handleCctvLockOn]);

  /** Handle CCTV billboard click on the globe (from EntityClickHandler) */
  const handleCctvClickOnGlobe = useCallback((camData: CameraFeed) => {
    handleCctvLockOn(camData);
  }, [handleCctvLockOn]);

  const handleTrackOntologyEntity = useCallback((entity: OntologyEntity) => {
    const viewer = viewerRef.current;
    const nextTrackedEntity = buildOntologyTrackedEntityInfo(entity);
    const focus = getOntologyEntityFocus(entity);

    setTrackedEntity(nextTrackedEntity);
    setOntologySelectedEntityId(entity.id);
    cleanupCctvEntity();
    cleanupOntologyTrackEntity();

    if (nextTrackedEntity.entityType === 'cctv' && entity.id.startsWith('cctv-')) {
      setSelectedCameraId(entity.id.slice(5));
    }

    if (!viewer || viewer.isDestroyed() || !focus) {
      return;
    }

    const existing = findViewerEntity(viewer, entity.id);
    if (existing) {
      existing.viewFrom = new ConstantProperty(getTrackedViewOffset(nextTrackedEntity.entityType)) as unknown as never;
      viewer.selectedEntity = existing;
      viewer.trackedEntity = existing;
      return;
    }

    const proxy = viewer.entities.add({
      id: `track-proxy-${entity.id}`,
      name: entity.label,
      position: Cartesian3.fromDegrees(focus.longitude, focus.latitude, Math.max(0, focus.altitude)),
      description: nextTrackedEntity.description,
      point: {
        pixelSize: 1,
        color: Color.TRANSPARENT,
      },
    });
    proxy.viewFrom = new ConstantProperty(getTrackedViewOffset(nextTrackedEntity.entityType)) as unknown as never;
    ontologyTrackEntityRef.current = proxy;
    ontologyTrackSourceIdRef.current = entity.id;
    viewer.selectedEntity = proxy;
    viewer.trackedEntity = proxy;
  }, [cleanupCctvEntity, cleanupOntologyTrackEntity, setOntologySelectedEntityId]);

  const handleAltitudeToggle = useCallback((band: AltitudeBand) => {
    audio.play('click');
    setAltitudeFilter((prev) => ({ ...prev, [band]: !prev[band] }));
  }, [audio]);

  const handleSatCategoryToggle = useCallback((category: SatelliteCategory) => {
    audio.play('click');
    setSatCategoryFilter((prev) => ({ ...prev, [category]: !prev[category] }));
  }, [audio]);

  // Stable altitude filter ref to avoid unnecessary re-renders
  const opticsOverlayEnabled = shaderMode !== 'none';

  return (
    <div data-testid="app-root" className={`w-screen h-screen bg-wv-black overflow-hidden ${opticsOverlayEnabled ? 'scanline-overlay' : ''}`}>
      {opticsOverlayEnabled && <FilmGrain opacity={0.06} />}
      {/* 3D Globe (fills entire viewport) */}
      <GlobeViewer
        key={globeInstanceKey}
        shaderMode={shaderMode}
        mapTiles={mapTiles}
        onCameraChange={handleCameraChange}
        onCameraMoveEnd={handleCameraMoveEnd}
        onTrackEntity={handleTrackEntity}
        onViewerReady={handleViewerReady}
        onRenderFailure={handleRenderFailure}
        onCctvClick={handleCctvClickOnGlobe}
      >
        <EarthquakeLayer earthquakes={globeEarthquakes} visible={layers.earthquakes} isTracking={!!trackedEntity} />
        <SatelliteLayer satellites={globeSatellites} visible={layers.satellites} showPaths={showSatPaths} categoryFilter={satCategoryFilter} isTracking={!!trackedEntity} />
        <FlightLayer
          airspaceRangeKm={airspaceRangeKm}
          flights={globeFlights}
          visible={layers.flights}
          showPaths={showPaths}
          showPredictions={showPredictions}
          altitudeFilter={altitudeFilter}
          isTracking={!!trackedEntity}
        />
        <TrafficLayer
          roads={trafficRoads}
          vehicles={trafficVehicles}
          visible={layers.traffic}
          showRoads={true}
          showVehicles={true}
          congestionMode={false}
        />
        <OntologyLayer
          entities={ontologyRenderableEntities}
          visible={ontologyWorkbench.activeLayerIds.length > 0}
        />
        <CCTVLayer
          cameras={globeCameras}
          visible={layers.cctv}
          selectedCameraId={selectedCameraId}
        />
        <ShipLayer
          ships={globeShips}
          visible={layers.ships}
          isTracking={!!trackedEntity}
        />
        <VisualIntelligenceLayer
          tieredGroups={visibleTieredGroups}
          selectionContext={visibleSelectionContext}
          cameraAltitude={renderCamera.altitude}
        />
      </GlobeViewer>

      {renderRecoveryNotice && (
        <div className="absolute top-4 left-1/2 z-50 -translate-x-1/2 rounded border border-red-500/60 bg-black/85 px-4 py-2 text-xs tracking-[0.2em] text-red-300">
          {renderRecoveryNotice}
        </div>
      )}

      {/* Tactical UI Overlay */}
      <Crosshair />
      <TrackedEntityPanel
        trackedEntity={trackedEntity}
        ontologyEntity={ontologyWorkbench.trackedEntityDetail}
        onUnlock={handleUnlockTrackedEntity}
        isMobile={isMobile}
      />
      <OntologyWorkbench
        isMobile={isMobile}
        layers={ontologyWorkbench.layers}
        activeLayerIds={ontologyWorkbench.activeLayerIds}
        onToggleLayer={(layerId) => {
          audio.play('click');
          ontologyWorkbench.setActiveLayerIds((current) =>
            current.includes(layerId)
              ? current.filter((candidate) => candidate !== layerId)
              : [...current, layerId],
          );
        }}
        filters={ontologyWorkbench.filters}
        onFiltersChange={ontologyWorkbench.setFilters}
        searchQuery={ontologyWorkbench.searchQuery}
        onSearchQueryChange={ontologyWorkbench.setSearchQuery}
        searchResults={ontologyWorkbench.searchResults}
        selectedEntity={ontologyWorkbench.selectedEntity}
        selectedEvidence={ontologyWorkbench.selectedEvidence}
        onSelectEntity={ontologyWorkbench.setSelectedEntityId}
        onTrackEntity={handleTrackOntologyEntity}
        presets={ontologyWorkbench.presets}
        onApplyPreset={ontologyWorkbench.applyPreset}
        onSavePreset={async (name, description) => {
          await ontologyWorkbench.saveCurrentPreset(name, description);
        }}
        loadingLayers={ontologyWorkbench.loadingLayers}
        loadingSelected={ontologyWorkbench.loadingSelected}
      />
      <OperationsPanel
        shaderMode={shaderMode}
        onShaderChange={(mode) => { audio.play('shaderSwitch'); setShaderMode(mode); }}
        layers={layers}
        layerLoading={{ ships: shipsLoading, traffic: trafficLoading }}
        onLayerToggle={handleLayerToggle}
        mapTiles={mapTiles}
        onMapTilesChange={(t) => { audio.play('click'); setMapTiles(t); }}
        showPaths={showPaths}
        onShowPathsToggle={() => { audio.play('click'); setShowPaths((p) => !p); }}
        showPredictions={showPredictions}
        onShowPredictionsToggle={() => { audio.play('click'); setShowPredictions((value) => !value); }}
        airspaceRangeKm={airspaceRangeKm}
        onAirspaceRangeChange={(range) => { audio.play('click'); setAirspaceRangeKm(range); }}
        altitudeFilter={altitudeFilter}
        onAltitudeToggle={handleAltitudeToggle}
        showSatPaths={showSatPaths}
        onShowSatPathsToggle={() => { audio.play('click'); setShowSatPaths((p) => !p); }}
        satCategoryFilter={satCategoryFilter}
        onSatCategoryToggle={handleSatCategoryToggle}
        designatableGroups={designatableGroups}
        selectedGroupId={trackedEntity?.entityType === 'group' ? trackedEntity.id : null}
        onGroupDesignate={(group) => { audio.play('click'); handleDesignateGroup(group); }}
        onResetView={() => { audio.play('click'); handleResetView(); }}
        onLocateMe={() => { audio.play('click'); geoLocate(); }}
        geoStatus={geoStatus}
        isMobile={isMobile}
      />
      <IntelFeed items={allFeedItems} isMobile={isMobile} />
      {layers.cctv && (
        <CCTVPanel
          cameras={cctvCameras}
          isLoading={cctvLoading}
          error={cctvError}
          totalOnline={cctvOnline}
          totalCameras={cctvTotal}
          availableCountries={cctvCountries}
          countryFilter={cctvCountryFilter}
          selectedCameraId={selectedCameraId}
          onCountryFilterChange={setCctvCountryFilter}
          onSelectCamera={handleSelectCamera}
          onFlyToCamera={handleFlyToCamera}
          isMobile={isMobile}
        />
      )}
      <StatusBar
        camera={camera}
        shaderMode={shaderMode}
        isMobile={isMobile}
        dataStatus={{
          flights: flights.length,
          satellites: satellites.length,
          earthquakes: earthquakes.length,
          cctv: cctvTotal,
          ships: ships.length,
          traffic: trafficRoads.length,
          ontology: ontologyWorkbench.mapEntities.length,
        }}
      />
      <AudioToggle muted={audio.muted} onToggle={audio.toggleMute} isMobile={isMobile} />
    </div>
  );
}

export default App;
