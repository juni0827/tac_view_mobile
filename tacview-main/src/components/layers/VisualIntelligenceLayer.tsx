import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Entity,
  EllipseGraphics,
  LabelGraphics,
  PointGraphics,
  PolygonGraphics,
  PolylineGraphics,
} from 'resium';
import {
  ArcType,
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  LabelStyle,
  NearFarScalar,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  VerticalOrigin,
} from 'cesium';
import type {
  AnomalyMarker,
  CoverageOverlay,
  DetectedGroup,
  DestinationCandidate,
  FacilityRing,
  GlobePoint,
  PredictedPath,
  RelatedEntitySummary,
  RelationshipArc,
  SelectionContext,
} from '../../intelligence/visualIntelligence';

interface VisualIntelligenceLayerProps {
  groups: DetectedGroup[];
  selectionContext: SelectionContext | null;
}

const PATH_COLORS = [
  Color.fromCssColorString('#00D4FF'),
  Color.fromCssColorString('#39FF14'),
  Color.fromCssColorString('#FF9500'),
];

export default function VisualIntelligenceLayer({
  groups,
  selectionContext,
}: VisualIntelligenceLayerProps) {
  return (
    <>
      {groups.map((group) => (
        <GroupOverlayEntity key={group.id} group={group} />
      ))}

      {selectionContext && (
        <>
          <SelectionFocusEntity context={selectionContext} />
          {selectionContext.altitudeStem && (
            <SelectionStemEntity stem={selectionContext.altitudeStem} entityId={selectionContext.entityId} />
          )}
          {selectionContext.predictedPaths.map((path, index) => (
            <AnimatedPredictionPath
              key={path.id}
              entityId={selectionContext.entityId}
              path={path}
              color={PATH_COLORS[index % PATH_COLORS.length]}
              index={index}
            />
          ))}
          {selectionContext.destinationCandidates.map((candidate, index) => (
            <DestinationCandidateEntity key={candidate.id} candidate={candidate} index={index} />
          ))}
          {selectionContext.relatedEntities.map((entity) => (
            <RelatedEntityMarker key={entity.id} entity={entity} />
          ))}
          {selectionContext.relationships.map((relationship) => (
            <RelationshipEntity key={relationship.id} relationship={relationship} />
          ))}
          {selectionContext.coverageOverlays.map((overlay) => (
            <CoverageEntity key={overlay.id} overlay={overlay} />
          ))}
          {selectionContext.facilityRings.map((ring) => (
            <FacilityRingEntity key={ring.id} ring={ring} />
          ))}
          {selectionContext.anomalyMarkers.map((marker) => (
            <AnomalyEntity key={marker.id} marker={marker} />
          ))}
        </>
      )}
    </>
  );
}

const GroupOverlayEntity = memo(function GroupOverlayEntity({ group }: { group: DetectedGroup }) {
  const centroid = useMemo(
    () => Cartesian3.fromDegrees(group.centroid.longitude, group.centroid.latitude, group.centroid.altitude),
    [group.centroid.altitude, group.centroid.latitude, group.centroid.longitude],
  );
  const hierarchy = useMemo(
    () => new PolygonHierarchy(group.hull.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude))),
    [group.hull],
  );
  const color = group.groupType === 'aircraft'
    ? Color.fromCssColorString('#00D4FF')
    : Color.fromCssColorString('#FF9500');

  return (
    <Entity
      id={group.id}
      name={group.label}
      position={centroid}
      description={[
        `<p><b>Group:</b> ${group.label}</p>`,
        `<p><b>Members:</b> ${group.memberIds.length}</p>`,
        `<p><b>Confidence:</b> ${(group.confidence * 100).toFixed(0)}%</p>`,
      ].join('')}
      point={{
        pixelSize: 1,
        color: Color.TRANSPARENT,
      }}
    >
      <PolygonGraphics
        hierarchy={hierarchy}
        material={new ColorMaterialProperty(color.withAlpha(0.08))}
        outline={true}
        outlineColor={color.withAlpha(0.65)}
        perPositionHeight={false}
      />
      <LabelGraphics
        text={group.label}
        font="11px monospace"
        fillColor={color}
        outlineColor={Color.BLACK}
        outlineWidth={3}
        style={LabelStyle.FILL_AND_OUTLINE}
        pixelOffset={new Cartesian2(0, -18)}
        verticalOrigin={VerticalOrigin.BOTTOM}
        scaleByDistance={new NearFarScalar(5_000, 1.0, 8_000_000, 0.25)}
      />
    </Entity>
  );
});

