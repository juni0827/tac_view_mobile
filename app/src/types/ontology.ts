export type OntologyEntityOrigin = 'observed' | 'derived' | 'synthetic';

export interface OntologyGeometry {
  type: 'Point' | 'LineString' | string;
  latitude: number | null;
  longitude: number | null;
  altitude: number;
  bbox: {
    south?: number;
    west?: number;
    north?: number;
    east?: number;
  };
  data: Record<string, unknown>;
}

export interface OntologyEntity {
  id: string;
  canonicalType: string;
  subtype: string | null;
  label: string;
  origin: OntologyEntityOrigin;
  confidence: number;
  countryCode: string | null;
  operator: string | null;
  sourceCount: number;
  observationCount: number;
  lastObservedAt: string | null;
  layerIds: string[];
  geometry: OntologyGeometry;
  metadata: Record<string, unknown>;
}

export interface OntologyObservation {
  id: string;
  connectorName: string;
  sourceName: string;
  sourceRecordId: string;
  sourceUrl: string | null;
  fetchedAt: string;
  validAt: string | null;
  metadata: Record<string, unknown>;
}

export interface OntologyRelationEndpoint {
  id: string;
  label: string;
  canonicalType: string;
  latitude: number | null;
  longitude: number | null;
  altitude: number;
}

export interface OntologyRelation {
  id: string;
  relationType: string;
  sourceEntityId: string;
  targetEntityId: string;
  confidence: number;
  ruleName: string;
  metadata: Record<string, unknown>;
  source: OntologyRelationEndpoint;
  target: OntologyRelationEndpoint;
}

export interface OntologyEvidence {
  id: string;
  kind: 'observation' | 'relation';
  connectorName?: string;
  sourceName?: string;
  sourceRecordId?: string;
  sourceUrl?: string | null;
  recordedAt: string;
  metadata?: Record<string, unknown>;
  relationId?: string;
  relationType?: string;
  observationId?: string;
  evidenceType?: string;
  description?: string;
  sourceEntityId?: string;
  targetEntityId?: string;
}

export interface OntologyEntityDetail extends OntologyEntity {
  aliases: Array<{ alias: string; source_name: string | null }>;
  aliasList: string[];
  observations: OntologyObservation[];
  sourceConnectors: string[];
  relations: OntologyRelation[];
}

export interface OntologyLayerDefinition {
  id: string;
  label: string;
  category: string;
  description: string;
  sourceName: string;
  entityTypes: string[];
  defaultEnabled: boolean;
  style: Record<string, unknown>;
  refreshIntervalSeconds: number;
  entityCount: number;
}

export interface OntologyPreset {
  id: string;
  name: string;
  description: string;
  filters: Record<string, unknown>;
  layerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OntologySearchFilters {
  canonicalTypes: string[];
  source: string;
  country: string;
  minConfidence: number;
  freshnessHours: number;
  radiusKm: number;
}
