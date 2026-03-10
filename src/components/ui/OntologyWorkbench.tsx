import { useState } from 'react';
import type {
  OntologyEntity,
  OntologyEntityDetail,
  OntologyEvidence,
  OntologyLayerDefinition,
  OntologyPreset,
  OntologySearchFilters,
} from '../../types/ontology';
import MobileModal from './MobileModal';

interface OntologyWorkbenchProps {
  isMobile?: boolean;
  layers: OntologyLayerDefinition[];
  activeLayerIds: string[];
  onToggleLayer: (layerId: string) => void;
  filters: OntologySearchFilters;
  onFiltersChange: (filters: OntologySearchFilters) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchResults: OntologyEntity[];
  selectedEntity: OntologyEntityDetail | null;
  selectedEvidence: OntologyEvidence[];
  onSelectEntity: (entityId: string) => void;
  onTrackEntity?: (entity: OntologyEntity) => void;
  presets: OntologyPreset[];
  onApplyPreset: (preset: OntologyPreset) => void;
  onSavePreset: (name: string, description?: string) => Promise<void>;
  loadingLayers?: boolean;
  loadingSelected?: boolean;
}

function formatTime(value: string | null | undefined) {
  if (!value) return 'N/A';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').slice(0, 19);
}

function WorkbenchBody({
  layers,
  activeLayerIds,
  onToggleLayer,
  filters,
  onFiltersChange,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  selectedEntity,
  selectedEvidence,
  onSelectEntity,
  onTrackEntity,
  presets,
  onApplyPreset,
  onSavePreset,
  loadingLayers = false,
  loadingSelected = false,
}: Omit<OntologyWorkbenchProps, 'isMobile'>) {
  const [presetName, setPresetName] = useState('');
  const availableTypes = Array.from(new Set(layers.flatMap((layer) => layer.entityTypes))).sort();

  const toggleCanonicalType = (canonicalType: string) => {
    const nextTypes = filters.canonicalTypes.includes(canonicalType)
      ? filters.canonicalTypes.filter((value) => value !== canonicalType)
      : [...filters.canonicalTypes, canonicalType];
    onFiltersChange({ ...filters, canonicalTypes: nextTypes });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-wv-border p-3">
        <div className="mb-2 text-[9px] uppercase tracking-[0.25em] text-wv-muted">Ontology Command</div>
        <input
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search entity, alias, operator, code"
          className="w-full rounded border border-wv-border bg-wv-dark px-2 py-2 text-[11px] text-wv-text outline-none focus:border-wv-cyan"
        />
        {searchResults.length > 0 && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded border border-wv-border/70 bg-black/40">
            {searchResults.map((entity) => (
              <button
                key={entity.id}
                onClick={() => onSelectEntity(entity.id)}
                className="flex w-full items-center justify-between border-b border-wv-border/40 px-2 py-2 text-left text-[10px] text-wv-text hover:bg-white/5 last:border-b-0"
              >
                <span className="truncate">{entity.label}</span>
                <span className="ml-2 shrink-0 text-[9px] uppercase text-wv-cyan">{entity.canonicalType}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-b border-wv-border p-3">
        <div className="mb-2 text-[9px] uppercase tracking-[0.25em] text-wv-muted">Filter Builder</div>
        <div className="mb-2 flex flex-wrap gap-1">
          {availableTypes.map((canonicalType) => {
            const active = filters.canonicalTypes.includes(canonicalType);
            return (
              <button
                key={canonicalType}
                onClick={() => toggleCanonicalType(canonicalType)}
                className={`rounded border px-1.5 py-1 text-[9px] uppercase tracking-wider ${
                  active
                    ? 'border-wv-cyan/40 bg-wv-cyan/10 text-wv-cyan'
                    : 'border-wv-border bg-black/20 text-wv-muted hover:text-wv-text'
                }`}
              >
                {canonicalType.replace(/_/g, ' ')}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="flex flex-col gap-1">
            <span className="text-wv-muted">Source</span>
            <input
              value={filters.source}
              onChange={(event) => onFiltersChange({ ...filters, source: event.target.value })}
              placeholder="connector"
              className="rounded border border-wv-border bg-wv-dark px-2 py-1 text-wv-text outline-none focus:border-wv-cyan"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-wv-muted">Country</span>
            <input
              value={filters.country}
              onChange={(event) => onFiltersChange({ ...filters, country: event.target.value.toUpperCase() })}
              placeholder="US"
              className="rounded border border-wv-border bg-wv-dark px-2 py-1 text-wv-text outline-none focus:border-wv-cyan"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-wv-muted">Min Confidence</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={filters.minConfidence}
              onChange={(event) => onFiltersChange({ ...filters, minConfidence: Number(event.target.value) || 0 })}
              className="rounded border border-wv-border bg-wv-dark px-2 py-1 text-wv-text outline-none focus:border-wv-cyan"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-wv-muted">Freshness (h)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={filters.freshnessHours}
              onChange={(event) => onFiltersChange({ ...filters, freshnessHours: Number(event.target.value) || 0 })}
              className="rounded border border-wv-border bg-wv-dark px-2 py-1 text-wv-text outline-none focus:border-wv-cyan"
            />
          </label>
        </div>
      </div>

      <div className="border-b border-wv-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[9px] uppercase tracking-[0.25em] text-wv-muted">Layer Catalog</div>
          {loadingLayers && <span className="text-[9px] uppercase text-wv-amber">Loading</span>}
        </div>
        <div className="max-h-44 overflow-y-auto space-y-1">
          {layers.map((layer) => {
            const active = activeLayerIds.includes(layer.id);
            return (
              <button
                key={layer.id}
                onClick={() => onToggleLayer(layer.id)}
                className={`flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-[10px] transition-colors ${
                  active
                    ? 'border-wv-cyan/40 bg-wv-cyan/10 text-wv-cyan'
                    : 'border-wv-border bg-black/20 text-wv-text hover:bg-white/5'
                }`}
              >
                <span className="truncate">{layer.label}</span>
                <span className="ml-2 shrink-0 text-[9px] text-wv-muted">{layer.entityCount}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-b border-wv-border p-3">
        <div className="mb-2 text-[9px] uppercase tracking-[0.25em] text-wv-muted">Saved Presets</div>
        <div className="mb-2 flex gap-2">
          <input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            placeholder="Preset name"
            className="flex-1 rounded border border-wv-border bg-wv-dark px-2 py-1 text-[10px] text-wv-text outline-none focus:border-wv-cyan"
          />
          <button
            onClick={() => {
              if (!presetName.trim()) return;
              void onSavePreset(presetName.trim()).then(() => setPresetName(''));
            }}
            className="rounded border border-wv-green/30 bg-wv-green/10 px-2 py-1 text-[10px] uppercase tracking-wider text-wv-green"
          >
            Save
          </button>
        </div>
        <div className="max-h-28 overflow-y-auto space-y-1">
          {presets.map((preset) => (
            <button
              key={preset.id}
              onClick={() => onApplyPreset(preset)}
              className="flex w-full items-center justify-between rounded border border-wv-border bg-black/20 px-2 py-1.5 text-left text-[10px] text-wv-text hover:bg-white/5"
            >
              <span className="truncate">{preset.name}</span>
              <span className="ml-2 shrink-0 text-[9px] text-wv-muted">{preset.layerIds.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[9px] uppercase tracking-[0.25em] text-wv-muted">Entity Detail</div>
          {loadingSelected && <span className="text-[9px] uppercase text-wv-amber">Loading</span>}
        </div>
        {!selectedEntity ? (
          <div className="rounded border border-dashed border-wv-border px-3 py-4 text-[10px] text-wv-muted">
            Search or click an ontology entity to inspect provenance and relations.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-wv-cyan/25 bg-black/20 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[9px] uppercase tracking-[0.25em] text-wv-muted">{selectedEntity.canonicalType}</div>
                  <div className="text-sm font-bold text-wv-cyan">{selectedEntity.label}</div>
                </div>
                {onTrackEntity && (
                  <button
                    onClick={() => onTrackEntity(selectedEntity)}
                    className="rounded border border-wv-cyan/30 bg-wv-cyan/10 px-2 py-1 text-[9px] uppercase tracking-wider text-wv-cyan"
                  >
                    Track
                  </button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <div className="text-wv-muted">Subtype</div>
                  <div className="text-wv-text">{selectedEntity.subtype || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Origin</div>
                  <div className="text-wv-text">{selectedEntity.origin}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Confidence</div>
                  <div className="text-wv-text">{Math.round(selectedEntity.confidence * 100)}%</div>
                </div>
                <div>
                  <div className="text-wv-muted">Sources</div>
                  <div className="text-wv-text">{selectedEntity.sourceCount}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Last Seen</div>
                  <div className="text-wv-text">{formatTime(selectedEntity.lastObservedAt)}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Country</div>
                  <div className="text-wv-text">{selectedEntity.countryCode || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Operator</div>
                  <div className="text-wv-text">{selectedEntity.operator || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-wv-muted">Observations</div>
                  <div className="text-wv-text">{selectedEntity.observationCount}</div>
                </div>
              </div>
              {selectedEntity.aliasList.length > 0 && (
                <div className="mt-2">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-wv-muted">Aliases</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedEntity.aliasList.slice(0, 8).map((alias) => (
                      <span key={alias} className="rounded border border-wv-border bg-black/30 px-1.5 py-0.5 text-[9px] text-wv-text">
                        {alias}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded border border-wv-border bg-black/20 p-3">
              <div className="mb-2 text-[9px] uppercase tracking-[0.25em] text-wv-muted">Relation Summary</div>
              <div className="space-y-1">
                {selectedEntity.relations.slice(0, 8).map((relation) => (
                  <div key={relation.id} className="flex items-center justify-between gap-2 text-[10px] text-wv-text">
                    <span className="truncate">{relation.target.label}</span>
                    <span className="shrink-0 text-wv-amber">{relation.relationType}</span>
                  </div>
                ))}
                {selectedEntity.relations.length === 0 && (
                  <div className="text-[10px] text-wv-muted">No ontology relations computed yet.</div>
                )}
              </div>
            </div>

            <div className="rounded border border-wv-border bg-black/20 p-3">
              <div className="mb-2 text-[9px] uppercase tracking-[0.25em] text-wv-muted">Evidence Drawer</div>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {selectedEvidence.map((evidence) => (
                  <div key={evidence.id} className="rounded border border-wv-border/60 bg-black/30 p-2 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="uppercase tracking-wider text-wv-cyan">{evidence.kind}</span>
                      <span className="text-wv-muted">{formatTime(evidence.recordedAt)}</span>
                    </div>
                    {evidence.sourceUrl && (
                      <a
                        href={evidence.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block truncate text-wv-green underline decoration-wv-green/30"
                      >
                        {evidence.sourceUrl}
                      </a>
                    )}
                    {evidence.description && <div className="mt-1 text-wv-text">{evidence.description}</div>}
                  </div>
                ))}
                {selectedEvidence.length === 0 && (
                  <div className="text-[10px] text-wv-muted">No evidence items loaded for this entity.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OntologyWorkbench(props: OntologyWorkbenchProps) {
  const {
    isMobile = false,
    layers,
    activeLayerIds,
    onToggleLayer,
    filters,
    onFiltersChange,
    searchQuery,
    onSearchQueryChange,
    searchResults,
    selectedEntity,
    selectedEvidence,
    onSelectEntity,
    onTrackEntity,
    presets,
    onApplyPreset,
    onSavePreset,
    loadingLayers,
    loadingSelected,
  } = props;
  const [mobileOpen, setMobileOpen] = useState(false);

  const body = (
    <WorkbenchBody
      layers={layers}
      activeLayerIds={activeLayerIds}
      onToggleLayer={onToggleLayer}
      filters={filters}
      onFiltersChange={onFiltersChange}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      searchResults={searchResults}
      selectedEntity={selectedEntity}
      selectedEvidence={selectedEvidence}
      onSelectEntity={onSelectEntity}
      onTrackEntity={onTrackEntity}
      presets={presets}
      onApplyPreset={onApplyPreset}
      onSavePreset={onSavePreset}
      loadingLayers={loadingLayers}
      loadingSelected={loadingSelected}
    />
  );

  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed bottom-20 right-3 z-40 h-11 w-11 rounded-lg panel-glass text-wv-amber"
          aria-label="Open ontology workbench"
        >
          KB
        </button>
        <MobileModal
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          title="Ontology Workbench"
          icon="KB"
          accent="bg-wv-amber"
        >
          {body}
        </MobileModal>
      </>
    );
  }

  return (
    <div className="fixed right-4 top-72 z-40 h-[calc(100vh-19rem)] w-88 panel-glass rounded-lg overflow-hidden select-none">
      <div className="border-b border-wv-border px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-wv-amber animate-pulse" />
          <span className="text-[10px] uppercase tracking-[0.25em] text-wv-muted">Ontology Workbench</span>
        </div>
      </div>
      {body}
    </div>
  );
}