function SelectionFocusEntity({ context }: { context: SelectionContext }) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(context.focus.longitude, context.focus.latitude, 0),
    [context.focus.latitude, context.focus.longitude],
  );

  return (
    <Entity
      id={`${context.entityId}-focus`}
      name={`${context.entityName} focus`}
      position={position}
    >
      <EllipseGraphics
        semiMajorAxis={18_000}
        semiMinorAxis={18_000}
        material={new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.08))}
        outline={true}
        outlineColor={Color.fromCssColorString('#00D4FF').withAlpha(0.9)}
        height={0}
      />
    </Entity>
  );
}

function SelectionStemEntity({
  entityId,
  stem,
}: {
  entityId: string;
  stem: { from: GlobePoint; to: GlobePoint };
}) {
  const positions = useMemo(
    () => [
      Cartesian3.fromDegrees(stem.from.longitude, stem.from.latitude, stem.from.altitude),
      Cartesian3.fromDegrees(stem.to.longitude, stem.to.latitude, stem.to.altitude),
    ],
    [stem.from.altitude, stem.from.latitude, stem.from.longitude, stem.to.altitude, stem.to.latitude, stem.to.longitude],
  );

  return (
    <Entity id={`${entityId}-altitude-stem`} name="altitude stem">
      <PolylineGraphics
        positions={positions}
        width={1.5}
        material={new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.35))}
        arcType={ArcType.NONE}
      />
    </Entity>
  );
}

function DestinationCandidateEntity({
  candidate,
  index,
}: {
  candidate: DestinationCandidate;
  index: number;
}) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(candidate.longitude, candidate.latitude, candidate.altitude),
    [candidate.altitude, candidate.latitude, candidate.longitude],
  );
  const color = PATH_COLORS[index % PATH_COLORS.length];
  const entityId = candidate.id.startsWith('facility-') ? candidate.id : `facility-${candidate.id}`;

  return (
    <Entity
      id={entityId}
      name={candidate.label}
      position={position}
      description={[
        `<p><b>Candidate:</b> ${candidate.label}</p>`,
        `<p><b>Confidence:</b> ${(candidate.confidence * 100).toFixed(0)}%</p>`,
        `<p><b>Kind:</b> ${candidate.kind.toUpperCase()}</p>`,
      ].join('')}
      point={{
        pixelSize: 1,
        color: Color.TRANSPARENT,
      }}
    >
      <PointGraphics color={color} pixelSize={10} outlineColor={Color.BLACK} outlineWidth={2} />
      <LabelGraphics
        text={`${candidate.label} ${(candidate.confidence * 100).toFixed(0)}%`}
        font="10px monospace"
        fillColor={color}
        outlineColor={Color.BLACK}
        outlineWidth={3}
        style={LabelStyle.FILL_AND_OUTLINE}
        pixelOffset={new Cartesian2(12, -12)}
        scaleByDistance={new NearFarScalar(5_000, 1.1, 9_000_000, 0.2)}
      />
    </Entity>
  );
}

