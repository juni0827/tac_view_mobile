import { apiFetch } from '../runtime/bootstrap';
import type {
  OntologyEntity,
  OntologyEntityDetail,
  OntologyEvidence,
  OntologyLayerDefinition,
  OntologyPreset,
  OntologyRelation,
  OntologySearchFilters,
} from '../types/ontology';

export interface OntologySearchParams extends Partial<OntologySearchFilters> {
  q?: string;
  limit?: number;
  layerIds?: string[];
  bbox?: {
    south: number;
    west: number;
    north: number;
    east: number;
  } | null;
  includeSynthetic?: boolean;
}

function appendBbox(params: URLSearchParams, bbox: OntologySearchParams['bbox']) {
  if (!bbox) {
    return;
  }
  params.set('south', String(bbox.south));
  params.set('west', String(bbox.west));
  params.set('north', String(bbox.north));
  params.set('east', String(bbox.east));
}

export async function searchOntologyEntities(search: OntologySearchParams) {
  const params = new URLSearchParams();
  if (search.q) params.set('q', search.q);
  if (search.limit) params.set('limit', String(search.limit));
  if (search.layerIds && search.layerIds.length > 0) params.set('layers', search.layerIds.join(','));
  if (search.canonicalTypes && search.canonicalTypes.length > 0) params.set('types', search.canonicalTypes.join(','));
  if (search.source) params.set('source', search.source);
  if (search.country) params.set('country', search.country);
  if (typeof search.minConfidence === 'number') params.set('minConfidence', String(search.minConfidence));
  if (typeof search.freshnessHours === 'number' && search.freshnessHours > 0) params.set('freshnessHours', String(search.freshnessHours));
  if (search.includeSynthetic) params.set('includeSynthetic', '1');
  appendBbox(params, search.bbox ?? null);

  const res = await apiFetch(`/ontology/search?${params}`);
  if (!res.ok) {
    throw new Error(`Ontology search HTTP ${res.status}`);
  }
  const payload: { items: OntologyEntity[] } = await res.json();
  return payload.items;
}

export async function fetchOntologyEntity(entityId: string) {
  const res = await apiFetch(`/ontology/entities/${encodeURIComponent(entityId)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Ontology entity HTTP ${res.status}`);
  }
  return res.json() as Promise<OntologyEntityDetail>;
}

export async function fetchOntologyEvidence(entityId: string, page = 1, pageSize = 20) {
  const res = await apiFetch(`/ontology/entities/${encodeURIComponent(entityId)}/evidence?page=${page}&pageSize=${pageSize}`);
  if (!res.ok) {
    throw new Error(`Ontology evidence HTTP ${res.status}`);
  }
  const payload: { items: OntologyEvidence[] } = await res.json();
  return payload.items;
}

export async function fetchOntologyLayers() {
  const res = await apiFetch('/ontology/layers');
  if (!res.ok) {
    throw new Error(`Ontology layers HTTP ${res.status}`);
  }
  const payload: { items: OntologyLayerDefinition[] } = await res.json();
  return payload.items;
}

export async function fetchOntologyRelations(entityId?: string) {
  const params = new URLSearchParams();
  if (entityId) params.set('entityId', entityId);
  const res = await apiFetch(`/ontology/relations?${params}`);
  if (!res.ok) {
    throw new Error(`Ontology relations HTTP ${res.status}`);
  }
  const payload: { items: OntologyRelation[] } = await res.json();
  return payload.items;
}

export async function fetchOntologyPresets() {
  const res = await apiFetch('/ontology/presets');
  if (!res.ok) {
    throw new Error(`Ontology presets HTTP ${res.status}`);
  }
  const payload: { items: OntologyPreset[] } = await res.json();
  return payload.items;
}

export async function saveOntologyPreset(input: {
  id?: string;
  name: string;
  description?: string;
  filters: Record<string, unknown>;
  layerIds: string[];
}) {
  const res = await apiFetch('/ontology/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: 'Preset save failed' }));
    throw new Error(payload.error || `Ontology preset HTTP ${res.status}`);
  }
  return res.json() as Promise<OntologyPreset>;
}

export async function syncOntologySnapshot(payload: Record<string, unknown>) {
  const res = await apiFetch('/ontology/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Ontology sync failed' }));
    throw new Error(body.error || `Ontology sync HTTP ${res.status}`);
  }
  return res.json() as Promise<{ ok: boolean; recordCount: number; impactedEntityCount: number }>;
}
