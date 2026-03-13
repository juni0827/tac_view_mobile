import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  Cartesian2,
  Cartesian3,
  Color,
  Entity as CesiumEntity,
  Label,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PointPrimitive,
  PointPrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import type { Earthquake } from '../../hooks/useEarthquakes';
import { recordLayerPerformance } from '../../lib/performanceStore';

interface EarthquakeLayerProps {
  earthquakes: Earthquake[];
  visible: boolean;
  isTracking?: boolean;
}

interface PulseState {
  point: PointPrimitive;
  magnitude: number;
  phase: number;
}

function getMagnitudeColor(magnitude: number) {
  if (magnitude >= 6) return Color.RED;
  if (magnitude >= 5) return Color.ORANGE;
  if (magnitude >= 4) return Color.YELLOW;
  if (magnitude >= 3) return Color.fromCssColorString('#FF9500').withAlpha(0.8);
  return Color.fromCssColorString('#FF9500').withAlpha(0.4);
}

function getMagnitudeSize(magnitude: number) {
  if (magnitude >= 6) return 14;
  if (magnitude >= 5) return 10;
  if (magnitude >= 4) return 7;
  if (magnitude >= 3) return 5;
  return 3;
}

function hashStringToPhase(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash % 360) * (Math.PI / 180);
}

export default function EarthquakeLayer({ earthquakes, visible, isTracking = false }: EarthquakeLayerProps) {
  const { viewer } = useCesium();
  const pointCollectionRef = useRef<PointPrimitiveCollection | null>(null);
  const labelCollectionRef = useRef<LabelCollection | null>(null);
  const pulseMapRef = useRef<Map<string, PulseState>>(new Map());
  const labelMapRef = useRef<Map<string, Label>>(new Map());
  const entityMapRef = useRef<Map<string, CesiumEntity>>(new Map());
  const lastPulseUpdateRef = useRef(0);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const points = new PointPrimitiveCollection();
    const labels = new LabelCollection();

    viewer.scene.primitives.add(points);
    viewer.scene.primitives.add(labels);

    pointCollectionRef.current = points;
    labelCollectionRef.current = labels;

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(points);
        viewer.scene.primitives.remove(labels);
        entityMapRef.current.forEach((entity) => {
          try {
            viewer.entities.remove(entity);
          } catch {
            // Best-effort cleanup.
          }
        });
      }

      pointCollectionRef.current = null;
      labelCollectionRef.current = null;
      pulseMapRef.current.clear();
      labelMapRef.current.clear();
      entityMapRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const points = pointCollectionRef.current;
    const labels = labelCollectionRef.current;
    if (!viewer || viewer.isDestroyed() || !points || !labels) {
      return;
    }

    const startedAt = performance.now();
    const filtered = visible ? earthquakes.filter((earthquake) => earthquake.mag >= 2.5) : [];
    const activeIds = new Set(filtered.map((earthquake) => earthquake.id));

    for (const [earthquakeId, pulseState] of pulseMapRef.current) {
      if (!activeIds.has(earthquakeId)) {
        points.remove(pulseState.point);
        pulseMapRef.current.delete(earthquakeId);
      }
    }

    for (const [earthquakeId, label] of labelMapRef.current) {
      if (!activeIds.has(earthquakeId)) {
        labels.remove(label);
        labelMapRef.current.delete(earthquakeId);
      }
    }

    for (const [earthquakeId, entity] of entityMapRef.current) {
      if (!activeIds.has(earthquakeId)) {
        viewer.entities.remove(entity);
        entityMapRef.current.delete(earthquakeId);
      }
    }

    for (const earthquake of filtered) {
      const position = Cartesian3.fromDegrees(earthquake.longitude, earthquake.latitude, 0);
      let backingEntity = entityMapRef.current.get(earthquake.id);

      if (!backingEntity) {
        backingEntity = new CesiumEntity({
          id: `eq-${earthquake.id}`,
          name: `M${earthquake.mag.toFixed(1)} ${earthquake.place}`,
          position,
          description: [
            `<p><b>Magnitude:</b> ${earthquake.mag.toFixed(1)}</p>`,
            `<p><b>Depth:</b> ${earthquake.depth.toFixed(1)} km</p>`,
            `<p><b>Time:</b> ${new Date(earthquake.time).toISOString()}</p>`,
          ].join(''),
          point: {
            pixelSize: 1,
            color: Color.TRANSPARENT,
          },
        });
        viewer.entities.add(backingEntity);
        entityMapRef.current.set(earthquake.id, backingEntity);
      } else {
        backingEntity.position = position as unknown as never;
      }

      const baseColor = getMagnitudeColor(earthquake.mag);
      const baseSize = getMagnitudeSize(earthquake.mag);
      const phase = hashStringToPhase(earthquake.id);
      const pulseState = pulseMapRef.current.get(earthquake.id);

      if (pulseState) {
        pulseState.point.position = position;
        pulseState.magnitude = earthquake.mag;
        pulseState.phase = phase;
        pulseState.point.id = backingEntity;
      } else {
        const point = points.add({
          position,
          pixelSize: baseSize,
          color: baseColor,
          outlineColor: Color.BLACK,
          outlineWidth: 1,
          scaleByDistance: new NearFarScalar(1e3, 1.5, 1e7, 0.5),
          id: backingEntity,
        });

        pulseMapRef.current.set(earthquake.id, {
          point,
          magnitude: earthquake.mag,
          phase,
        });
      }

      const shouldShowLabel = earthquake.mag >= 4.5 && !isTracking;
      const existingLabel = labelMapRef.current.get(earthquake.id);

      if (shouldShowLabel) {
        if (existingLabel) {
          existingLabel.position = position;
          existingLabel.show = true;
        } else {
          const label = labels.add({
            position,
            text: `M${earthquake.mag.toFixed(1)}`,
            font: '10px monospace',
            fillColor: Color.fromCssColorString('#FF9500'),
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -12),
            scaleByDistance: new NearFarScalar(1e3, 1, 5e6, 0.3),
          });
          labelMapRef.current.set(earthquake.id, label);
        }
      } else if (existingLabel) {
        existingLabel.show = false;
      }
    }

    recordLayerPerformance('earthquakes', {
      updateMs: performance.now() - startedAt,
      primitives: pulseMapRef.current.size + labelMapRef.current.size,
      visibleCount: filtered.length,
    });
  }, [earthquakes, isTracking, viewer, visible]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const onPreUpdate = () => {
      const now = performance.now();
      if (now - lastPulseUpdateRef.current < 100) {
        return;
      }
      lastPulseUpdateRef.current = now;

      const seconds = now / 1000;
      for (const pulseState of pulseMapRef.current.values()) {
        const baseSize = getMagnitudeSize(pulseState.magnitude);
        const pulse = (Math.sin(seconds * 2 + pulseState.phase) + 1) / 2;
        pulseState.point.pixelSize = baseSize + pulse * (baseSize * 0.8);
        pulseState.point.color = getMagnitudeColor(pulseState.magnitude).withAlpha(0.35 + pulse * 0.5);
      }
    };

    viewer.scene.preUpdate.addEventListener(onPreUpdate);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preUpdate.removeEventListener(onPreUpdate);
      }
    };
  }, [viewer]);

  useEffect(() => {
    if (pointCollectionRef.current) {
      pointCollectionRef.current.show = visible;
    }
    if (labelCollectionRef.current) {
      labelCollectionRef.current.show = visible;
    }
  }, [visible]);

  return null;
}
