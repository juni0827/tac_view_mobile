import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  Billboard,
  BillboardCollection,
  BlendOption,
  CallbackProperty,
  Cartesian2 as CesiumCartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  DistanceDisplayCondition,
  Ellipsoid,
  Entity as CesiumEntity,
  HorizontalOrigin,
  Label,
  LabelCollection,
  LabelStyle,
  Material,
  Math as CesiumMath,
  NearFarScalar,
  Polyline,
  PolylineCollection,
  VerticalOrigin,
} from 'cesium';
import * as Cesium from 'cesium';
import type { Flight } from '../../hooks/useFlights';
import { getAirportCoords } from '../../data/airports';
import { recordLayerPerformance } from '../../lib/performanceStore';
import { appendFlightTrackSample, buildFlightPathGeometry } from '../../lib/flightPathPredictor';
import {
  isRenderableAltitude,
  isRenderableLatitude,
  isRenderableLongitude,
  normalizeLongitude,
} from '../../lib/cesiumSafety';
import type { AltitudeBand } from './flightLayerUtils';
import { getAltitudeBand } from './flightLayerUtils';

const EllipsoidalOccluder = (Cesium as unknown as {
  EllipsoidalOccluder: new (
    ellipsoid: typeof Ellipsoid.WGS84,
    cameraPosition: Cartesian3,
  ) => { isPointVisible(point: Cartesian3): boolean };
}).EllipsoidalOccluder;

export interface FlightLayerProps {
  airspaceRangeKm: number;
  flights: Flight[];
  visible: boolean;
  showPaths: boolean;
  showPredictions: boolean;
  altitudeFilter: Record<AltitudeBand, boolean>;
  isTracking: boolean;
}

interface FlightState {
  lat: number;
  lon: number;
  alt: number;
  heading: number | null;
  speed: number | null;
  updatedAt: number;
}

interface FlightPrimitiveRefs {
  billboard: Billboard;
  label: Label;
}

interface RoutePrimitiveRefs {
  completed?: Polyline;
  remaining?: Polyline;
}

function createAircraftIcon() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }

  const centerX = size / 2;
  context.fillStyle = '#FFFFFF';
  context.beginPath();
  context.moveTo(centerX, 2);
  context.lineTo(centerX + 3, 10);
  context.lineTo(centerX + 13, 16);
  context.lineTo(centerX + 13, 17);
  context.lineTo(centerX + 3, 14);
  context.lineTo(centerX + 3, 22);
  context.lineTo(centerX + 7, 27);
  context.lineTo(centerX + 7, 28);
  context.lineTo(centerX + 1, 25);
  context.lineTo(centerX, 27);
  context.lineTo(centerX - 1, 25);
  context.lineTo(centerX - 7, 28);
  context.lineTo(centerX - 7, 27);
  context.lineTo(centerX - 3, 22);
  context.lineTo(centerX - 3, 14);
  context.lineTo(centerX - 13, 17);
  context.lineTo(centerX - 13, 16);
  context.lineTo(centerX - 3, 10);
  context.closePath();
  context.fill();

  return canvas;
}

let aircraftIcon: HTMLCanvasElement | null = null;
function getAircraftIcon() {
  if (!aircraftIcon) {
    aircraftIcon = createAircraftIcon();
  }
  return aircraftIcon;
}

function getAltitudeColor(altitudeFeet: number) {
  if (altitudeFeet >= 35_000) return Color.fromCssColorString('#00D4FF');
  if (altitudeFeet >= 20_000) return Color.fromCssColorString('#00BFFF');
  if (altitudeFeet >= 10_000) return Color.fromCssColorString('#FFD700');
  if (altitudeFeet >= 3_000) return Color.fromCssColorString('#FF8C00');
  return Color.fromCssColorString('#FF4444');
}

function getAltitudeScale(altitudeFeet: number) {
  if (altitudeFeet >= 30_000) return 0.45;
  if (altitudeFeet >= 15_000) return 0.38;
  return 0.3;
}

function buildFlightDescription(flight: Flight) {
  return `
    <p><b>Callsign:</b> ${flight.callsign || 'N/A'}</p>
    <p><b>Registration:</b> ${flight.registration || 'N/A'}</p>
    <p><b>Aircraft:</b> ${flight.description || flight.aircraftType || 'Unknown'}</p>
    <p><b>Operator:</b> ${flight.operator || flight.airline || 'N/A'}</p>
    <p><b>Route:</b> ${flight.originAirport || '?'} -> ${flight.destAirport || '?'}</p>
    <p><b>Altitude:</b> ${flight.altitudeFeet.toLocaleString()} ft (${Math.round(flight.altitude).toLocaleString()} m)</p>
    <p><b>Speed:</b> ${flight.velocityKnots ?? 'N/A'} kt</p>
    <p><b>Heading:</b> ${flight.heading != null ? `${Math.round(flight.heading)} deg` : 'N/A'}</p>
    <p><b>Squawk:</b> ${flight.squawk || 'N/A'}</p>
    <p><b>ICAO24:</b> ${flight.icao24}</p>
  `;
}

