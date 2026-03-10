import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOntologyService } from '../../server/ontology/service.js';

type OntologyService = ReturnType<typeof createOntologyService>;

let tempDir = '';
let service: OntologyService;

function makeFlight(overrides: Record<string, unknown> = {}) {
  return {
    icao24: 'abc123',
    callsign: 'TAC101',
    registration: 'N101TV',
    aircraftType: 'A321',
    latitude: 37.62,
    longitude: -122.38,
    altitude: 10800,
    velocityKnots: 420,
    heading: 92,
    originAirport: 'SFO',
    destAirport: 'LAX',
    airline: 'Tac View Air',
    operator: 'Tac View Air',
    ...overrides,
  };
}

function makeCamera(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cam-1',
    name: 'Bay Corridor',
    source: 'caltrans',
    country: 'US',
    countryName: 'United States',
    region: 'California',
    latitude: 37.63,
    longitude: -122.39,
    imageUrl: 'https://cams.example/bay.jpg',
    available: true,
    lastUpdated: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

function emptyPayload() {
  return {
    flights: [],
    ships: [],
    satellites: [],
    cameras: [],
    earthquakes: [],
    roads: [],
  };
}

function seedEntity(input: {
  id: string;
  canonicalType: string;
  label: string;
  normalizedLabel?: string;
  alias?: string;
  latitude: number;
  longitude: number;
  origin?: 'observed' | 'derived' | 'synthetic';
}) {
  const now = '2026-03-10T00:00:00.000Z';
  service.db.prepare(`
    INSERT INTO entities (
      id, canonical_type, subtype, label, normalized_label, origin, confidence, country_code, operator,
      source_count, observation_count, last_observed_at, last_resolved_rule, last_resolved_confidence,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, 0.8, 'US', NULL, 1, 0, ?, 'seed', 0.8, '{}', ?, ?)
  `).run(
    input.id,
    input.canonicalType,
    input.label,
    input.normalizedLabel ?? input.label.toLowerCase(),
    input.origin ?? 'observed',
    now,
    now,
    now,
  );

  service.db.prepare(`
    INSERT INTO entity_geometry (
      entity_id, geometry_type, latitude, longitude, altitude, bbox_json, geometry_json
    ) VALUES (?, 'Point', ?, ?, 0, '{}', '{}')
  `).run(input.id, input.latitude, input.longitude);

  if (input.alias) {
    service.db.prepare(`
      INSERT INTO entity_aliases (entity_id, alias, normalized_alias, source_name)
      VALUES (?, ?, ?, 'seed')
    `).run(input.id, input.alias, input.alias.toLowerCase());
  }
}

describe('ontology service', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tac-view-ontology-'));
    service = createOntologyService({
      dbPath: path.join(tempDir, 'ontology.db'),
    });
  });

  afterEach(async () => {
    service.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('normalizes frontend payloads into canonical entities with provenance metadata', async () => {
    await service.syncFromFrontend({
      ...emptyPayload(),
      flights: [makeFlight()],
    });

    const entity = service.getEntity('flight-abc123');
    expect(entity).not.toBeNull();
    expect(entity?.canonicalType).toBe('aircraft');
    expect(entity?.sourceConnectors).toContain('frontend_flights');
    expect(entity?.observations[0]).toMatchObject({
      connectorName: 'frontend_flights',
      sourceRecordId: 'abc123',
    });
    expect(entity?.observations[0]?.sourceUrl).toContain('flightaware.com');
    expect(new Date(entity?.observations[0]?.fetchedAt ?? '').toString()).not.toBe('Invalid Date');
    expect(entity?.metadata.trackId).toBe('flight-abc123');
  });

  it('merges same-type alias matches by nearby geometry instead of creating duplicates', async () => {
    seedEntity({
      id: 'cctv-existing',
      canonicalType: 'sensor',
      label: 'Bay Corridor',
      alias: 'Bay Corridor',
      latitude: 37.63,
      longitude: -122.39,
    });

    await service.syncFromFrontend({
      ...emptyPayload(),
      cameras: [makeCamera({ id: 'cam-22', latitude: 37.6308, longitude: -122.3908 })],
    });

    const merged = service.getEntity('cctv-existing');
    expect(merged).not.toBeNull();
    expect(merged?.observationCount).toBe(1);
    expect(merged?.observations[0]?.sourceRecordId).toBe('cam-22');
    expect(service.getEntity('cctv-cam-22')).toBeNull();
  });

  it('rejects cross-type merges even when names and coordinates are similar', async () => {
    seedEntity({
      id: 'facility-airport-alpha-node',
      canonicalType: 'airport',
      label: 'Alpha Node',
      alias: 'Alpha Node',
      latitude: 37.63,
      longitude: -122.39,
    });

    await service.syncFromFrontend({
      ...emptyPayload(),
      cameras: [makeCamera({ id: 'cam-33', name: 'Alpha Node' })],
    });

    expect(service.getEntity('facility-airport-alpha-node')?.canonicalType).toBe('airport');
    expect(service.getEntity('cctv-cam-33')?.canonicalType).toBe('sensor');
  });

  it('creates evidence-backed relations and excludes synthetic entities unless requested', async () => {
    await service.syncFromFrontend({
      ...emptyPayload(),
      flights: [
        makeFlight({ icao24: 'abc123', callsign: 'TAC101' }),
        makeFlight({
          icao24: 'def456',
          callsign: 'TAC202',
          latitude: 37.68,
          longitude: -122.31,
          registration: 'N202TV',
        }),
      ],
    });

    seedEntity({
      id: 'facility-synthetic-test',
      canonicalType: 'facility',
      label: 'Synthetic Yard',
      latitude: 36.1,
      longitude: -121.9,
      origin: 'synthetic',
    });

    const relations = service.listRelations({ entityId: 'flight-abc123', limit: 20 });
    expect(relations.length).toBeGreaterThan(0);
    expect(relations[0]?.ruleName).toBeTruthy();

    const evidence = service.getEvidence('flight-abc123', 1, 20);
    expect(evidence.some((item) => item.kind === 'relation' && item.relationId === relations[0]?.id)).toBe(true);

    const defaultSearch = service.searchEntities({ q: 'Synthetic Yard', limit: 20 });
    const explicitSearch = service.searchEntities({ q: 'Synthetic Yard', limit: 20, includeSynthetic: true });
    expect(defaultSearch).toHaveLength(0);
    expect(explicitSearch).toHaveLength(1);
    expect(explicitSearch[0]?.origin).toBe('synthetic');
  });
});
