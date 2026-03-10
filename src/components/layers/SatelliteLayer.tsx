import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  Billboard,
  BillboardCollection,
  BlendOption,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  Entity as CesiumEntity,
  HorizontalOrigin,
  Label,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  Material,
  NearFarScalar,
  Polyline,
  PolylineCollection,
  VerticalOrigin,
} from 'cesium';
import * as Cesium from 'cesium';
import type { SatellitePosition } from '../../hooks/useSatellites';
import { normalizeLongitude } from '../../lib/cesiumSafety';
import { recordLayerPerformance } from '../../lib/performanceStore';

const EllipsoidalOccluder = (Cesium as unknown as {
  EllipsoidalOccluder: new (
    ellipsoid: typeof Ellipsoid.WGS84,
    cameraPosition: Cartesian3,
  ) => { isPointVisible(point: Cartesian3): boolean };
}).EllipsoidalOccluder;

const SAT_COLOR_ISS = Color.fromCssColorString('#00D4FF');
const SAT_COLOR_DEFAULT = Color.fromCssColorString('#39FF14');

function createPolylineMaterial(color: Color) {
  return Material.fromType('Color', { color });
}

export type SatelliteCategory = 'iss' | 'other';

interface SatelliteLayerProps {
  satellites: SatellitePosition[];
  visible: boolean;
  showPaths: boolean;
  categoryFilter: Record<SatelliteCategory, boolean>;
  isTracking?: boolean;
}

interface SatellitePrimitiveRefs {
  billboard: Billboard;
  label: Label;
  orbit?: Polyline;
  groundTrack?: Polyline;
  nadir?: Polyline;
}

function createSatelliteIcon() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }

  const centerX = size / 2;
  const centerY = size / 2;
  context.fillStyle = '#FFFFFF';
  context.strokeStyle = '#FFFFFF';
  context.lineWidth = 1.2;

  context.beginPath();
  context.moveTo(centerX, centerY - 5);
  context.lineTo(centerX + 4, centerY);
  context.lineTo(centerX, centerY + 5);
  context.lineTo(centerX - 4, centerY);
  context.closePath();
  context.fill();

  context.fillRect(centerX - 14, centerY - 3, 9, 6);
  context.fillRect(centerX + 5, centerY - 3, 9, 6);

  context.beginPath();
  context.moveTo(centerX - 4, centerY);
  context.lineTo(centerX - 14, centerY);
  context.moveTo(centerX + 4, centerY);
  context.lineTo(centerX + 14, centerY);
  context.stroke();

  return canvas;
}

let satelliteIcon: HTMLCanvasElement | null = null;
function getSatelliteIcon() {
  if (!satelliteIcon) {
    satelliteIcon = createSatelliteIcon();
  }
  return satelliteIcon;
}

function computeBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad)
    - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function isIssSatellite(satellite: SatellitePosition) {
  return satellite.name.includes('ISS') || satellite.noradId === 25544;
}