function RelatedEntityMarker({ entity }: { entity: RelatedEntitySummary }) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(entity.longitude, entity.latitude, entity.altitude),
    [entity.altitude, entity.latitude, entity.longitude],
  );
  const color = entity.entityType === 'satellite'
    ? Color.fromCssColorString('#39FF14')
    : entity.entityType === 'facility'
      ? Color.fromCssColorString('#FFD60A')
      : entity.entityType === 'group'
        ? Color.fromCssColorString('#FF9500')
        : Color.fromCssColorString('#00D4FF');

  return (
    <Entity
      id={entity.id}
      name={entity.name}
      position={position}
      description={[
        `<p><b>Entity:</b> ${entity.name}</p>`,
        `<p><b>Type:</b> ${entity.entityType.toUpperCase()}</p>`,
        `<p><b>Confidence:</b> ${(entity.confidence * 100).toFixed(0)}%</p>`,
      ].join('')}
      point={{
        pixelSize: 1,
        color: Color.TRANSPARENT,
      }}
    >
      <PointGraphics
        color={color.withAlpha(0.9)}
        pixelSize={entity.entityType === 'group' ? 10 : 7}
        outlineColor={Color.BLACK}
        outlineWidth={2}
      />
      <LabelGraphics
        text={entity.name}
        font="10px monospace"
        fillColor={color}
        outlineColor={Color.BLACK}
        outlineWidth={3}
        style={LabelStyle.FILL_AND_OUTLINE}
        pixelOffset={new Cartesian2(10, -10)}
        scaleByDistance={new NearFarScalar(5_000, 1.0, 9_000_000, 0.2)}
      />
    </Entity>
  );
}

function RelationshipEntity({ relationship }: { relationship: RelationshipArc }) {
  const positions = useMemo(
    () => relationship.positions.map((point) =>
      Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude),
    ),
    [relationship.positions],
  );
  const color = relationship.inferred
    ? Color.fromCssColorString('#FF9500')
    : Color.fromCssColorString('#00D4FF');

  return (
    <Entity id={relationship.id} name={`${relationship.label} relationship`}>
      <PolylineGraphics
        positions={positions}
        width={relationship.inferred ? 1.25 : 2}
        material={relationship.inferred
          ? new PolylineDashMaterialProperty({ color: color.withAlpha(0.7), dashLength: 12 })
          : new ColorMaterialProperty(color.withAlpha(0.55))}
        arcType={ArcType.NONE}
      />
    </Entity>
  );
}

function CoverageEntity({ overlay }: { overlay: CoverageOverlay }) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(overlay.longitude, overlay.latitude, 0),
    [overlay.latitude, overlay.longitude],
  );

  return (
    <Entity id={overlay.id} name={`${overlay.label} coverage`} position={position}>
      <EllipseGraphics
        semiMajorAxis={overlay.radiusKm * 1000}
        semiMinorAxis={overlay.radiusKm * 1000}
        material={new ColorMaterialProperty(Color.fromCssColorString('#39FF14').withAlpha(0.08))}
        outline={true}
        outlineColor={Color.fromCssColorString('#39FF14').withAlpha(0.75)}
        height={0}
      />
    </Entity>
  );
}

function FacilityRingEntity({ ring }: { ring: FacilityRing }) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(ring.longitude, ring.latitude, 0),
    [ring.latitude, ring.longitude],
  );

  return (
    <Entity id={ring.id} name={`${ring.label} influence ring`} position={position}>
      <EllipseGraphics
        semiMajorAxis={ring.radiusKm * 1000}
        semiMinorAxis={ring.radiusKm * 1000}
        material={new ColorMaterialProperty(Color.fromCssColorString('#00D4FF').withAlpha(0.04))}
        outline={true}
        outlineColor={Color.fromCssColorString('#00D4FF').withAlpha(0.45)}
        height={0}
      />
    </Entity>
  );
}

