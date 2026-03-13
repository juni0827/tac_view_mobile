import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RenderCameraState } from '../types/rendering';
import type {
  OntologyEntity,
  OntologyEntityDetail,
  OntologyLayerDefinition,
  OntologyPreset,
  OntologySearchFilters,
} from '../types/ontology';
import {
  fetchOntologyEntity,
  fetchOntologyEvidence,
  fetchOntologyLayers,
  fetchOntologyPresets,
  saveOntologyPreset,
  searchOntologyEntities,
} from './api';
import { calculateRadiusBbox, filterEntitiesByRadius } from './spatial';

const DEFAULT_FILTERS: OntologySearchFilters = {
  canonicalTypes: [],
  source: '',
  country: '',
  minConfidence: 0.45,
  freshnessHours: 24,
  radiusKm: 160,
};

export function useOntologyWorkbench(camera: RenderCameraState, trackedEntityId: string | null) {
  const [layers, setLayers] = useState<OntologyLayerDefinition[]>([]);
  const [activeLayerIds, setActiveLayerIds] = useState<string[]>([]);
  const [filters, setFilters] = useState<OntologySearchFilters>(DEFAULT_FILTERS);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResultsState, setSearchResultsState] = useState<OntologyEntity[]>([]);
  const [mapEntitiesState, setMapEntitiesState] = useState<OntologyEntity[]>([]);
  const [selectedEntityId, setSelectedEntityIdState] = useState<string | null>(null);
  const [selectedEntityState, setSelectedEntityState] = useState<OntologyEntityDetail | null>(null);
  const [selectedEvidenceState, setSelectedEvidenceState] = useState<Awaited<ReturnType<typeof fetchOntologyEvidence>>>([]);
  const [trackedEntityDetailState, setTrackedEntityDetailState] = useState<OntologyEntityDetail | null>(null);
  const [presets, setPresets] = useState<OntologyPreset[]>([]);
  const [loadingLayers, setLoadingLayers] = useState(true);
  const [loadingSelectedState, setLoadingSelectedState] = useState(false);

  const bbox = useMemo(
    () => calculateRadiusBbox(camera.latitude, camera.longitude, filters.radiusKm),
    [camera.latitude, camera.longitude, filters.radiusKm],
  );
  const trimmedSearchQuery = searchQuery.trim();
  const hasActiveLayers = activeLayerIds.length > 0;
  const selectEntityId = useCallback((nextEntityId: string | null) => {
    if (selectedEntityId === nextEntityId) {
      return;
    }

    setSelectedEntityState(null);
    setSelectedEvidenceState([]);
    setSelectedEntityIdState(nextEntityId);
    setLoadingSelectedState(Boolean(nextEntityId));
  }, [selectedEntityId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchOntologyLayers(), fetchOntologyPresets()])
      .then(([nextLayers, nextPresets]) => {
        if (cancelled) return;
        setLayers(nextLayers);
        setPresets(nextPresets);
        setActiveLayerIds((current) =>
          current.length > 0 ? current : nextLayers.filter((layer) => layer.defaultEnabled).map((layer) => layer.id),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingLayers(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!trimmedSearchQuery) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void searchOntologyEntities({
        q: trimmedSearchQuery,
        limit: 24,
        canonicalTypes: filters.canonicalTypes,
        source: filters.source,
        country: filters.country,
        minConfidence: filters.minConfidence,
        freshnessHours: filters.freshnessHours,
        includeSynthetic: false,
      }).then((items) => {
        if (!cancelled) {
          setSearchResultsState(items);
        }
      }).catch((error) => {
        console.warn('[ONTOLOGY] Search request failed:', error);
      });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    filters.canonicalTypes,
    filters.country,
    filters.freshnessHours,
    filters.minConfidence,
    filters.source,
    trimmedSearchQuery,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!hasActiveLayers) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void searchOntologyEntities({
        limit: 300,
        layerIds: activeLayerIds,
        bbox,
        canonicalTypes: filters.canonicalTypes,
        source: filters.source,
        country: filters.country,
        minConfidence: filters.minConfidence,
        freshnessHours: filters.freshnessHours,
      }).then((items) => {
        if (!cancelled) {
          setMapEntitiesState(filterEntitiesByRadius(items, camera.latitude, camera.longitude, filters.radiusKm));
        }
      }).catch((error) => {
        console.warn('[ONTOLOGY] Map entity request failed:', error);
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeLayerIds, bbox, camera.latitude, camera.longitude, filters, hasActiveLayers]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedEntityId) {
      return;
    }

    void Promise.all([
      fetchOntologyEntity(selectedEntityId),
      fetchOntologyEvidence(selectedEntityId, 1, 40),
    ]).then(([detail, evidence]) => {
      if (!cancelled) {
        setSelectedEntityState(detail);
        setSelectedEvidenceState(evidence);
      }
    }).catch((error) => {
      console.warn('[ONTOLOGY] Selected entity fetch failed:', error);
    }).finally(() => {
      if (!cancelled) {
        setLoadingSelectedState(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedEntityId]);

  useEffect(() => {
    let cancelled = false;
    if (!trackedEntityId) {
      return;
    }

    void fetchOntologyEntity(trackedEntityId)
      .then((detail) => {
        if (!cancelled) {
          setTrackedEntityDetailState(detail);
        }
      })
      .catch((error) => {
        console.warn('[ONTOLOGY] Tracked entity detail fetch failed:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [trackedEntityId]);

  return {
    layers,
    activeLayerIds,
    setActiveLayerIds,
    filters,
    setFilters,
    searchQuery,
    setSearchQuery,
    searchResults: trimmedSearchQuery ? searchResultsState : [],
    mapEntities: hasActiveLayers ? mapEntitiesState : [],
    selectedEntityId,
    setSelectedEntityId: selectEntityId,
    selectedEntity: selectedEntityId ? selectedEntityState : null,
    selectedEvidence: selectedEntityId ? selectedEvidenceState : [],
    trackedEntityDetail: trackedEntityId ? trackedEntityDetailState : null,
    presets,
    loadingLayers,
    loadingSelected: Boolean(selectedEntityId) && loadingSelectedState,
    async saveCurrentPreset(name: string, description = '') {
      const preset = await saveOntologyPreset({
        name,
        description,
        filters: filters as unknown as Record<string, unknown>,
        layerIds: activeLayerIds,
      });
      const nextPresets = await fetchOntologyPresets();
      setPresets(nextPresets);
      return preset;
    },
    applyPreset(preset: OntologyPreset) {
      setActiveLayerIds(preset.layerIds);
      setFilters({
        ...DEFAULT_FILTERS,
        ...(preset.filters as Partial<OntologySearchFilters>),
      });
    },
  };
}
