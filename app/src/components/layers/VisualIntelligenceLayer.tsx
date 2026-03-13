import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  ArcType,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  CustomDataSource,
  JulianDate,
  LabelStyle,
  NearFarScalar,
  PointPrimitiveCollection,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  type Entity,
} from 'cesium';
import type {
  ActivityCloud,
  GlobePoint,
  MesoGroupTrack,
  MicroGroupTrack,
  SelectionContext,
  TieredGroupSnapshot,
} from '../../intelligence/visualIntelligence';
import { recordLayerPerformance } from '../../lib/performanceStore';

interface VisualIntelligenceLayerProps {
  tieredGroups: TieredGroupSnapshot;
  selectionContext: SelectionContext | null;
  cameraAltitude: number;
}

const PATH_COLORS = [
  Color.fromCssColorString('#00D4FF'),
  Color.fromCssColorString('#39FF14'),
  Color.fromCssColorString('#FF9500'),
];

function toCartesian(point: GlobePoint) {
  return Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude);
}

function toPoint(latitude: number, longitude: number, altitude: number): GlobePoint {
  return { latitude, longitude, altitude };
}

function patchEntity(entity: Entity, patch: Record<string, unknown>) {
  Object.assign(entity as unknown as Record<string, unknown>, patch);
}

function ensureEntity(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  id: string,
) {
  const existing = cache.get(id);
  if (existing) {
    return existing;
  }
  const entity = source.entities.add({ id });
  cache.set(id, entity);
  return entity;
}

function removeMissingEntities(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  nextIds: Set<string>,
) {
  for (const [id, entity] of cache.entries()) {
    if (nextIds.has(id)) {
      continue;
    }
    source.entities.remove(entity);
    cache.delete(id);
  }
}

function syncMicroGroups(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  groups: MicroGroupTrack[],
  cameraAltitude: number,
) {
  const nextIds = new Set<string>();
  const startedAt = performance.now();

  for (const group of groups) {
    const entity = ensureEntity(source, cache, group.id);
    nextIds.add(group.id);
    const color = group.domain === 'air'
      ? Color.fromCssColorString('#00D4FF')
      : Color.fromCssColorString('#FF9500');
    patchEntity(entity, {
      name: group.label,
      position: Cartesian3.fromDegrees(group.centroid.longitude, group.centroid.latitude, group.centroid.altitude),
      description: [
        `<p><b>Group:</b> ${group.label}</p>`,
        `<p><b>Members:</b> ${group.memberIds.length}</p>`,
        `<p><b>Cohesion:</b> ${(group.cohesionScore * 100).toFixed(0)}%</p>`,
        `<p><b>Confidence:</b> ${(group.confidence * 100).toFixed(0)}%</p>`,
      ].join(''),
      point: {
        pixelSize: 7,
        color: color.withAlpha(0.9),
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ellipse: {
        semiMajorAxis: Math.max(300, group.dispersionMeters),
        semiMinorAxis: Math.max(300, group.dispersionMeters),
        material: new ColorMaterialProperty(color.withAlpha(0.08)),
        outline: true,
        outlineColor: color.withAlpha(0.55),
        height: 0,
      },
      label: cameraAltitude < 800_000
        ? {
          text: group.label,
          font: '10px monospace',
          fillColor: color,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, -16),
          verticalOrigin: VerticalOrigin.BOTTOM,
          scaleByDistance: new NearFarScalar(5_000, 1, 4_000_000, 0.2),
        }
        : undefined,
    });
  }

  removeMissingEntities(source, cache, nextIds);
  recordLayerPerformance('visualIntelMicro', {
    updateMs: performance.now() - startedAt,
    primitives: cache.size,
    visibleCount: groups.length,
  });
}

function syncMesoGroups(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  groups: MesoGroupTrack[],
  cameraAltitude: number,
) {
  const nextIds = new Set<string>();
  const startedAt = performance.now();

  for (const group of groups) {
    const entity = ensureEntity(source, cache, group.id);
    nextIds.add(group.id);
    const color = group.domain === 'air'
      ? Color.fromCssColorString('#7DF9FF')
      : Color.fromCssColorString('#FFD60A');
    patchEntity(entity, {
      name: group.label,
      position: Cartesian3.fromDegrees(group.centroid.longitude, group.centroid.latitude, group.centroid.altitude),
      description: [
        `<p><b>Group:</b> ${group.label}</p>`,
        `<p><b>Micro Groups:</b> ${group.microGroupIds.length}</p>`,
        `<p><b>Confidence:</b> ${(group.confidence * 100).toFixed(0)}%</p>`,
      ].join(''),
      point: {
        pixelSize: 9,
        color: color.withAlpha(0.9),
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ellipse: {
        semiMajorAxis: Math.max(2_000, group.footprintRadiusMeters),
        semiMinorAxis: Math.max(2_000, group.footprintRadiusMeters),
        material: new ColorMaterialProperty(color.withAlpha(0.04)),
        outline: true,
        outlineColor: color.withAlpha(0.45),
        height: 0,
      },
      label: cameraAltitude < 2_500_000
        ? {
          text: group.label,
          font: '11px monospace',
          fillColor: color,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, -18),
          verticalOrigin: VerticalOrigin.BOTTOM,
          scaleByDistance: new NearFarScalar(5_000, 1, 8_000_000, 0.2),
        }
        : undefined,
    });
  }

  removeMissingEntities(source, cache, nextIds);
  recordLayerPerformance('visualIntelMeso', {
    updateMs: performance.now() - startedAt,
    primitives: cache.size,
    visibleCount: groups.length,
  });
}

