import type {
  CoverageOverlay,
  DestinationCandidate,
  GlobePoint,
  RelatedEntitySummary,
  RelationshipArc,
  SelectionContext,
} from '../intelligence/visualIntelligence';
import type { OntologyEntity, OntologyEntityDetail } from '../types/ontology';
import type { TrackedEntityInfo, TrackedEntityType } from '../types/trackedEntity';

const DYNAMIC_CANONICAL_TYPES = new Set(['aircraft', 'vessel', 'satellite', 'sensor', 'earthquake']);

function formatIsoTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'N/A';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace('T', ' ').slice(0, 19);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function haversineKm(a: GlobePoint, b: GlobePoint) {
  const earthRadiusKm = 6371;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const term = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const central = 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
  return earthRadiusKm * central;
}

function relationEndpointToPoint(endpoint: {
  latitude: number | null;
  longitude: number | null;
  altitude: number;
}) {
  if (endpoint.latitude == null || endpoint.longitude == null) {
    return null;
  }

  return {
    latitude: endpoint.latitude,
    longitude: endpoint.longitude,
    altitude: endpoint.altitude,
  } satisfies GlobePoint;
}

function buildRelationshipArc(focus: GlobePoint, target: GlobePoint): GlobePoint[] {
  const distanceKm = haversineKm(focus, target);
  const midAltitude = Math.max(
    focus.altitude,
    target.altitude,
    Math.min(450_000, Math.max(15_000, distanceKm * 2200)),
  );

  return [
    focus,
    {
      latitude: (focus.latitude + target.latitude) / 2,
      longitude: (focus.longitude + target.longitude) / 2,
      altitude: midAltitude,
    },
    target,
  ];
}

function mapCanonicalTypeToRelatedEntityType(canonicalType: string): RelatedEntitySummary['entityType'] {
  switch (canonicalType) {
    case 'aircraft':
      return 'aircraft';
    case 'vessel':
      return 'ship';
    case 'satellite':
      return 'satellite';
    case 'sensor':
      return 'cctv';
    case 'earthquake':
      return 'earthquake';
    default:
      return 'facility';
  }
}

function buildDestinationCandidates(detail: OntologyEntityDetail) {
  const candidates: DestinationCandidate[] = [];

  for (const relation of detail.relations) {
    const endpoint = relation.sourceEntityId === detail.id ? relation.target : relation.source;
    if (endpoint.latitude == null || endpoint.longitude == null) {
      continue;
    }

    if (endpoint.canonicalType === 'airport') {
      candidates.push({
        id: endpoint.id,
        label: endpoint.label,
        latitude: endpoint.latitude,
        longitude: endpoint.longitude,
        altitude: endpoint.altitude,
        confidence: relation.confidence,
        kind: 'airport',
      });
      continue;
    }

    if (endpoint.canonicalType === 'port' || endpoint.canonicalType === 'facility') {
      candidates.push({
        id: endpoint.id,
        label: endpoint.label,
        latitude: endpoint.latitude,
        longitude: endpoint.longitude,
        altitude: endpoint.altitude,
        confidence: relation.confidence,
        kind: 'facility',
      });
    }
  }

  return dedupeById(candidates).slice(0, 6);
}

function buildCoverageOverlays(detail: OntologyEntityDetail, focus: GlobePoint) {
  const overlays = detail.relations.flatMap((relation) => {
    const coverageRadiusKm = Number(relation.metadata.coverageRadiusKm);
    if (!Number.isFinite(coverageRadiusKm) || coverageRadiusKm <= 0) {
      return [];
    }

    return [{
      id: `${relation.id}-coverage`,
      label: relation.relationType.replace(/_/g, ' '),
      latitude: focus.latitude,
      longitude: focus.longitude,
      radiusKm: coverageRadiusKm,
      confidence: relation.confidence,
    } satisfies CoverageOverlay];
  });

  if (overlays.length > 0) {
    return dedupeById(overlays).slice(0, 3);
  }

  const altitudeKm = Number(detail.metadata.altitudeKm);
  if (!Number.isFinite(altitudeKm) || altitudeKm <= 0) {
    return [];
  }

  const radiusKm = Math.sqrt(Math.max((6371 + altitudeKm) ** 2 - 6371 ** 2, 0));
  return [{
    id: `${detail.id}-coverage`,
    label: 'coverage radius',
    latitude: focus.latitude,
    longitude: focus.longitude,
    radiusKm: clamp(radiusKm, 10, 20_000),
    confidence: clamp(detail.confidence, 0.45, 0.9),
  }];
}

function buildOntologyRelations(detail: OntologyEntityDetail, focus: GlobePoint) {
  const relatedEntities: RelatedEntitySummary[] = [];
  const relationships: RelationshipArc[] = [];

  for (const relation of detail.relations.slice(0, 12)) {
    const endpoint = relation.sourceEntityId === detail.id ? relation.target : relation.source;
    const endpointPoint = relationEndpointToPoint(endpoint);
    if (!endpointPoint) {
      continue;
    }

    relatedEntities.push({
      id: endpoint.id,
      name: endpoint.label,
      entityType: mapCanonicalTypeToRelatedEntityType(endpoint.canonicalType),
      latitude: endpointPoint.latitude,
      longitude: endpointPoint.longitude,
      altitude: endpointPoint.altitude,
      confidence: relation.confidence,
    });

    relationships.push({
      id: relation.id,
      sourceId: detail.id,
      targetId: endpoint.id,
      label: relation.relationType.replace(/_/g, ' '),
      inferred: relation.ruleName !== 'manual',
      confidence: relation.confidence,
      positions: buildRelationshipArc(focus, endpointPoint),
    });
  }

  return {
    relatedEntities: dedupeById(relatedEntities),
    relationships: dedupeById(relationships),
  };
}

