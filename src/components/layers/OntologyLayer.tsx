import { useEffect, useRef } from 'react';
import {
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  DistanceDisplayCondition,
  LabelStyle,
  NearFarScalar,
} from 'cesium';
import { useCesium } from 'resium';
import { recordLayerPerformance } from '../../lib/performanceStore';
import { buildOntologyEntityDescription, getOntologyEntityFocus } from '../../ontology/presentation';
import type { OntologyEntity } from '../../types/ontology';

interface OntologyLayerProps {
  entities: OntologyEntity[];
  visible: boolean;
}

const TYPE_COLORS: Record<string, Color> = {
  airport: Color.fromCssColorString('#00D4FF'),
  port: Color.fromCssColorString('#00BFFF'),
  military_site: Color.fromCssColorString('#FF3B30'),
  power_site: Color.fromCssColorString('#FFD60A'),
  substation: Color.fromCssColorString('#FF9F0A'),
  tower: Color.fromCssColorString('#39FF14'),
  rail_node: Color.fromCssColorString('#B8FF6A'),
  bridge: Color.fromCssColorString('#C7C7CC'),
  road_segment: Color.fromCssColorString('#808B96'),
  facility: Color.fromCssColorString('#8E8E93'),
};

function getEntityColor(entity: OntologyEntity) {
  const base = TYPE_COLORS[entity.canonicalType] ?? Color.fromCssColorString('#8E8E93');
  return entity.origin === 'synthetic' ? base.withAlpha(0.55) : base.withAlpha(0.9);
}

function getLineWidth(entity: OntologyEntity) {
  if (entity.canonicalType === 'bridge') return 2.8;
  if (entity.canonicalType === 'road_segment') return 2.2;
  if (entity.canonicalType === 'rail_node') return 2.4;
  return 2;
}

function getLabelText(entity: OntologyEntity) {
  if (entity.canonicalType === 'road_segment') {
    const roadName = typeof entity.metadata.name === 'string' && entity.metadata.name.trim()
      ? entity.metadata.name.trim()
      : entity.label;
    return roadName;
  }

  return entity.label;
}

function buildLinePositions(entity: OntologyEntity) {
  const points = Array.isArray(entity.geometry.data.points)
    ? entity.geometry.data.points as Array<Record<string, unknown>>
    : [];

  return points.flatMap((point) => {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    const altitude = Number(point.altitude ?? 0);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return [];
    }

    return [Cartesian3.fromDegrees(longitude, latitude, altitude)];
  });
}

export default function OntologyLayer({ entities, visible }: OntologyLayerProps) {
  const { viewer } = useCesium();
  const entityIdsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) {
        return;
      }

      for (const entityId of entityIdsRef.current) {
        const entity = viewer.entities.getById(entityId);
        if (entity) {
          viewer.entities.remove(entity);
        }
      }
      entityIdsRef.current = [];
    };
  }, [viewer]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const startedAt = performance.now();

    for (const entityId of entityIdsRef.current) {
      const existing = viewer.entities.getById(entityId);
      if (existing) {
        viewer.entities.remove(existing);
      }
    }
    entityIdsRef.current = [];

    if (!visible || entities.length === 0) {
      recordLayerPerformance('ontology', {
        updateMs: performance.now() - startedAt,
        primitives: 0,
        visibleCount: 0,
      });
      return;
    }

    for (const entity of entities) {
      const focus = getOntologyEntityFocus(entity);
      if (!focus) {
        continue;
      }

      const color = getEntityColor(entity);
      const position = Cartesian3.fromDegrees(focus.longitude, focus.latitude, Math.max(0, focus.altitude));
      const linePositions = entity.geometry.type === 'LineString' ? buildLinePositions(entity) : [];
      const entityDefinition = viewer.entities.add({
        id: entity.id,
        name: entity.label,
        position,
        description: new ConstantProperty(buildOntologyEntityDescription(entity)),
        point: {
          pixelSize: entity.canonicalType === 'road_segment' ? 4 : 7,
          color,
          outlineColor: Color.BLACK,
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(5_000, 1.2, 6_000_000, 0.35),
        },
        label: {
          text: getLabelText(entity),
          font: '10px monospace',
          fillColor: color,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(10, -12),
          scaleByDistance: new NearFarScalar(2_000, 1.05, 2_500_000, 0),
          distanceDisplayCondition: new DistanceDisplayCondition(0, entity.canonicalType === 'road_segment' ? 650_000 : 2_000_000),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        polyline: linePositions.length >= 2
          ? {
            positions: linePositions,
            width: getLineWidth(entity),
            material: color.withAlpha(entity.canonicalType === 'road_segment' ? 0.72 : 0.82),
            clampToGround: false,
          }
          : undefined,
      });

      entityIdsRef.current.push(entityDefinition.id as string);
    }

    recordLayerPerformance('ontology', {
      updateMs: performance.now() - startedAt,
      primitives: entityIdsRef.current.length,
      visibleCount: entityIdsRef.current.length,
    });
  }, [entities, viewer, visible]);

  return null;
}