function syncClouds(
  collection: PointPrimitiveCollection,
  cache: Map<string, ReturnType<PointPrimitiveCollection['add']>>,
  clouds: ActivityCloud[],
) {
  const nextIds = new Set<string>();
  const startedAt = performance.now();

  for (const cloud of clouds) {
    const color = cloud.domain === 'air'
      ? Color.fromCssColorString('#39FF14')
      : Color.fromCssColorString('#FF9500');

    for (const cell of cloud.cells) {
      const id = `${cloud.id}:${cell.cellId}`;
      nextIds.add(id);
      let primitive = cache.get(id);
      if (!primitive) {
        primitive = collection.add({
          position: Cartesian3.fromDegrees(cell.longitude, cell.latitude, 0),
          pixelSize: 4,
          color,
        });
        cache.set(id, primitive);
      }
      primitive.position = Cartesian3.fromDegrees(cell.longitude, cell.latitude, 0);
      primitive.color = color.withAlpha(Math.max(0.2, cell.density));
      primitive.pixelSize = 4 + Math.round(cell.density * 10);
      primitive.show = true;
    }
  }

  for (const [id, primitive] of cache.entries()) {
    if (nextIds.has(id)) {
      continue;
    }
    collection.remove(primitive);
    cache.delete(id);
  }

  recordLayerPerformance('visualIntelCloud', {
    updateMs: performance.now() - startedAt,
    primitives: cache.size,
    visibleCount: clouds.reduce((sum, cloud) => sum + cloud.cells.length, 0),
  });
}

function addOrUpdatePointEntity(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  id: string,
  name: string,
  point: GlobePoint,
  color: Color,
  labelText?: string,
) {
  const entity = ensureEntity(source, cache, id);
  patchEntity(entity, {
    name,
    position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude),
    point: {
      pixelSize: 8,
      color,
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: labelText
      ? {
        text: labelText,
        font: '10px monospace',
        fillColor: color,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(10, -10),
        scaleByDistance: new NearFarScalar(5_000, 1, 9_000_000, 0.2),
      }
      : undefined,
  });
  return entity;
}