function mergeUniqueById<T extends { id: string }>(base: T[], next: T[]) {
  return dedupeById([...base, ...next]);
}

export function ontologyCanonicalTypeToTrackedType(canonicalType: string): TrackedEntityType {
  switch (canonicalType) {
    case 'aircraft':
      return 'aircraft';
    case 'vessel':
      return 'ship';
    case 'satellite':
      return 'satellite';
    case 'sensor':
      return 'cctv';
    case 'earthquake':
      return 'earthquake';
    default:
      return 'facility';
  }
}

export function isOntologyMapRenderable(entity: OntologyEntity) {
  return !DYNAMIC_CANONICAL_TYPES.has(entity.canonicalType);
}

export function getOntologyEntityFocus(entity: Pick<OntologyEntity, 'geometry'>): GlobePoint | null {
  if (entity.geometry.latitude != null && entity.geometry.longitude != null) {
    return {
      latitude: entity.geometry.latitude,
      longitude: entity.geometry.longitude,
      altitude: entity.geometry.altitude ?? 0,
    };
  }

  const points = Array.isArray(entity.geometry.data.points)
    ? entity.geometry.data.points as Array<Record<string, unknown>>
    : [];

  if (points.length === 0) {
    return null;
  }

  let latitudeSum = 0;
  let longitudeSum = 0;
  let altitudeSum = 0;
  let count = 0;
  for (const point of points) {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    const altitude = Number(point.altitude ?? 0);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }
    latitudeSum += latitude;
    longitudeSum += longitude;
    altitudeSum += altitude;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    latitude: latitudeSum / count,
    longitude: longitudeSum / count,
    altitude: altitudeSum / count,
  };
}

export function buildOntologyEntityDescription(entity: Pick<OntologyEntity, 'canonicalType' | 'subtype' | 'origin' | 'confidence' | 'countryCode' | 'operator' | 'sourceCount' | 'observationCount' | 'lastObservedAt'>) {
  return [
    `<b>Canonical Type:</b> ${entity.canonicalType.toUpperCase()}`,
    `<b>Subtype:</b> ${entity.subtype || 'N/A'}`,
    `<b>Origin:</b> ${entity.origin.toUpperCase()}`,
    `<b>Confidence:</b> ${Math.round(entity.confidence * 100)}%`,
    `<b>Country:</b> ${entity.countryCode || 'N/A'}`,
    `<b>Operator:</b> ${entity.operator || 'N/A'}`,
    `<b>Sources:</b> ${entity.sourceCount}`,
    `<b>Observations:</b> ${entity.observationCount}`,
    `<b>Last Seen:</b> ${formatIsoTimestamp(entity.lastObservedAt)}`,
  ].join('<br/>');
}

export function buildOntologyTrackedEntityInfo(entity: OntologyEntity | OntologyEntityDetail): TrackedEntityInfo {
  return {
    id: entity.id,
    name: entity.label,
    entityType: ontologyCanonicalTypeToTrackedType(entity.canonicalType),
    description: buildOntologyEntityDescription(entity),
  };
}

export function mergeOntologySelectionContext(
  baseContext: SelectionContext | null,
  trackedEntity: TrackedEntityInfo | null,
  ontologyDetail: OntologyEntityDetail | null,
): SelectionContext | null {
  if (!trackedEntity || !ontologyDetail || trackedEntity.id !== ontologyDetail.id) {
    return baseContext;
  }

  const focus = getOntologyEntityFocus(ontologyDetail);
  if (!focus) {
    return baseContext;
  }

  const derived = buildOntologyRelations(ontologyDetail, focus);
  const destinationCandidates = buildDestinationCandidates(ontologyDetail);
  const coverageOverlays = buildCoverageOverlays(ontologyDetail, focus);
  const entityKind = trackedEntity.entityType === 'facility' || trackedEntity.entityType === 'cctv'
    ? 'facility'
    : trackedEntity.entityType === 'satellite'
      ? 'satellite'
      : 'track';
  const altitudeStem = focus.altitude > 100
    ? {
      from: focus,
      to: {
        latitude: focus.latitude,
        longitude: focus.longitude,
        altitude: 0,
      },
    }
    : null;

  if (!baseContext) {
    return {
      entityId: trackedEntity.id,
      entityKind,
      entityType: trackedEntity.entityType,
      entityName: ontologyDetail.label,
      focus,
      altitudeStem,
      predictedPaths: [],
      destinationCandidates,
      relatedEntities: derived.relatedEntities,
      relationships: derived.relationships,
      coverageOverlays,
      facilityRings: [],
      anomalyMarkers: [],
      relatedMicroGroups: [],
      relatedMesoGroups: [],
      relatedClouds: [],
      representativeTrackIds: [],
      childMicroGroupIds: [],
      topCells: [],
    };
  }

  return {
    ...baseContext,
    entityName: ontologyDetail.label,
    focus,
    altitudeStem: baseContext.altitudeStem ?? altitudeStem,
    destinationCandidates: mergeUniqueById(baseContext.destinationCandidates, destinationCandidates),
    relatedEntities: mergeUniqueById(baseContext.relatedEntities, derived.relatedEntities),
    relationships: mergeUniqueById(baseContext.relationships, derived.relationships),
    coverageOverlays: mergeUniqueById(baseContext.coverageOverlays, coverageOverlays),
  };
}
