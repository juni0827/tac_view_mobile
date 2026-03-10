export function initOntologySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      connector_name TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT 'global',
      status TEXT NOT NULL DEFAULT 'idle',
      last_run_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (connector_name, scope_key)
    );

    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY,
      connector_name TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT 'global',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_records (
      id TEXT PRIMARY KEY,
      connector_name TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      source_url TEXT,
      fetched_at TEXT NOT NULL,
      valid_at TEXT,
      geometry_json TEXT NOT NULL DEFAULT '{}',
      raw_tags_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      canonical_type TEXT NOT NULL,
      subtype TEXT,
      label TEXT NOT NULL,
      normalized_label TEXT NOT NULL,
      origin TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      country_code TEXT,
      operator TEXT,
      source_count INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT,
      last_resolved_rule TEXT,
      last_resolved_confidence REAL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source_name TEXT,
      UNIQUE(entity_id, normalized_alias)
    );

    CREATE TABLE IF NOT EXISTS entity_geometry (
      entity_id TEXT PRIMARY KEY,
      geometry_type TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      altitude REAL,
      bbox_json TEXT NOT NULL DEFAULT '{}',
      geometry_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      connector_name TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      source_url TEXT,
      fetched_at TEXT NOT NULL,
      valid_at TEXT,
      geometry_json TEXT NOT NULL DEFAULT '{}',
      raw_tags_json TEXT NOT NULL DEFAULT '{}',
      raw_record_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(connector_name, source_record_id, valid_at)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      relation_type TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      rule_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relation_evidence (
      id TEXT PRIMARY KEY,
      relation_id TEXT NOT NULL,
      observation_id TEXT,
      evidence_type TEXT NOT NULL,
      description TEXT,
      source_url TEXT,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS layer_defs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      source_name TEXT NOT NULL,
      entity_types_json TEXT NOT NULL,
      default_enabled INTEGER NOT NULL DEFAULT 0,
      style_json TEXT NOT NULL DEFAULT '{}',
      refresh_interval_seconds INTEGER NOT NULL DEFAULT 43200
    );

    CREATE TABLE IF NOT EXISTS saved_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      filters_json TEXT NOT NULL DEFAULT '{}',
      layer_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (canonical_type);
    CREATE INDEX IF NOT EXISTS idx_entities_label ON entities (normalized_label);
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases (normalized_alias);
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations (entity_id);
    CREATE INDEX IF NOT EXISTS idx_observations_connector_record ON observations (connector_name, source_record_id);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations (source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations (target_entity_id);
  `);
}