function syncSelection(
  source: CustomDataSource,
  cache: Map<string, Entity>,
  selectionContext: SelectionContext | null,
) {
  const nextIds = new Set<string>();
  const startedAt = performance.now();

  if (selectionContext) {
    const animatePrimaryPath = selectionContext.entityKind === 'track'
      || selectionContext.entityKind === 'micro'
      || selectionContext.entityKind === 'meso';

    const focusId = `${selectionContext.entityId}-focus`;
    nextIds.add(focusId);
    const focusEntity = ensureEntity(source, cache, focusId);
    patchEntity(focusEntity, {
      name: `${selectionContext.entityName} focus`,
      position: Cartesian3.fromDegrees(selectionContext.focus.longitude, selectionContext.focus.latitude, 0),
      ellipse: {
        semiMajorAxis: 18_000,
        semiMinorAxis: 18_000,
        material: new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.08)),
        outline: true,
        outlineColor: Color.fromCssColorString('#00D4FF').withAlpha(0.9),
        height: 0,
      },
    });

    if (selectionContext.altitudeStem) {
      const stemId = `${selectionContext.entityId}-altitude-stem`;
      nextIds.add(stemId);
      const stemEntity = ensureEntity(source, cache, stemId);
      patchEntity(stemEntity, {
        name: 'altitude stem',
        polyline: {
          positions: [
            toCartesian(selectionContext.altitudeStem.from),
            toCartesian(selectionContext.altitudeStem.to),
          ],
          width: 1.5,
          material: new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.35)),
          arcType: ArcType.NONE,
        },
      });
    }

    selectionContext.predictedPaths.forEach((path, index) => {
      const id = `${selectionContext.entityId}-prediction-${index}`;
      nextIds.add(id);
      const entity = ensureEntity(source, cache, id);
      const positions = path.points.map(toCartesian);
      const anchor = positions[positions.length - 1];
      const startedAtTime = JulianDate.now();
      patchEntity(entity, {
        name: `${path.label} prediction`,
        position: anchor,
        polyline: {
          positions: animatePrimaryPath && index === 0
            ? new CallbackProperty((time) => {
              const elapsed = JulianDate.secondsDifference(time ?? JulianDate.now(), startedAtTime);
              const reveal = Math.max(0.15, Math.min(1, elapsed / 0.45));
              const count = Math.max(2, Math.ceil(positions.length * reveal));
              return positions.slice(0, count);
            }, false)
            : positions,
          width: index === 0 ? 3.5 : 2,
          material: index === 0
            ? new ColorMaterialProperty(PATH_COLORS[index % PATH_COLORS.length]!.withAlpha(0.85))
            : new PolylineDashMaterialProperty({
              color: PATH_COLORS[index % PATH_COLORS.length]!.withAlpha(0.75),
              dashLength: 14,
            }),
          arcType: ArcType.NONE,
        },
        label: {
          text: `${path.label} ${(path.confidence * 100).toFixed(0)}%`,
          font: '10px monospace',
          fillColor: PATH_COLORS[index % PATH_COLORS.length]!,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(12, -14),
          scaleByDistance: new NearFarScalar(5_000, 1.1, 10_000_000, 0.2),
        },
      });
    });

    selectionContext.destinationCandidates.forEach((candidate, index) => {
      const id = candidate.id.startsWith('facility-') ? candidate.id : `facility-${candidate.id}`;
      nextIds.add(id);
      const color = PATH_COLORS[index % PATH_COLORS.length]!;
      const entity = addOrUpdatePointEntity(
        source,
        cache,
        id,
        candidate.label,
        toPoint(candidate.latitude, candidate.longitude, candidate.altitude),
        color,
        `${candidate.label} ${(candidate.confidence * 100).toFixed(0)}%`,
      );
      patchEntity(entity, {
        description: [
          `<p><b>Candidate:</b> ${candidate.label}</p>`,
          `<p><b>Confidence:</b> ${(candidate.confidence * 100).toFixed(0)}%</p>`,
          `<p><b>Kind:</b> ${candidate.kind.toUpperCase()}</p>`,
        ].join(''),
      });
    });

    selectionContext.relatedEntities.forEach((entitySummary) => {
      const id = entitySummary.id;
      nextIds.add(id);
      const color = entitySummary.entityType === 'satellite'
        ? Color.fromCssColorString('#39FF14')
        : entitySummary.entityType === 'earthquake'
          ? Color.fromCssColorString('#FF9500')
          : entitySummary.entityType === 'cctv'
            ? Color.fromCssColorString('#FF3B30')
        : entitySummary.entityType === 'facility'
          ? Color.fromCssColorString('#FFD60A')
          : entitySummary.entityType === 'group'
            ? Color.fromCssColorString('#FF9500')
            : Color.fromCssColorString('#00D4FF');
      const entity = addOrUpdatePointEntity(
        source,
        cache,
        id,
        entitySummary.name,
        toPoint(entitySummary.latitude, entitySummary.longitude, entitySummary.altitude),
        color.withAlpha(0.9),
        entitySummary.name,
      );
      patchEntity(entity, {
        description: [
          `<p><b>Entity:</b> ${entitySummary.name}</p>`,
          `<p><b>Type:</b> ${entitySummary.entityType.toUpperCase()}</p>`,
          `<p><b>Confidence:</b> ${(entitySummary.confidence * 100).toFixed(0)}%</p>`,
        ].join(''),
      });
    });

    selectionContext.relationships.forEach((relationship) => {
      const id = relationship.id;
      nextIds.add(id);
      const entity = ensureEntity(source, cache, id);
      patchEntity(entity, {
        name: `${relationship.label} relationship`,
        polyline: {
          positions: relationship.positions.map(toCartesian),
          width: relationship.inferred ? 1.25 : 2,
          material: relationship.inferred
            ? new PolylineDashMaterialProperty({
              color: Color.fromCssColorString('#FF9500').withAlpha(0.7),
              dashLength: 12,
            })
            : new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.55)),
          arcType: ArcType.NONE,
        },
      });
    });

    selectionContext.coverageOverlays.forEach((overlay) => {
      const id = overlay.id;
      nextIds.add(id);
      const entity = ensureEntity(source, cache, id);
      patchEntity(entity, {
        name: `${overlay.label} coverage`,
        position: Cartesian3.fromDegrees(overlay.longitude, overlay.latitude, 0),
        ellipse: {
          semiMajorAxis: overlay.radiusKm * 1000,
          semiMinorAxis: overlay.radiusKm * 1000,
          material: new ColorMaterialProperty(Color.fromCssColorString('#39FF14').withAlpha(0.08)),
          outline: true,
          outlineColor: Color.fromCssColorString('#39FF14').withAlpha(0.75),
          height: 0,
        },
      });
    });

    selectionContext.facilityRings.forEach((ring) => {
      const id = ring.id;
      nextIds.add(id);
      const entity = ensureEntity(source, cache, id);
      patchEntity(entity, {
        name: `${ring.label} influence ring`,
        position: Cartesian3.fromDegrees(ring.longitude, ring.latitude, 0),
        ellipse: {
          semiMajorAxis: ring.radiusKm * 1000,
          semiMinorAxis: ring.radiusKm * 1000,
          material: new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.04)),
          outline: true,
          outlineColor: Color.fromCssColorString('#00D4FF').withAlpha(0.45),
          height: 0,
        },
      });
    });

    selectionContext.anomalyMarkers.forEach((marker) => {
      const id = marker.id;
      nextIds.add(id);
      const color = marker.severity === 'high'
        ? Color.fromCssColorString('#FF3B30')
        : marker.severity === 'medium'
          ? Color.fromCssColorString('#FFD60A')
          : Color.fromCssColorString('#00D4FF');
      const entity = addOrUpdatePointEntity(
        source,
        cache,
        id,
        `${marker.label} anomaly marker`,
        toPoint(marker.latitude, marker.longitude, marker.altitude),
        color,
        marker.label,
      );
      patchEntity(entity, {
        point: {
          pixelSize: 9,
          color,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
  }

  removeMissingEntities(source, cache, nextIds);
  recordLayerPerformance('visualIntelSelection', {
    updateMs: performance.now() - startedAt,
    primitives: cache.size,
    visibleCount: nextIds.size,
  });
}

export default function VisualIntelligenceLayer({
  tieredGroups,
  selectionContext,
  cameraAltitude,
}: VisualIntelligenceLayerProps) {
  const { viewer } = useCesium();
  const microSourceRef = useRef<CustomDataSource | null>(null);
  const mesoSourceRef = useRef<CustomDataSource | null>(null);
  const selectionSourceRef = useRef<CustomDataSource | null>(null);
  const cloudCollectionRef = useRef<PointPrimitiveCollection | null>(null);
  const microEntityCacheRef = useRef(new Map<string, Entity>());
  const mesoEntityCacheRef = useRef(new Map<string, Entity>());
  const selectionEntityCacheRef = useRef(new Map<string, Entity>());
  const cloudPrimitiveCacheRef = useRef(new Map<string, ReturnType<PointPrimitiveCollection['add']>>());

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const microSource = new CustomDataSource('visual-intel-micro');
    const mesoSource = new CustomDataSource('visual-intel-meso');
    const selectionSource = new CustomDataSource('visual-intel-selection');
    const cloudCollection = new PointPrimitiveCollection();

    viewer.dataSources.add(microSource);
    viewer.dataSources.add(mesoSource);
    viewer.dataSources.add(selectionSource);
    viewer.scene.primitives.add(cloudCollection);

    microSourceRef.current = microSource;
    mesoSourceRef.current = mesoSource;
    selectionSourceRef.current = selectionSource;
    cloudCollectionRef.current = cloudCollection;

    return () => {
      if (!viewer.isDestroyed()) {
        void viewer.dataSources.remove(microSource, true);
        void viewer.dataSources.remove(mesoSource, true);
        void viewer.dataSources.remove(selectionSource, true);
        viewer.scene.primitives.remove(cloudCollection);
      }
      microSourceRef.current = null;
      mesoSourceRef.current = null;
      selectionSourceRef.current = null;
      cloudCollectionRef.current = null;
      microEntityCacheRef.current.clear();
      mesoEntityCacheRef.current.clear();
      selectionEntityCacheRef.current.clear();
      cloudPrimitiveCacheRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    if (!microSourceRef.current || !mesoSourceRef.current || !cloudCollectionRef.current) {
      return;
    }

    syncMicroGroups(microSourceRef.current, microEntityCacheRef.current, tieredGroups.microGroups, cameraAltitude);
    syncMesoGroups(mesoSourceRef.current, mesoEntityCacheRef.current, tieredGroups.mesoGroups, cameraAltitude);
    syncClouds(cloudCollectionRef.current, cloudPrimitiveCacheRef.current, tieredGroups.activityClouds);
  }, [cameraAltitude, tieredGroups]);

  useEffect(() => {
    if (!selectionSourceRef.current) {
      return;
    }

    syncSelection(selectionSourceRef.current, selectionEntityCacheRef.current, selectionContext);
  }, [selectionContext]);

  return null;
}
