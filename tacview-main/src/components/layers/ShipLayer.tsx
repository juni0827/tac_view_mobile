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
import type { Ship, ShipCategory } from '../../hooks/useShips';
import { getShipCategory } from '../../hooks/useShips';
import { recordLayerPerformance } from '../../lib/performanceStore';

const EllipsoidalOccluder = (Cesium as unknown as {
  EllipsoidalOccluder: new (
    ellipsoid: typeof Ellipsoid.WGS84,
    cameraPosition: Cartesian3,
  ) => { isPointVisible(point: Cartesian3): boolean };
}).EllipsoidalOccluder;

interface ShipLayerProps {
  ships: Ship[];
  visible: boolean;
  isTracking: boolean;
}

interface ShipState {
  lat: number;
  lon: number;
  heading: number | null;
  cog: number | null;
  sog: number;
  updatedAt: number;
}

interface ShipPrimitiveRefs {
  billboard: Billboard;
  label: Label;
}

const CATEGORY_COLORS: Record<ShipCategory, Color> = {
  cargo: Color.fromCssColorString('#00D4FF'),
  tanker: Color.fromCssColorString('#FF9500'),
  passenger: Color.fromCssColorString('#39FF14'),
  fishing: Color.fromCssColorString('#FFE640'),
  military: Color.fromCssColorString('#FF3B30'),
  tug: Color.fromCssColorString('#E040FB'),
  pleasure: Color.fromCssColorString('#00FFCC'),
  highspeed: Color.fromCssColorString('#FF4081'),
  other: Color.fromCssColorString('#FFEB3B'),
};

const LABEL_OFFSET = new CesiumCartesian2(10, -4);
const TRAIL_ALPHA = 0.35;
const TRACKED_SCALE = 0.85;

function getShipColor(category: ShipCategory) {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
}

function buildShipDescription(ship: Ship, category: ShipCategory) {
  return `
    <p><b>Name:</b> ${ship.name || ship.mmsi}</p>
    <p><b>MMSI:</b> ${ship.mmsi}</p>
    <p><b>Category:</b> ${category.toUpperCase()}</p>
    <p><b>Destination:</b> ${ship.destination || 'N/A'}</p>
    <p><b>Speed:</b> ${ship.sog.toFixed(1)} kt</p>
    <p><b>Heading:</b> ${ship.heading ?? ship.cog ?? 'N/A'}</p>
    <p><b>Call Sign:</b> ${ship.callSign || 'N/A'}</p>
    <p><b>IMO:</b> ${ship.imo ?? 'N/A'}</p>
  `;
}

function createShipIcon() {
  const size = 28;
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
  context.lineTo(centerX + 5, 8);
  context.lineTo(centerX + 5, 22);
  context.lineTo(centerX + 3, 26);
  context.lineTo(centerX - 3, 26);
  context.lineTo(centerX - 5, 22);
  context.lineTo(centerX - 5, 8);
  context.closePath();
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.5)';
  context.fillRect(centerX - 3, 14, 6, 4);

  return canvas;
}

let shipIcon: HTMLCanvasElement | null = null;
function getShipIcon() {
  if (!shipIcon) {
    shipIcon = createShipIcon();
  }
  return shipIcon;
}

function buildTrailPositions(ship: Ship, position: Cartesian3) {
  const trailHeading = ship.heading ?? ship.cog;
  if (trailHeading == null || ship.sog <= 0.5) {
    return null;
  }

  const trailLengthDegrees = 0.08;
  const headingRadians = CesiumMath.toRadians(trailHeading);
  return [
    Cartesian3.fromDegrees(
      ship.longitude - Math.sin(headingRadians) * trailLengthDegrees,
      ship.latitude - Math.cos(headingRadians) * trailLengthDegrees,
      0,
    ),
    position,
  ];
}