export default function SatelliteLayer({
  satellites,
  visible,
  showPaths,
  categoryFilter,
  isTracking = false,
}: SatelliteLayerProps) {
  const { viewer } = useCesium();
  const collectionsRef = useRef<{
    billboards: BillboardCollection;
    labels: LabelCollection;
    orbits: PolylineCollection;
    groundTracks: PolylineCollection;
    nadirs: PolylineCollection;
  } | null>(null);
  const primitiveMapRef = useRef<Map<number, SatellitePrimitiveRefs>>(new Map());
  const entityMapRef = useRef<Map<number, CesiumEntity>>(new Map());
  const positionMapRef = useRef<Map<number, Cartesian3>>(new Map());
  const headingMapRef = useRef<Map<number, number>>(new Map());
  const scaleMapRef = useRef<Map<number, number>>(new Map());
  const lastOcclusionUpdateRef = useRef(0);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const billboards = new BillboardCollection();
    const labels = new LabelCollection({ blendOption: BlendOption.TRANSLUCENT });
    const orbits = new PolylineCollection();
    const groundTracks = new PolylineCollection();
    const nadirs = new PolylineCollection();

    viewer.scene.primitives.add(billboards);
    viewer.scene.primitives.add(labels);
    viewer.scene.primitives.add(orbits);
    viewer.scene.primitives.add(groundTracks);
    viewer.scene.primitives.add(nadirs);

    collectionsRef.current = { billboards, labels, orbits, groundTracks, nadirs };

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(billboards);
        viewer.scene.primitives.remove(labels);
        viewer.scene.primitives.remove(orbits);
        viewer.scene.primitives.remove(groundTracks);
        viewer.scene.primitives.remove(nadirs);
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
      entityMapRef.current.clear();
      positionMapRef.current.clear();
      headingMapRef.current.clear();
      scaleMapRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!viewer || viewer.isDestroyed() || !collections) {
      return;
    }

    const startedAt = performance.now();
    const filtered = visible
      ? satellites.filter((satellite) => {
        const category: SatelliteCategory = isIssSatellite(satellite) ? 'iss' : 'other';
        return categoryFilter[category];
      })
      : [];
    const activeIds = new Set(filtered.map((satellite) => satellite.noradId));

    for (const [noradId, primitives] of primitiveMapRef.current) {
      if (!activeIds.has(noradId)) {
        collections.billboards.remove(primitives.billboard);
        collections.labels.remove(primitives.label);
        if (primitives.orbit) collections.orbits.remove(primitives.orbit);
        if (primitives.groundTrack) collections.groundTracks.remove(primitives.groundTrack);
        if (primitives.nadir) collections.nadirs.remove(primitives.nadir);
        primitiveMapRef.current.delete(noradId);
      }
    }

    for (const [noradId, entity] of entityMapRef.current) {
      if (!activeIds.has(noradId)) {
        viewer.entities.remove(entity);
        entityMapRef.current.delete(noradId);
        positionMapRef.current.delete(noradId);
        headingMapRef.current.delete(noradId);
        scaleMapRef.current.delete(noradId);
      }
    }

    for (const satellite of filtered) {
      const isIss = isIssSatellite(satellite);
      const color = isIss ? SAT_COLOR_ISS : SAT_COLOR_DEFAULT;
      const scale = isIss ? 0.6 : 0.35;
      scaleMapRef.current.set(satellite.noradId, scale);
      const position = Cartesian3.fromDegrees(
        normalizeLongitude(satellite.longitude),
        satellite.latitude,
        satellite.altitude * 1000,
      );

      positionMapRef.current.set(satellite.noradId, position);

      const orbitPath = satellite.orbitPath ?? [];
      const heading = orbitPath.length >= 2
        ? computeBearing(
          orbitPath[0]!.latitude,
          orbitPath[0]!.longitude,
          orbitPath[1]!.latitude,
          orbitPath[1]!.longitude,
        )
        : headingMapRef.current.get(satellite.noradId) ?? 0;
      headingMapRef.current.set(satellite.noradId, heading);

      let backingEntity = entityMapRef.current.get(satellite.noradId);
      if (!backingEntity) {
        const noradId = satellite.noradId;
        backingEntity = new CesiumEntity({
          id: `sat-${satellite.noradId}`,
          name: satellite.name,
          position: new CallbackProperty(
            () => positionMapRef.current.get(noradId) ?? position,
            false,
          ) as unknown as never,
          description: [
            `<p><b>NORAD ID:</b> ${satellite.noradId}</p>`,
            `<p><b>Altitude:</b> ${satellite.altitude.toFixed(1)} km</p>`,
            `<p><b>Lat:</b> ${satellite.latitude.toFixed(4)} deg</p>`,
            `<p><b>Lon:</b> ${satellite.longitude.toFixed(4)} deg</p>`,
          ].join(''),
          point: {
            pixelSize: 1,
            color: Color.TRANSPARENT,
          },
        });
        viewer.entities.add(backingEntity);
        entityMapRef.current.set(satellite.noradId, backingEntity);
      } else {
        backingEntity.name = satellite.name;
      }

      const primitives = primitiveMapRef.current.get(satellite.noradId);
      if (primitives) {
        primitives.billboard.position = position;
        primitives.billboard.color = color;
        primitives.billboard.rotation = -CesiumMath.toRadians(heading);
        primitives.billboard.scale = isTracking ? 1.0 : scale;
        primitives.billboard.id = backingEntity;
        primitives.label.position = position;
        primitives.label.text = satellite.name;
        primitives.label.fillColor = color.withAlpha(0.8);
        primitives.label.show = !isTracking;
      } else {
        const billboard = collections.billboards.add({
          position,
          image: getSatelliteIcon(),
          color,
          scale: isTracking ? 1.0 : scale,
          rotation: -CesiumMath.toRadians(heading),
          alignedAxis: Cartesian3.UNIT_Z,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e5, 1.5, 1e8, 0.3),
          id: backingEntity,
        });
        const label = collections.labels.add({
          position,
          text: satellite.name,
          font: '9px monospace',
          fillColor: color.withAlpha(0.8),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(8, -4),
          scaleByDistance: new NearFarScalar(1e5, 1, 5e7, 0),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 5_000_000),
          id: backingEntity,
        });
        primitiveMapRef.current.set(satellite.noradId, { billboard, label });
      }

      const primitiveRefs = primitiveMapRef.current.get(satellite.noradId)!;
      if (showPaths && orbitPath.length >= 2) {
        const orbitPositions = orbitPath.map((point) =>
          Cartesian3.fromDegrees(normalizeLongitude(point.longitude), point.latitude, point.altitude * 1000),
        );
        const groundTrackPositions = orbitPath.map((point) =>
          Cartesian3.fromDegrees(normalizeLongitude(point.longitude), point.latitude, 0),
        );
        const nadirPositions = [
          Cartesian3.fromDegrees(normalizeLongitude(satellite.longitude), satellite.latitude, 0),
          Cartesian3.fromDegrees(normalizeLongitude(satellite.longitude), satellite.latitude, satellite.altitude * 1000),
        ];

        if (primitiveRefs.orbit) {
          primitiveRefs.orbit.positions = orbitPositions;
          primitiveRefs.orbit.show = true;
        } else {
          primitiveRefs.orbit = collections.orbits.add({
            positions: orbitPositions,
            width: isIss ? 3 : 2,
            material: createPolylineMaterial(color.withAlpha(isIss ? 0.7 : 0.4)),
          });
        }

        if (primitiveRefs.groundTrack) {
          primitiveRefs.groundTrack.positions = groundTrackPositions;
          primitiveRefs.groundTrack.show = true;
        } else {
          primitiveRefs.groundTrack = collections.groundTracks.add({
            positions: groundTrackPositions,
            width: isIss ? 2 : 1,
            material: createPolylineMaterial(color.withAlpha(isIss ? 0.35 : 0.15)),
          });
        }

        if (primitiveRefs.nadir) {
          primitiveRefs.nadir.positions = nadirPositions;
          primitiveRefs.nadir.show = true;
        } else {
          primitiveRefs.nadir = collections.nadirs.add({
            positions: nadirPositions,
            width: 1,
            material: createPolylineMaterial(color.withAlpha(0.2)),
          });
        }
      } else {
        if (primitiveRefs.orbit) primitiveRefs.orbit.show = false;
        if (primitiveRefs.groundTrack) primitiveRefs.groundTrack.show = false;
        if (primitiveRefs.nadir) primitiveRefs.nadir.show = false;
      }
    }

    recordLayerPerformance('satellites', {
      updateMs: performance.now() - startedAt,
      primitives: Array.from(primitiveMapRef.current.values()).reduce(
        (count, primitives) => count
          + 2
          + (primitives.orbit ? 1 : 0)
          + (primitives.groundTrack ? 1 : 0)
          + (primitives.nadir ? 1 : 0),
        0,
      ),
      visibleCount: filtered.length,
    });
  }, [categoryFilter, isTracking, satellites, showPaths, viewer, visible]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const onPreUpdate = () => {
      const tracked = viewer.trackedEntity;
      const trackedNoradId = tracked && typeof tracked.id === 'string' && tracked.id.startsWith('sat-')
        ? Number.parseInt(tracked.id.slice(4), 10)
        : null;

      const now = performance.now();
      const shouldRefreshOcclusion = now - lastOcclusionUpdateRef.current >= 220;
      if (shouldRefreshOcclusion) {
        lastOcclusionUpdateRef.current = now;
      }

      const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, viewer.camera.positionWC);

      for (const [noradId, primitives] of primitiveMapRef.current) {
        const position = positionMapRef.current.get(noradId);
        if (!position) {
          continue;
        }

        if (trackedNoradId === noradId) {
          primitives.billboard.scale = 1.0;
          primitives.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          primitives.billboard.alignedAxis = Cartesian3.ZERO;
          primitives.billboard.rotation = viewer.camera.heading - CesiumMath.toRadians(headingMapRef.current.get(noradId) ?? 0);
          primitives.billboard.show = true;
          primitives.label.show = false;
          continue;
        }

        if (shouldRefreshOcclusion) {
          const visibleToCamera = occluder.isPointVisible(position);
          primitives.billboard.show = visibleToCamera;
          primitives.label.show = visibleToCamera && !isTracking;
        }

        primitives.billboard.scale = scaleMapRef.current.get(noradId) ?? 0.35;
        primitives.billboard.disableDepthTestDistance = 0;
        primitives.billboard.alignedAxis = Cartesian3.UNIT_Z;
      }
    };

    viewer.scene.preUpdate.addEventListener(onPreUpdate);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preUpdate.removeEventListener(onPreUpdate);
      }
    };
  }, [isTracking, viewer]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!collections) {
      return;
    }

    collections.billboards.show = visible;
    collections.labels.show = visible;
    collections.orbits.show = visible && showPaths;
    collections.groundTracks.show = visible && showPaths;
    collections.nadirs.show = visible && showPaths;
  }, [showPaths, visible]);

  return null;
}