const ROUTE_COMPLETED_COLOR = Color.fromCssColorString('#00D4FF').withAlpha(0.18);
const ROUTE_REMAINING_COLOR = Color.fromCssColorString('#00D4FF').withAlpha(0.35);
const LABEL_OFFSET = new CesiumCartesian2(10, -4);
const TRAIL_ALPHA = 0.4;
const TRACKED_SCALE = 1.0;

function buildTrailPositions(flight: Flight, position: Cartesian3) {
  if (flight.heading == null || flight.velocityKnots == null || flight.velocityKnots < 50) {
    return null;
  }

  const trailLengthDegrees = 0.15;
  const headingRadians = CesiumMath.toRadians(flight.heading);
  const trailLat = flight.latitude - Math.cos(headingRadians) * trailLengthDegrees;
  const trailLon = normalizeLongitude(flight.longitude - Math.sin(headingRadians) * trailLengthDegrees);

  if (!isRenderableLatitude(trailLat) || !isRenderableLongitude(trailLon)) {
    return null;
  }

  return [
    Cartesian3.fromDegrees(trailLon, trailLat, flight.altitude),
    position,
  ];
}

export default function FlightLayer({
  airspaceRangeKm,
  flights,
  visible,
  showPaths,
  showPredictions,
  altitudeFilter,
  isTracking,
}: FlightLayerProps) {
  const { viewer } = useCesium();
  const entityMapRef = useRef<Map<string, CesiumEntity>>(new Map());
  const positionMapRef = useRef<Map<string, Cartesian3>>(new Map());
  const flightStateRef = useRef<Map<string, FlightState>>(new Map());
  const collectionsRef = useRef<{
    billboards: BillboardCollection;
    labels: LabelCollection;
    trails: PolylineCollection;
    routes: PolylineCollection;
  } | null>(null);
  const primitiveMapRef = useRef<Map<string, FlightPrimitiveRefs>>(new Map());
  const trailMapRef = useRef<Map<string, Polyline>>(new Map());
  const routeMapRef = useRef<Map<string, RoutePrimitiveRefs>>(new Map());
  const historyMapRef = useRef<Map<string, ReturnType<typeof appendFlightTrackSample>>>(new Map());
  const lastOcclusionUpdateRef = useRef(0);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const billboards = new BillboardCollection();
    const labels = new LabelCollection({ blendOption: BlendOption.TRANSLUCENT });
    const trails = new PolylineCollection();
    const routes = new PolylineCollection();

    viewer.scene.primitives.add(billboards);
    viewer.scene.primitives.add(labels);
    viewer.scene.primitives.add(trails);
    viewer.scene.primitives.add(routes);

    collectionsRef.current = { billboards, labels, trails, routes };

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(billboards);
        viewer.scene.primitives.remove(labels);
        viewer.scene.primitives.remove(trails);
        viewer.scene.primitives.remove(routes);
        entityMapRef.current.forEach((entity) => {
          try {
            viewer.entities.remove(entity);
          } catch {
            // Best-effort cleanup.
          }
        });
      }

      collectionsRef.current = null;
      primitiveMapRef.current.clear();
      trailMapRef.current.clear();
      routeMapRef.current.clear();
      entityMapRef.current.clear();
      positionMapRef.current.clear();
      flightStateRef.current.clear();
      historyMapRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!viewer || viewer.isDestroyed() || !collections) {
      return;
    }

    const startedAt = performance.now();

    if (!visible || flights.length === 0) {
      collections.billboards.removeAll();
      collections.labels.removeAll();
      collections.trails.removeAll();
      collections.routes.removeAll();
      primitiveMapRef.current.clear();
      trailMapRef.current.clear();
      routeMapRef.current.clear();
      recordLayerPerformance('flights', {
        updateMs: performance.now() - startedAt,
        primitives: 0,
        visibleCount: 0,
      });
      return;
    }

    const presentIcaos = new Set<string>();
    const renderableFlights: Flight[] = [];

    for (const flight of flights) {
      presentIcaos.add(flight.icao24);

      if (
        !isRenderableLatitude(flight.latitude) ||
        !isRenderableLongitude(flight.longitude) ||
        !isRenderableAltitude(flight.altitude, { min: 0, max: 100_000 })
      ) {
        continue;
      }

      const altitudeBand = getAltitudeBand(flight.altitudeFeet);
      if (!altitudeFilter[altitudeBand]) {
        continue;
      }

      renderableFlights.push(flight);
    }

    const activeIcaos = new Set<string>();
    const now = Date.now();

    for (const flight of renderableFlights) {
      activeIcaos.add(flight.icao24);

      const position = Cartesian3.fromDegrees(normalizeLongitude(flight.longitude), flight.latitude, flight.altitude);
      positionMapRef.current.set(flight.icao24, position);
      flightStateRef.current.set(flight.icao24, {
        lat: flight.latitude,
        lon: flight.longitude,
        alt: flight.altitude,
        heading: flight.heading ?? null,
        speed: flight.velocityKnots ?? null,
        updatedAt: now,
      });
      historyMapRef.current.set(
        flight.icao24,
        appendFlightTrackSample(historyMapRef.current.get(flight.icao24) ?? [], flight, now),
      );

      const color = getAltitudeColor(flight.altitudeFeet);
      const scale = getAltitudeScale(flight.altitudeFeet);
      const rotation = flight.heading != null ? -CesiumMath.toRadians(flight.heading) : 0;
      const callLabel = flight.callsign || flight.registration || flight.icao24;
      const altLabel = flight.altitudeFeet > 0 ? `FL${Math.round(flight.altitudeFeet / 100)}` : 'GND';
      const speedLabel = flight.velocityKnots != null ? `${Math.round(flight.velocityKnots)}kt` : '';
      const typeLabel = flight.aircraftType || '';
      const routeLabel = flight.originAirport && flight.destAirport
        ? `${flight.originAirport}->${flight.destAirport}`
        : '';
      const labelText = `${callLabel} ${altLabel} ${speedLabel} ${typeLabel} ${routeLabel}`.trim();

      let backingEntity = entityMapRef.current.get(flight.icao24);
      if (!backingEntity) {
        const icao = flight.icao24;
        backingEntity = new CesiumEntity({
          id: `flight-${flight.icao24}`,
          name: callLabel,
          position: new CallbackProperty(
            () => positionMapRef.current.get(icao) ?? position,
            false,
          ) as unknown as never,
          description: new ConstantProperty(buildFlightDescription(flight)),
          point: {
            pixelSize: 1,
            color: Color.TRANSPARENT,
          },
        });
        viewer.entities.add(backingEntity);
        entityMapRef.current.set(flight.icao24, backingEntity);
      } else {
        backingEntity.name = callLabel;
        (backingEntity.description as ConstantProperty).setValue(buildFlightDescription(flight));
      }

      const existing = primitiveMapRef.current.get(flight.icao24);
      if (existing) {
        existing.billboard.position = position;
        existing.billboard.color = color;
        existing.billboard.scale = scale;
        existing.billboard.rotation = rotation;
        existing.billboard.id = backingEntity;
        existing.label.position = position;
        existing.label.text = labelText;
        existing.label.fillColor = color.withAlpha(0.85);
        existing.label.id = backingEntity;
      } else {
        const billboard = collections.billboards.add({
          position,
          image: getAircraftIcon(),
          color,
          scale,
          rotation,
          alignedAxis: Cartesian3.UNIT_Z,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e4, 1.5, 5e7, 0.2),
          disableDepthTestDistance: 0,
          id: backingEntity,
        });
        const label = collections.labels.add({
          position,
          text: labelText,
          font: '8px monospace',
          fillColor: color.withAlpha(0.85),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: LABEL_OFFSET,
          scaleByDistance: new NearFarScalar(1e4, 0.8, 3e7, 0),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 8_000_000),
          disableDepthTestDistance: 0,
          id: backingEntity,
        });
        primitiveMapRef.current.set(flight.icao24, { billboard, label });
      }

      const trailPositions = buildTrailPositions(flight, position);
      const trail = trailMapRef.current.get(flight.icao24);
      if (trailPositions) {
        if (trail) {
          trail.positions = trailPositions;
          trail.show = true;
        } else {
          trailMapRef.current.set(
            flight.icao24,
            collections.trails.add({
              positions: trailPositions,
              width: 1.5,
              material: Material.fromType('Color', { color: color.withAlpha(TRAIL_ALPHA) }),
            }),
          );
        }
      } else if (trail) {
        collections.trails.remove(trail);
        trailMapRef.current.delete(flight.icao24);
      }

      const existingRoutes = routeMapRef.current.get(flight.icao24) ?? {};
      if (showPaths) {
        const origin = getAirportCoords(flight.originAirport);
        const destination = getAirportCoords(flight.destAirport);

        const geometry = buildFlightPathGeometry(flight, {
          airspaceRangeKm,
          destination,
          history: historyMapRef.current.get(flight.icao24) ?? [],
          nearbyFlights: renderableFlights,
          origin,
        });
        const completedPositions = geometry.completed.map((point) =>
          Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude),
        );
        const remainingPositions = showPredictions
          ? geometry.remaining.map((point) =>
            Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude),
          )
          : [];

        if (completedPositions.length >= 2) {
          if (existingRoutes.completed) {
            existingRoutes.completed.positions = completedPositions;
            existingRoutes.completed.show = true;
          } else {
            existingRoutes.completed = collections.routes.add({
              positions: completedPositions,
              width: 1,
              material: Material.fromType('Color', { color: ROUTE_COMPLETED_COLOR }),
            });
          }
        } else if (existingRoutes.completed) {
          collections.routes.remove(existingRoutes.completed);
          delete existingRoutes.completed;
        }

        if (remainingPositions.length >= 2) {
          if (existingRoutes.remaining) {
            existingRoutes.remaining.positions = remainingPositions;
            existingRoutes.remaining.show = true;
          } else {
            existingRoutes.remaining = collections.routes.add({
              positions: remainingPositions,
              width: 1.5,
              material: Material.fromType('Color', { color: ROUTE_REMAINING_COLOR }),
            });
          }
        } else if (existingRoutes.remaining) {
          collections.routes.remove(existingRoutes.remaining);
          delete existingRoutes.remaining;
        }

        routeMapRef.current.set(flight.icao24, existingRoutes);
      } else {
        if (existingRoutes.completed) {
          collections.routes.remove(existingRoutes.completed);
        }
        if (existingRoutes.remaining) {
          collections.routes.remove(existingRoutes.remaining);
        }
        routeMapRef.current.delete(flight.icao24);
      }
    }

    for (const [icao, primitives] of primitiveMapRef.current) {
      if (!activeIcaos.has(icao)) {
        collections.billboards.remove(primitives.billboard);
        collections.labels.remove(primitives.label);
        primitiveMapRef.current.delete(icao);
      }
    }

    for (const [icao, trail] of trailMapRef.current) {
      if (!activeIcaos.has(icao)) {
        collections.trails.remove(trail);
        trailMapRef.current.delete(icao);
      }
    }

    for (const [icao, routes] of routeMapRef.current) {
      if (!activeIcaos.has(icao) || !showPaths) {
        if (routes.completed) collections.routes.remove(routes.completed);
        if (routes.remaining) collections.routes.remove(routes.remaining);
        routeMapRef.current.delete(icao);
      }
    }

    entityMapRef.current.forEach((entity, icao) => {
      if (!activeIcaos.has(icao) && viewer.trackedEntity !== entity) {
        viewer.entities.remove(entity);
        entityMapRef.current.delete(icao);
        positionMapRef.current.delete(icao);
        flightStateRef.current.delete(icao);
      }
    });

    for (const icao of Array.from(historyMapRef.current.keys())) {
      if (!presentIcaos.has(icao)) {
        historyMapRef.current.delete(icao);
      }
    }

    recordLayerPerformance('flights', {
      updateMs: performance.now() - startedAt,
      primitives: primitiveMapRef.current.size * 2
        + trailMapRef.current.size
        + Array.from(routeMapRef.current.values()).reduce(
          (count, routes) => count + (routes.completed ? 1 : 0) + (routes.remaining ? 1 : 0),
          0,
        ),
      visibleCount: activeIcaos.size,
    });
  }, [airspaceRangeKm, altitudeFilter, flights, showPaths, showPredictions, viewer, visible]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!collections) {
      return;
    }

    collections.billboards.show = visible;
    collections.labels.show = visible && !isTracking;
    collections.trails.show = visible;
    collections.routes.show = visible && showPaths;
  }, [isTracking, showPaths, visible]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    let lastBulkUpdate = 0;
    const bulkMs = 1_000;

    const onPreUpdate = () => {
      if (viewer.isDestroyed()) {
        return;
      }

      const now = Date.now();
      const tracked = viewer.trackedEntity;
      const trackedId = tracked && typeof tracked.id === 'string' && tracked.id.startsWith('flight-')
        ? tracked.id.slice(7)
        : null;
      const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, viewer.camera.positionWC);
      const shouldRefreshOcclusion = now - lastOcclusionUpdateRef.current >= 180;

      if (shouldRefreshOcclusion) {
        lastOcclusionUpdateRef.current = now;
      }

      for (const [icao, primitives] of primitiveMapRef.current) {
        const position = positionMapRef.current.get(icao);
        if (icao === trackedId) {
          primitives.billboard.scale = TRACKED_SCALE;
          primitives.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          primitives.billboard.alignedAxis = Cartesian3.ZERO;
          primitives.billboard.show = true;
          primitives.label.show = false;

          const state = flightStateRef.current.get(icao);
          if (state?.heading != null) {
            primitives.billboard.rotation = viewer.camera.heading - CesiumMath.toRadians(state.heading);
          }
          continue;
        }

        primitives.billboard.disableDepthTestDistance = 0;
        primitives.billboard.alignedAxis = Cartesian3.UNIT_Z;

        const state = flightStateRef.current.get(icao);
        primitives.billboard.scale = state ? getAltitudeScale(state.alt / 0.3048) : 0.3;

        if (position && shouldRefreshOcclusion) {
          const visibleToCamera = occluder.isPointVisible(position);
          primitives.billboard.show = visibleToCamera;
          primitives.label.show = visibleToCamera && !isTracking;
        }
      }

      if (tracked && typeof tracked.id === 'string' && tracked.id.startsWith('flight-')) {
        const icao = tracked.id.slice(7);
        const state = flightStateRef.current.get(icao);
        if (state) {
          const dtSeconds = (now - state.updatedAt) / 1000;
          let latitude = state.lat;
          let longitude = state.lon;

          if (state.heading != null && state.speed != null && state.speed > 10 && dtSeconds > 0 && dtSeconds < 120) {
            const speedMps = state.speed * 0.514444;
            const headingRadians = CesiumMath.toRadians(state.heading);
            latitude += (Math.cos(headingRadians) * speedMps * dtSeconds) / 111320;
            const cosLatitude = Math.cos(latitude * (Math.PI / 180)) || 0.0001;
            longitude += (Math.sin(headingRadians) * speedMps * dtSeconds) / (111320 * cosLatitude);
          }

          const normalizedLongitude = normalizeLongitude(longitude);
          if (
            isRenderableLatitude(latitude) &&
            isRenderableLongitude(normalizedLongitude) &&
            isRenderableAltitude(state.alt, { min: 0, max: 100_000 })
          ) {
            const position = Cartesian3.fromDegrees(normalizedLongitude, latitude, state.alt);
            positionMapRef.current.set(icao, position);
            const primitives = primitiveMapRef.current.get(icao);
            if (primitives) {
              primitives.billboard.position = position;
              primitives.label.position = position;
            }
          }
        }
      }

      if (now - lastBulkUpdate >= bulkMs) {
        lastBulkUpdate = now;
        for (const [icao, primitives] of primitiveMapRef.current) {
          if (icao === trackedId) {
            continue;
          }

          const state = flightStateRef.current.get(icao);
          if (!state) {
            continue;
          }

          const dtSeconds = (now - state.updatedAt) / 1000;
          if (dtSeconds <= 0 || dtSeconds > 120) {
            continue;
          }

          let latitude = state.lat;
          let longitude = state.lon;
          if (state.heading != null && state.speed != null && state.speed > 10) {
            const speedMps = state.speed * 0.514444;
            const headingRadians = CesiumMath.toRadians(state.heading);
            latitude += (Math.cos(headingRadians) * speedMps * dtSeconds) / 111320;
            const cosLatitude = Math.cos(latitude * (Math.PI / 180)) || 0.0001;
            longitude += (Math.sin(headingRadians) * speedMps * dtSeconds) / (111320 * cosLatitude);
          }

          const normalizedLongitude = normalizeLongitude(longitude);
          if (
            !isRenderableLatitude(latitude) ||
            !isRenderableLongitude(normalizedLongitude) ||
            !isRenderableAltitude(state.alt, { min: 0, max: 100_000 })
          ) {
            continue;
          }

          const position = Cartesian3.fromDegrees(normalizedLongitude, latitude, state.alt);
          positionMapRef.current.set(icao, position);
          primitives.billboard.position = position;
          primitives.label.position = position;
        }
      }
    };

    viewer.scene.preUpdate.addEventListener(onPreUpdate);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preUpdate.removeEventListener(onPreUpdate);
      }
    };
  }, [isTracking, viewer]);

  return null;
}