export default function ShipLayer({ ships, visible, isTracking }: ShipLayerProps) {
  const { viewer } = useCesium();
  const entityMapRef = useRef<Map<string, CesiumEntity>>(new Map());
  const positionMapRef = useRef<Map<string, Cartesian3>>(new Map());
  const shipStateRef = useRef<Map<string, ShipState>>(new Map());
  const collectionsRef = useRef<{
    billboards: BillboardCollection;
    labels: LabelCollection;
    trails: PolylineCollection;
  } | null>(null);
  const primitiveMapRef = useRef<Map<string, ShipPrimitiveRefs>>(new Map());
  const trailMapRef = useRef<Map<string, Polyline>>(new Map());
  const lastOcclusionUpdateRef = useRef(0);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const billboards = new BillboardCollection();
    const labels = new LabelCollection({ blendOption: BlendOption.TRANSLUCENT });
    const trails = new PolylineCollection();

    viewer.scene.primitives.add(billboards);
    viewer.scene.primitives.add(labels);
    viewer.scene.primitives.add(trails);

    collectionsRef.current = { billboards, labels, trails };

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(billboards);
        viewer.scene.primitives.remove(labels);
        viewer.scene.primitives.remove(trails);
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
      entityMapRef.current.clear();
      positionMapRef.current.clear();
      shipStateRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!viewer || viewer.isDestroyed() || !collections) {
      return;
    }

    const startedAt = performance.now();

    if (!visible || ships.length === 0) {
      collections.billboards.removeAll();
      collections.labels.removeAll();
      collections.trails.removeAll();
      primitiveMapRef.current.clear();
      trailMapRef.current.clear();
      recordLayerPerformance('ships', {
        updateMs: performance.now() - startedAt,
        primitives: 0,
        visibleCount: 0,
      });
      return;
    }

    const activeMmsis = new Set<string>();

    for (const ship of ships) {
      activeMmsis.add(ship.mmsi);

      const category = getShipCategory(ship.shipType);
      const color = getShipColor(category);
      const position = Cartesian3.fromDegrees(ship.longitude, ship.latitude, 0);
      const heading = ship.heading ?? ship.cog ?? null;
      const rotation = heading != null ? -CesiumMath.toRadians(heading) : 0;
      const labelText = `${ship.name || ship.mmsi} ${ship.sog.toFixed(1)}kt ${ship.destination || ''}`.trim();

      positionMapRef.current.set(ship.mmsi, position);
      shipStateRef.current.set(ship.mmsi, {
        lat: ship.latitude,
        lon: ship.longitude,
        heading: ship.heading,
        cog: ship.cog,
        sog: ship.sog,
        updatedAt: Date.now(),
      });

      let backingEntity = entityMapRef.current.get(ship.mmsi);
      if (!backingEntity) {
        const mmsi = ship.mmsi;
        backingEntity = new CesiumEntity({
          id: `ship-${ship.mmsi}`,
          name: ship.name || ship.mmsi,
          position: new CallbackProperty(
            () => positionMapRef.current.get(mmsi) ?? position,
            false,
          ) as unknown as never,
          description: new ConstantProperty(buildShipDescription(ship, category)),
          point: {
            pixelSize: 1,
            color: Color.TRANSPARENT,
          },
        });
        viewer.entities.add(backingEntity);
        entityMapRef.current.set(ship.mmsi, backingEntity);
      } else {
        backingEntity.name = ship.name || ship.mmsi;
        (backingEntity.description as ConstantProperty).setValue(buildShipDescription(ship, category));
      }

      const existing = primitiveMapRef.current.get(ship.mmsi);
      if (existing) {
        existing.billboard.position = position;
        existing.billboard.color = color;
        existing.billboard.rotation = rotation;
        existing.billboard.id = backingEntity;
        existing.label.position = position;
        existing.label.text = labelText;
        existing.label.fillColor = color.withAlpha(0.85);
        existing.label.id = backingEntity;
      } else {
        const billboard = collections.billboards.add({
          position,
          image: getShipIcon(),
          color,
          scale: 0.4,
          rotation,
          alignedAxis: Cartesian3.UNIT_Z,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e4, 1.5, 5e7, 0.15),
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
          distanceDisplayCondition: new DistanceDisplayCondition(0, 5_000_000),
          disableDepthTestDistance: 0,
          id: backingEntity,
        });
        primitiveMapRef.current.set(ship.mmsi, { billboard, label });
      }

      const trailPositions = buildTrailPositions(ship, position);
      const trail = trailMapRef.current.get(ship.mmsi);
      if (trailPositions) {
        if (trail) {
          trail.positions = trailPositions;
          trail.show = true;
        } else {
          trailMapRef.current.set(
            ship.mmsi,
            collections.trails.add({
              positions: trailPositions,
              width: 1.5,
              material: Material.fromType('Color', { color: color.withAlpha(TRAIL_ALPHA) }),
            }),
          );
        }
      } else if (trail) {
        collections.trails.remove(trail);
        trailMapRef.current.delete(ship.mmsi);
      }
    }

    for (const [mmsi, primitives] of primitiveMapRef.current) {
      if (!activeMmsis.has(mmsi)) {
        collections.billboards.remove(primitives.billboard);
        collections.labels.remove(primitives.label);
        primitiveMapRef.current.delete(mmsi);
      }
    }

    for (const [mmsi, trail] of trailMapRef.current) {
      if (!activeMmsis.has(mmsi)) {
        collections.trails.remove(trail);
        trailMapRef.current.delete(mmsi);
      }
    }

    entityMapRef.current.forEach((entity, mmsi) => {
      if (!activeMmsis.has(mmsi) && viewer.trackedEntity !== entity) {
        viewer.entities.remove(entity);
        entityMapRef.current.delete(mmsi);
        positionMapRef.current.delete(mmsi);
        shipStateRef.current.delete(mmsi);
      }
    });

    recordLayerPerformance('ships', {
      updateMs: performance.now() - startedAt,
      primitives: primitiveMapRef.current.size * 2 + trailMapRef.current.size,
      visibleCount: activeMmsis.size,
    });
  }, [ships, viewer, visible]);

  useEffect(() => {
    const collections = collectionsRef.current;
    if (!collections) {
      return;
    }

    collections.billboards.show = visible;
    collections.labels.show = visible && !isTracking;
    collections.trails.show = visible;
  }, [isTracking, visible]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    let lastBulkUpdate = 0;
    const bulkMs = 2_000;

    const onPreUpdate = () => {
      if (viewer.isDestroyed()) {
        return;
      }

      const now = Date.now();
      const tracked = viewer.trackedEntity;
      const trackedId = tracked && typeof tracked.id === 'string' && tracked.id.startsWith('ship-')
        ? tracked.id.slice(5)
        : null;
      const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, viewer.camera.positionWC);
      const shouldRefreshOcclusion = now - lastOcclusionUpdateRef.current >= 220;

      if (shouldRefreshOcclusion) {
        lastOcclusionUpdateRef.current = now;
      }

      for (const [mmsi, primitives] of primitiveMapRef.current) {
        const position = positionMapRef.current.get(mmsi);
        if (mmsi === trackedId) {
          primitives.billboard.scale = TRACKED_SCALE;
          primitives.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          primitives.billboard.alignedAxis = Cartesian3.ZERO;
          primitives.billboard.show = true;
          primitives.label.show = false;

          const state = shipStateRef.current.get(mmsi);
          const heading = state?.heading ?? state?.cog;
          if (heading != null) {
            primitives.billboard.rotation = viewer.camera.heading - CesiumMath.toRadians(heading);
          }
          continue;
        }

        primitives.billboard.scale = 0.4;
        primitives.billboard.disableDepthTestDistance = 0;
        primitives.billboard.alignedAxis = Cartesian3.UNIT_Z;

        if (position && shouldRefreshOcclusion) {
          const visibleToCamera = occluder.isPointVisible(position);
          primitives.billboard.show = visibleToCamera;
          primitives.label.show = visibleToCamera && !isTracking;
        }
      }

      if (tracked && typeof tracked.id === 'string' && tracked.id.startsWith('ship-')) {
        const mmsi = tracked.id.slice(5);
        const state = shipStateRef.current.get(mmsi);
        if (state) {
          const dtSeconds = (now - state.updatedAt) / 1000;
          const heading = state.heading ?? state.cog;
          let latitude = state.lat;
          let longitude = state.lon;

          if (heading != null && state.sog > 0.5 && dtSeconds > 0 && dtSeconds < 300) {
            const speedMps = state.sog * 0.514444;
            const headingRadians = CesiumMath.toRadians(heading);
            latitude += (Math.cos(headingRadians) * speedMps * dtSeconds) / 111320;
            const cosLatitude = Math.cos(latitude * (Math.PI / 180)) || 0.0001;
            longitude += (Math.sin(headingRadians) * speedMps * dtSeconds) / (111320 * cosLatitude);
          }

          const position = Cartesian3.fromDegrees(longitude, latitude, 0);
          positionMapRef.current.set(mmsi, position);
          const primitives = primitiveMapRef.current.get(mmsi);
          if (primitives) {
            primitives.billboard.position = position;
            primitives.label.position = position;
          }
        }
      }

      if (now - lastBulkUpdate >= bulkMs) {
        lastBulkUpdate = now;
        for (const [mmsi, primitives] of primitiveMapRef.current) {
          if (mmsi === trackedId) {
            continue;
          }

          const state = shipStateRef.current.get(mmsi);
          if (!state) {
            continue;
          }

          const dtSeconds = (now - state.updatedAt) / 1000;
          if (dtSeconds <= 0 || dtSeconds > 300) {
            continue;
          }

          const heading = state.heading ?? state.cog;
          let latitude = state.lat;
          let longitude = state.lon;

          if (heading != null && state.sog > 0.5) {
            const speedMps = state.sog * 0.514444;
            const headingRadians = CesiumMath.toRadians(heading);
            latitude += (Math.cos(headingRadians) * speedMps * dtSeconds) / 111320;
            const cosLatitude = Math.cos(latitude * (Math.PI / 180)) || 0.0001;
            longitude += (Math.sin(headingRadians) * speedMps * dtSeconds) / (111320 * cosLatitude);
          }

          const position = Cartesian3.fromDegrees(longitude, latitude, 0);
          positionMapRef.current.set(mmsi, position);
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
