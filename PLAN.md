# Ontology-First OSINT Workbench, Fully Automated, No AI

## Summary
- Reorient TAC_VIEW from a feed-centric globe into a `guerillamap`-style ontology workbench: automated source collection, canonical entities, evidence-backed relations, saved layer presets, and source-transparent map UI.
- Do not use LLMs or custom neural models. All automation is deterministic: source adapters, schema normalization, entity-resolution rules, relation scoring rules, and existing kinematic prediction logic.
- Deliver a full workbench in v1: automated ingestion, ontology/search APIs, map integration, entity/evidence panels, filter builder, and saved presets.

## Implementation Changes
### 1. Sidecar Ontology Backbone
- Add a new `server/ontology/` subsystem rather than expanding ad hoc logic in [server/app.js](C:/Users/조승준/OneDrive/바탕%20화면/tacview/server/app.js).
- Use `better-sqlite3` as the canonical local store; keep existing JSON snapshot caching for raw payload reuse and offline startup.
- Create these persistent tables:
  - `connectors`, `ingestion_runs`, `raw_records`
  - `entities`, `entity_aliases`, `entity_geometry`
  - `observations`, `relations`, `relation_evidence`
  - `layer_defs`, `saved_presets`
- Canonical ontology types for v1:
  - Dynamic: `aircraft`, `vessel`, `satellite`, `sensor`, `earthquake`
  - Infrastructure/static: `airport`, `port`, `military_site`, `power_site`, `substation`, `tower`, `road_segment`, `rail_node`, `bridge`, `facility`
- Add an explicit `entity_origin` enum: `observed`, `derived`, `synthetic`.
  - Current simulated road vehicles stay out of the real-world ontology by default; if exposed, they must be tagged `synthetic` and visually differentiated.

### 2. Automated Connectors and Normalization
- Reuse current dynamic fetchers as ontology inputs: flights, live flights, ships, satellites, CCTV, earthquakes, traffic roads.
- Add static/semi-static connectors using free/open sources:
  - Overpass/OSM for ports, airports, power, military-tagged sites, towers, rail nodes, roads, bridges
  - Wikidata/GeoNames enrichment only for names, aliases, operator/country metadata when identifiers match
- Implement connector contracts with a common output shape:
  - `source_record_id`, `source_name`, `source_url`, `fetched_at`, `valid_at`, `geometry`, `raw_tags`
- Normalize all records into canonical ontology rows with:
  - stable canonical ID
  - primary label + aliases
  - category/subtype
  - geometry + time validity
  - provenance block with source URL and fetch timestamp
- Add per-connector polling policies:
  - dynamic feeds keep current cadence
  - OSM/Wikidata-style infrastructure sync every 12-24 hours
  - relation/materialized views refresh incrementally after each ingestion run

### 3. Rule-Based Entity Resolution and Relations
- Implement deterministic merge rules in the sidecar:
  - exact native ID / external ID match first
  - normalized-name + near-geometry match second
  - operator/country/type compatibility gates before merge
  - no fuzzy merge across incompatible categories
- Store merge confidence and rule name for every resolved entity link.
- Build rule-based relations with evidence rows, including:
  - co-location / proximity
  - operator / owner / route affinity
  - coverage / sensor overlap
  - infrastructure adjacency
  - track-to-facility linkage
  - group membership from current track/group engine
- Keep existing flight/ship/satellite kinematic prediction logic; do not introduce learned prediction.
- Extend current selection context so ontology-backed relations/evidence are merged into [selectionContext.ts](C:/Users/조승준/OneDrive/바탕%20화면/tacview/src/intelligence/selectionContext.ts) instead of relying only on ephemeral heuristics.

### 4. Public APIs and Frontend Workbench
- Add new sidecar APIs:
  - `GET /api/ontology/search`
  - `GET /api/ontology/entities/:id`
  - `GET /api/ontology/entities/:id/evidence`
  - `GET /api/ontology/layers`
  - `GET /api/ontology/relations`
  - `GET /api/ontology/presets`
  - `POST /api/ontology/presets`
- Add a new frontend ontology client/store under `src/ontology/`.
- Build full workbench UI integrated into [src/App.tsx](C:/Users/조승준/OneDrive/바탕%20화면/tacview/src/App.tsx):
  - searchable entity command bar
  - layer catalog with category/source filters
  - filter builder for type, country, source, confidence, freshness
  - entity detail card with aliases, metadata, relation summary
  - evidence drawer showing exact source links/timestamps
  - saved preset manager for map layer combinations and filters
- Extend tracked-entity UI so real ontology entities show:
  - canonical type
  - source count
  - last observed time
  - confidence
  - evidence shortcuts
- Preserve existing map layers during migration; ontology-backed layers are added in parallel and gradually become the default data source for non-track infrastructure.

## Interfaces / Types
- Add shared frontend/backend types:
  - `OntologyEntity`
  - `OntologyObservation`
  - `OntologyRelation`
  - `OntologyEvidence`
  - `OntologyLayerDefinition`
  - `OntologyPreset`
- Add `origin: 'observed' | 'derived' | 'synthetic'` and `confidence: number` to ontology-facing UI models.
- Extend visual-intelligence entity summaries so ontology-backed non-track entities can render with evidence-aware relations and provenance, while current dynamic track models remain intact.

## Test Plan
- Contract tests for every connector normalizer: stable schema, source URL preservation, timestamp normalization.
- Unit tests for entity-resolution rules: exact-ID merge, alias+geometry merge, incompatible-type rejection.
- Unit tests for relation scoring/evidence lineage: every relation must point to at least one evidence row and rule name.
- API tests for search, entity detail, evidence pagination, and preset save/load.
- UI tests for layer catalog, search/filter flow, entity detail card, and evidence drawer.
- Regression tests to confirm current flights/ships/satellites/CCTV/earthquake rendering and selection still work while ontology APIs are introduced.
- Explicit test to ensure synthetic road vehicles cannot appear as real observed entities unless marked `synthetic`.

## Assumptions and Defaults
- No AI, no LLM, no learned neural inference in v1.
- Free/open data sources only; any source requiring paid/commercial contracts is excluded.
- Real-time global individual road vehicles remain out of scope; road infrastructure is real, simulated traffic remains clearly labeled synthetic.
- The workbench is desktop-first and state is stored locally in the sidecar SQLite database plus existing snapshot cache.
- Existing dynamic tracking and prediction visuals remain, but ontology/provenance becomes the new backbone for knowledge layers and evidence display.