function AnomalyEntity({ marker }: { marker: AnomalyMarker }) {
  const position = useMemo(
    () => Cartesian3.fromDegrees(marker.longitude, marker.latitude, marker.altitude),
    [marker.altitude, marker.latitude, marker.longitude],
  );
  const color = marker.severity === 'high'
    ? Color.fromCssColorString('#FF3B30')
    : marker.severity === 'medium'
      ? Color.fromCssColorString('#FF9500')
      : Color.fromCssColorString('#FFD60A');

  return (
    <Entity id={marker.id} name={`${marker.label} anomaly marker`} position={position}>
      <PointGraphics color={color} pixelSize={8} outlineColor={Color.WHITE} outlineWidth={1.5} />
      <LabelGraphics
        text={marker.label}
        font="10px monospace"
        fillColor={color}
        outlineColor={Color.BLACK}
        outlineWidth={3}
        style={LabelStyle.FILL_AND_OUTLINE}
        pixelOffset={new Cartesian2(0, -16)}
      />
    </Entity>
  );
}

function AnimatedPredictionPath({
  entityId,
  path,
  color,
  index,
}: {
  entityId: string;
  path: PredictedPath;
  color: Color;
  index: number;
}) {
  const [renderPoints, setRenderPoints] = useState(path.points);
  const renderPointsRef = useRef(path.points);

  useEffect(() => {
    renderPointsRef.current = renderPoints;
  }, [renderPoints]);

  useEffect(() => {
    const start = renderPointsRef.current;
    const target = path.points;
    if (target.length === 0) {
      const animationFrame = window.requestAnimationFrame(() => {
        renderPointsRef.current = target;
        setRenderPoints(target);
      });
      return () => window.cancelAnimationFrame(animationFrame);
    }

    const hasShapeChanged = start.length !== target.length;
    if (hasShapeChanged) {
      renderPointsRef.current = target;
      const animationFrame = window.requestAnimationFrame(() => {
        setRenderPoints(target);
      });
      return () => window.cancelAnimationFrame(animationFrame);
    }

    let animationFrame = 0;
    const startedAt = performance.now();

    const animate = (now: number) => {
      const progress = Math.min((now - startedAt) / 450, 1);
      const interpolated = target.map((targetPoint, pointIndex) => {
        const previousPoint = start[pointIndex] ?? targetPoint;
        return {
          latitude: previousPoint.latitude + (targetPoint.latitude - previousPoint.latitude) * progress,
          longitude: previousPoint.longitude + (targetPoint.longitude - previousPoint.longitude) * progress,
          altitude: previousPoint.altitude + (targetPoint.altitude - previousPoint.altitude) * progress,
        };
      });

      renderPointsRef.current = interpolated;
      setRenderPoints(interpolated);

      if (progress < 1) {
        animationFrame = window.requestAnimationFrame(animate);
      }
    };

    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [path.points]);

  const positions = useMemo(
    () => renderPoints.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude)),
    [renderPoints],
  );
  const anchor = renderPoints[renderPoints.length - 1] ?? path.points[path.points.length - 1];
  const labelPosition = useMemo(
    () => Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.altitude),
    [anchor.altitude, anchor.latitude, anchor.longitude],
  );

  return (
    <Entity
      id={`${entityId}-prediction-${index}`}
      name={`${path.label} prediction`}
      position={labelPosition}
    >
      <PolylineGraphics
        positions={positions}
        width={index === 0 ? 3.5 : 2}
        material={index === 0
          ? new ColorMaterialProperty(color.withAlpha(0.85))
          : new PolylineDashMaterialProperty({ color: color.withAlpha(0.75), dashLength: 14 })}
        arcType={ArcType.NONE}
      />
      <LabelGraphics
        text={`${path.label} ${(path.confidence * 100).toFixed(0)}%`}
        font="10px monospace"
        fillColor={color}
        outlineColor={Color.BLACK}
        outlineWidth={3}
        style={LabelStyle.FILL_AND_OUTLINE}
        pixelOffset={new Cartesian2(12, -14)}
        scaleByDistance={new NearFarScalar(5_000, 1.1, 10_000_000, 0.2)}
      />
    </Entity>
  );
}
