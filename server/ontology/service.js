import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initOntologySchema } from './schema.js';
import { DEFAULT_LAYER_DEFS, getEntityTypesForLayerIds, getLayerIdsForEntityType } from './layers.js';

const INFRA_REFRESH_SECONDS = 12 * 60 * 60;
const DEFAULT_OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const DEFAULT_GEONAMES_API_URL = 'https://secure.geonames.org';
const repoRoot = process.env.TAC_VIEW_REPO_ROOT || process.cwd();

const TYPE_DISTANCE_THRESHOLDS_KM = {
  aircraft: 40,
  vessel: 20,
  sensor: 10,
  earthquake: 10,
  airport: 12,
  port: 12,
  military_site: 8,
  power_site: 8,
  substation: 5,
  tower: 4,
  rail_node: 3,
  bridge: 2,
  road_segment: 1.5,
  facility: 6,
};

const OBSERVED_SYNC_CONNECTORS = {
  flights: 'frontend_flights',
  ships: 'frontend_ships',
  satellites: 'frontend_satellites',
  cameras: 'frontend_cameras',
  earthquakes: 'frontend_earthquakes',
  roads: 'frontend_roads',
};

const LOCAL_TRIPLE_MAP = {
  win32: {
    x64: 'x86_64-pc-windows-msvc',
    arm64: 'aarch64-pc-windows-msvc',
  },
  darwin: {
    x64: 'x86_64-apple-darwin',
    arm64: 'aarch64-apple-darwin',
  },
  linux: {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
  },
};

function nowIso() {
  return new Date().toISOString();
}

function resolveLocalTargetTriple() {
  return LOCAL_TRIPLE_MAP[process.platform]?.[process.arch] ?? null;
}

function resolveBetterSqliteNativeBinding() {
  const explicitPath = process.env.TAC_VIEW_BETTER_SQLITE3_BINDING;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const targetTriple = resolveLocalTargetTriple();
  const fileNames = targetTriple
    ? [`better_sqlite3-${targetTriple}.node`, 'better_sqlite3.node']
    : ['better_sqlite3.node'];
  const candidateDirs = [
    path.join(path.dirname(process.execPath), 'resources', 'binaries'),
    path.join(path.dirname(process.execPath), 'binaries'),
    path.dirname(process.execPath),
    path.join(repoRoot, 'src-tauri', 'binaries'),
    path.join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release'),
  ];

  for (const directory of candidateDirs) {
    for (const fileName of fileNames) {
      const candidate = path.join(directory, fileName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (process.pkg) {
    const attempted = candidateDirs.flatMap((directory) => fileNames.map((fileName) => path.join(directory, fileName)));
    throw new Error(`Unable to locate better_sqlite3 native binding. Tried: ${attempted.join(', ')}`);
  }

  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function stableId(...parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function ensureStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (
    lat1 == null || lon1 == null || lat2 == null || lon2 == null
    || Number.isNaN(lat1) || Number.isNaN(lon1) || Number.isNaN(lat2) || Number.isNaN(lon2)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function computeCenterFromGeometry(geometryType, geometry) {
  if (!geometry) {
    return { latitude: null, longitude: null, altitude: 0 };
  }

  if (geometryType === 'Point') {
    return {
      latitude: geometry.latitude ?? null,
      longitude: geometry.longitude ?? null,
      altitude: geometry.altitude ?? 0,
    };
  }

  const points = Array.isArray(geometry.points) ? geometry.points : [];
  if (points.length === 0) {
    return {
      latitude: geometry.latitude ?? null,
      longitude: geometry.longitude ?? null,
      altitude: geometry.altitude ?? 0,
    };
  }

  const latitude = points.reduce((sum, point) => sum + (point.latitude ?? 0), 0) / points.length;
  const longitude = points.reduce((sum, point) => sum + (point.longitude ?? 0), 0) / points.length;
  const altitude = points.reduce((sum, point) => sum + (point.altitude ?? 0), 0) / points.length;
  return { latitude, longitude, altitude };
}

function computeBbox(geometryType, geometry) {
  if (!geometry) {
    return {};
  }

  const points = geometryType === 'Point'
    ? [{ latitude: geometry.latitude, longitude: geometry.longitude }]
    : Array.isArray(geometry.points) ? geometry.points : [];

  if (points.length === 0) {
    return {};
  }

  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    south = Math.min(south, point.latitude);
    west = Math.min(west, point.longitude);
    north = Math.max(north, point.latitude);
    east = Math.max(east, point.longitude);
  }

  return { south, west, north, east };
}

function pickLocalizedValue(candidates, preferredLocales = ['en', 'ko']) {
  if (!candidates || typeof candidates !== 'object') {
    return '';
  }

  for (const locale of preferredLocales) {
    const value = candidates[locale]?.value;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  for (const candidate of Object.values(candidates)) {
    if (typeof candidate?.value === 'string' && candidate.value.trim()) {
      return candidate.value.trim();
    }
  }

  return '';
}

function relationId(relationType, sourceEntityId, targetEntityId, symmetric = false) {
  if (!symmetric) {
    return `rel-${relationType}-${stableId(sourceEntityId, targetEntityId)}`;
  }

  const pair = [sourceEntityId, targetEntityId].sort();
  return `rel-${relationType}-${stableId(pair[0], pair[1])}`;
}

function toSummaryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    canonicalType: row.canonical_type,
    subtype: row.subtype,
    label: row.label,
    origin: row.origin,
    confidence: row.confidence,
    countryCode: row.country_code,
    operator: row.operator,
    sourceCount: row.source_count,
    observationCount: row.observation_count,
    lastObservedAt: row.last_observed_at,
    layerIds: getLayerIdsForEntityType(row.canonical_type),
    geometry: {
      type: row.geometry_type,
      latitude: row.latitude,
      longitude: row.longitude,
      altitude: row.altitude ?? 0,
      bbox: parseJson(row.bbox_json, {}),
      data: parseJson(row.geometry_json, {}),
    },
    metadata: parseJson(row.metadata_json, {}),
  };
}

function makeFacilityId(type, value) {
  return `facility-${type}-${slugify(value)}`;
}

function normalizeFlight(record, fetchedAt) {
  const icao24 = String(record.icao24 ?? '').trim().toLowerCase();
  if (!icao24 || record.latitude == null || record.longitude == null) {
    return null;
  }

  const callsign = String(record.callsign ?? '').trim();
  const registration = String(record.registration ?? '').trim();
  const label = callsign || registration || icao24.toUpperCase();
  const aliases = [callsign, registration, icao24, record.originAirport, record.destAirport].filter(Boolean);

  return {
    entityId: `flight-${icao24}`,
    canonicalType: 'aircraft',
    subtype: String(record.aircraftType ?? '').trim() || null,
    label,
    aliases,
    origin: 'observed',
    confidence: 0.95,
    countryCode: null,
    operator: String(record.operator || record.airline || '').trim() || null,
    geometryType: 'Point',
    geometry: {
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      altitude: Number(record.altitude ?? 0),
    },
    connectorName: OBSERVED_SYNC_CONNECTORS.flights,
    sourceName: 'frontend',
    sourceRecordId: icao24,
    sourceUrl: `https://www.flightaware.com/live/modes/${icao24}/ident/${encodeURIComponent(registration || callsign || icao24)}`,
    fetchedAt,
    validAt: fetchedAt,
    rawTags: {
      originAirport: record.originAirport || '',
      destAirport: record.destAirport || '',
      airline: record.airline || '',
      category: record.category || '',
    },
    metadata: {
      trackId: `flight-${icao24}`,
      registration,
      aircraftType: record.aircraftType || '',
      squawk: record.squawk || '',
      heading: record.heading,
      velocityKnots: record.velocityKnots,
      originAirport: record.originAirport || '',
      destAirport: record.destAirport || '',
      airline: record.airline || '',
      onGround: Boolean(record.onGround),
    },
    rawRecord: record,
  };
}

function normalizeShip(record, fetchedAt) {
  const mmsi = String(record.mmsi ?? '').trim();
  if (!mmsi || record.latitude == null || record.longitude == null) {
    return null;
  }

  const label = String(record.name || '').trim() || mmsi;
  return {
    entityId: `ship-${mmsi}`,
    canonicalType: 'vessel',
    subtype: record.shipType != null ? String(record.shipType) : null,
    label,
    aliases: [record.name, record.callSign, record.destination, record.imo].filter(Boolean),
    origin: 'observed',
    confidence: 0.94,
    countryCode: record.countryCode || null,
    operator: null,
    geometryType: 'Point',
    geometry: {
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      altitude: 0,
    },
    connectorName: OBSERVED_SYNC_CONNECTORS.ships,
    sourceName: 'frontend',
    sourceRecordId: mmsi,
    sourceUrl: `https://www.vesselfinder.com/vessels/details/${encodeURIComponent(mmsi)}`,
    fetchedAt,
    validAt: record.timestamp || fetchedAt,
    rawTags: {
      destination: record.destination || '',
      navStatus: record.navStatus ?? null,
      shipType: record.shipType ?? null,
    },
    metadata: {
      trackId: `ship-${mmsi}`,
      destination: record.destination || '',
      imo: record.imo ?? null,
      callSign: record.callSign ?? null,
      shipType: record.shipType ?? null,
      heading: record.heading,
      cog: record.cog,
      sog: record.sog,
      country: record.country || '',
    },
    rawRecord: record,
  };
}

function normalizeSatellite(record, fetchedAt) {
  const noradId = Number(record.noradId);
  if (!Number.isFinite(noradId) || record.latitude == null || record.longitude == null) {
    return null;
  }

  const label = String(record.name || `NORAD ${noradId}`).trim();
  return {
    entityId: `sat-${noradId}`,
    canonicalType: 'satellite',
    subtype: null,
    label,
    aliases: [record.name, noradId].filter(Boolean),
    origin: 'observed',
    confidence: 0.93,
    countryCode: null,
    operator: null,
    geometryType: 'Point',
    geometry: {
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      altitude: Number(record.altitude ?? 0) * 1000,
    },
    connectorName: OBSERVED_SYNC_CONNECTORS.satellites,
    sourceName: 'frontend',
    sourceRecordId: String(noradId),
    sourceUrl: `https://celestrak.org/satcat/records.php?CATNR=${noradId}`,
    fetchedAt,
    validAt: fetchedAt,
    rawTags: {},
    metadata: {
      trackId: `sat-${noradId}`,
      noradId,
      orbitPath: Array.isArray(record.orbitPath) ? record.orbitPath : [],
      altitudeKm: Number(record.altitude ?? 0),
    },
    rawRecord: record,
  };
}

function normalizeCamera(record, fetchedAt) {
  const id = String(record.id ?? '').trim();
  if (!id || record.latitude == null || record.longitude == null) {
    return null;
  }

  return {
    entityId: `cctv-${id}`,
    canonicalType: 'sensor',
    subtype: String(record.source || '').trim() || null,
    label: String(record.name || id).trim(),
    aliases: [record.name, record.region, record.countryName, record.id].filter(Boolean),
    origin: 'observed',
    confidence: record.available === false ? 0.55 : 0.88,
    countryCode: record.country || null,
    operator: String(record.source || '').trim() || null,
    geometryType: 'Point',
    geometry: {
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      altitude: 0,
    },
    connectorName: OBSERVED_SYNC_CONNECTORS.cameras,
    sourceName: 'frontend',
    sourceRecordId: id,
    sourceUrl: record.imageUrl || '',
    fetchedAt,
    validAt: record.lastUpdated || fetchedAt,
    rawTags: {
      source: record.source || '',
      region: record.region || '',
    },
    metadata: {
      trackId: `cctv-${id}`,
      available: record.available !== false,
      imageUrl: record.imageUrl || '',
      videoUrl: record.videoUrl || '',
      source: record.source || '',
      region: record.region || '',
      countryName: record.countryName || '',
    },
    rawRecord: record,
  };
}

function normalizeEarthquake(record, fetchedAt) {
  const id = String(record.id ?? '').trim();
  if (!id || record.latitude == null || record.longitude == null) {
    return null;
  }

  return {
    entityId: `eq-${id}`,
    canonicalType: 'earthquake',
    subtype: record.mag != null ? `m${Math.floor(Number(record.mag))}` : null,
    label: `M${Number(record.mag ?? 0).toFixed(1)} ${String(record.place || '').trim() || id}`,
    aliases: [record.place, record.id].filter(Boolean),
    origin: 'observed',
    confidence: clamp(Number(record.mag ?? 0) / 10, 0.4, 0.98),
    countryCode: null,
    operator: null,
    geometryType: 'Point',
    geometry: {
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      altitude: Number(record.depth ?? 0) * -1000,
    },
    connectorName: OBSERVED_SYNC_CONNECTORS.earthquakes,
    sourceName: 'frontend',
    sourceRecordId: id,
    sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(id)}`,
    fetchedAt,
    validAt: record.time ? new Date(record.time).toISOString() : fetchedAt,
    rawTags: {
      magnitude: record.mag,
      depthKm: record.depth,
    },
    metadata: {
      trackId: `eq-${id}`,
      magnitude: Number(record.mag ?? 0),
      place: record.place || '',
      time: record.time ?? null,
      depthKm: Number(record.depth ?? 0),
    },
    rawRecord: record,
  };
}

function normalizeRoadSegment(record, fetchedAt, connectorName = OBSERVED_SYNC_CONNECTORS.roads, sourceName = 'frontend') {
  const sourceRecordId = String(record.id ?? '').trim();
  const points = Array.isArray(record.geometry)
    ? record.geometry
        .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lon))
        .map((point) => ({
          latitude: Number(point.lat),
          longitude: Number(point.lon),
          altitude: 0,
        }))
    : [];

  if (!sourceRecordId || points.length === 0) {
    return null;
  }

  const center = computeCenterFromGeometry('LineString', { points });
  const label = String(record.name || '').trim() || `Road ${sourceRecordId}`;
  return {
    entityId: makeFacilityId('road-segment', sourceRecordId),
    canonicalType: 'road_segment',
    subtype: String(record.highway || '').trim() || null,
    label,
    aliases: [record.name, record.highway].filter(Boolean),
    origin: 'observed',
    confidence: 0.81,
    countryCode: null,
    operator: null,
    geometryType: 'LineString',
    geometry: {
      points,
      latitude: center.latitude,
      longitude: center.longitude,
      altitude: 0,
    },
    connectorName,
    sourceName,
    sourceRecordId,
    sourceUrl: `https://www.openstreetmap.org/${sourceRecordId.replace(':', '/')}`,
    fetchedAt,
    validAt: fetchedAt,
    rawTags: {
      highway: record.highway || '',
      maxspeed: record.maxspeed ?? null,
      length_meters: record.length_meters ?? null,
    },
    metadata: {
      highway: record.highway || '',
      maxspeed: record.maxspeed ?? null,
      lengthMeters: Number(record.length_meters ?? 0),
    },
    rawRecord: record,
  };
}

function inferInfrastructureType(tags) {
  if (tags.aeroway === 'aerodrome') return 'airport';
  if (tags.harbour === 'yes' || tags['seamark:type'] === 'harbour' || tags.amenity === 'ferry_terminal') return 'port';
  if (tags.military) return 'military_site';
  if (tags.power === 'plant' || tags.power === 'generator') return 'power_site';
  if (tags.power === 'substation') return 'substation';
  if (tags.man_made === 'tower' || tags.man_made === 'mast' || tags['tower:type']) return 'tower';
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.railway === 'junction') return 'rail_node';
  if (tags.bridge === 'yes' || tags.man_made === 'bridge') return 'bridge';
  if (tags.highway) return 'road_segment';
  return 'facility';
}

function normalizeOsmElement(element, fetchedAt, enrichment = null) {
  const tags = element.tags || {};
  const canonicalType = inferInfrastructureType(tags);
  if (!canonicalType) {
    return null;
  }

  const sourceRecordId = `${element.type}:${element.id}`;
  const pointGeometry = element.type === 'node'
    ? { latitude: element.lat, longitude: element.lon, altitude: 0 }
    : null;
  const lineGeometry = Array.isArray(element.geometry)
    ? element.geometry.map((point) => ({
        latitude: Number(point.lat),
        longitude: Number(point.lon),
        altitude: 0,
      }))
    : [];
  const geometryType = pointGeometry ? 'Point' : lineGeometry.length > 1 ? 'LineString' : 'Point';
  const geometry = geometryType === 'Point'
    ? pointGeometry || {
        latitude: element.center?.lat ?? null,
        longitude: element.center?.lon ?? null,
        altitude: 0,
      }
    : {
        points: lineGeometry,
      };

  const center = computeCenterFromGeometry(geometryType, geometry);
  if (center.latitude == null || center.longitude == null) {
    return null;
  }

  const refId = tags.iata || tags.icao || tags.ref || sourceRecordId;
  const wikidataAliases = Array.isArray(enrichment?.wikidata?.aliases)
    ? enrichment.wikidata.aliases
    : [];
  const label = String(tags.name || tags['name:en'] || enrichment?.wikidata?.label || refId).trim();
  const aliases = Array.from(new Set([
    tags.name,
    tags['name:en'],
    tags.iata,
    tags.icao,
    tags.ref,
    tags.operator,
    ...wikidataAliases,
  ].filter(Boolean)));
  const countryCode = firstNonEmptyString(
    tags['addr:country'],
    tags['is_in:country_code'],
    enrichment?.geonames?.countryCode,
  ) || null;
  const operator = firstNonEmptyString(tags.operator, enrichment?.wikidata?.operatorLabel) || null;

  return {
    entityId: makeFacilityId(canonicalType.replace(/_/g, '-'), refId),
    canonicalType,
    subtype: tags.military || tags.power || tags.highway || tags.railway || null,
    label: label || refId,
    aliases,
    origin: 'observed',
    confidence: enrichment?.wikidata ? 0.78 : 0.72,
    countryCode,
    operator,
    geometryType,
    geometry: geometryType === 'Point'
      ? {
          latitude: center.latitude,
          longitude: center.longitude,
          altitude: 0,
        }
      : {
          points: lineGeometry,
          latitude: center.latitude,
          longitude: center.longitude,
          altitude: 0,
        },
    connectorName: 'osm_infrastructure',
    sourceName: 'osm',
    sourceRecordId,
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    fetchedAt,
    validAt: fetchedAt,
    rawTags: tags,
    metadata: {
      osmType: element.type,
      osmId: element.id,
      iata: tags.iata || '',
      icao: tags.icao || '',
      ref: tags.ref || '',
      operator: operator || '',
      aliases,
      tags,
      wikidata: enrichment?.wikidata || null,
      geonames: enrichment?.geonames || null,
    },
    rawRecord: element,
  };
}

function normalizeSyncPayload(payload, fetchedAt) {
  const normalized = [];

  for (const record of payload.flights || []) {
    const next = normalizeFlight(record, fetchedAt);
    if (next) normalized.push(next);
  }
  for (const record of payload.ships || []) {
    const next = normalizeShip(record, fetchedAt);
    if (next) normalized.push(next);
  }
  for (const record of payload.satellites || []) {
    const next = normalizeSatellite(record, fetchedAt);
    if (next) normalized.push(next);
  }
  for (const record of payload.cameras || []) {
    const next = normalizeCamera(record, fetchedAt);
    if (next) normalized.push(next);
  }
  for (const record of payload.earthquakes || []) {
    const next = normalizeEarthquake(record, fetchedAt);
    if (next) normalized.push(next);
  }
  for (const record of payload.roads || []) {
    const next = normalizeRoadSegment(record, fetchedAt);
    if (next) normalized.push(next);
  }

  return normalized;
}

function buildOverpassQuery(bbox, entityTypes) {
  const parts = [];
  const bounds = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  const wants = new Set(entityTypes);

  if (wants.has('airport')) {
    parts.push(`node["aeroway"="aerodrome"]${bounds};`);
    parts.push(`way["aeroway"="aerodrome"]${bounds};`);
  }
  if (wants.has('port')) {
    parts.push(`node["harbour"="yes"]${bounds};`);
    parts.push(`way["harbour"="yes"]${bounds};`);
    parts.push(`node["amenity"="ferry_terminal"]${bounds};`);
    parts.push(`way["amenity"="ferry_terminal"]${bounds};`);
  }
  if (wants.has('military_site')) {
    parts.push(`node["military"]${bounds};`);
    parts.push(`way["military"]${bounds};`);
  }
  if (wants.has('power_site')) {
    parts.push(`node["power"~"^(plant|generator)$"]${bounds};`);
    parts.push(`way["power"~"^(plant|generator)$"]${bounds};`);
  }
  if (wants.has('substation')) {
    parts.push(`node["power"="substation"]${bounds};`);
    parts.push(`way["power"="substation"]${bounds};`);
  }
  if (wants.has('tower')) {
    parts.push(`node["man_made"~"^(tower|mast)$"]${bounds};`);
    parts.push(`way["man_made"~"^(tower|mast)$"]${bounds};`);
  }
  if (wants.has('rail_node')) {
    parts.push(`node["railway"~"^(station|halt|junction)$"]${bounds};`);
    parts.push(`way["railway"~"^(station|halt|junction)$"]${bounds};`);
  }
  if (wants.has('bridge')) {
    parts.push(`way["bridge"="yes"]${bounds};`);
    parts.push(`way["man_made"="bridge"]${bounds};`);
  }
  if (wants.has('road_segment')) {
    parts.push(`way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]${bounds};`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `
    [out:json][timeout:20];
    (
      ${parts.join('\n')}
    );
    out geom center tags;
  `;
}

export function createOntologyService({ dbPath, snapshotStore = null, connectorConfig = {} }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const db = nativeBinding
    ? new Database(dbPath, { nativeBinding })
    : new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initOntologySchema(db);

  const overpassUrls = ensureStringArray(connectorConfig.overpassUrls, DEFAULT_OVERPASS_URLS);
  const wikidataEntityDataUrl = firstNonEmptyString(
    connectorConfig.wikidataEntityDataUrl,
    process.env.WIKIDATA_ENTITY_DATA_URL,
  );
  const wikidataUserAgent = firstNonEmptyString(
    connectorConfig.wikidataUserAgent,
    process.env.WIKIDATA_USER_AGENT,
    'TAC_VIEW/1.0',
  );
  const geonamesUsername = firstNonEmptyString(
    connectorConfig.geonamesUsername,
    process.env.GEONAMES_USERNAME,
  );
  const geonamesApiUrl = firstNonEmptyString(
    connectorConfig.geonamesApiUrl,
    process.env.GEONAMES_API_URL,
    DEFAULT_GEONAMES_API_URL,
  );
  const wikidataCache = new Map();
  const geonamesCache = new Map();

  const seedLayerStmt = db.prepare(`
    INSERT INTO layer_defs (
      id, label, category, description, source_name,
      entity_types_json, default_enabled, style_json, refresh_interval_seconds
    ) VALUES (
      @id, @label, @category, @description, @sourceName,
      @entityTypesJson, @defaultEnabled, @styleJson, @refreshIntervalSeconds
    )
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      category = excluded.category,
      description = excluded.description,
      source_name = excluded.source_name,
      entity_types_json = excluded.entity_types_json,
      default_enabled = excluded.default_enabled,
      style_json = excluded.style_json,
      refresh_interval_seconds = excluded.refresh_interval_seconds
  `);

  const insertRunStmt = db.prepare(`
    INSERT INTO ingestion_runs (id, connector_name, scope_key, started_at, status, record_count)
    VALUES (@id, @connectorName, @scopeKey, @startedAt, @status, @recordCount)
  `);
  const finishRunStmt = db.prepare(`
    UPDATE ingestion_runs
    SET finished_at = @finishedAt, status = @status, record_count = @recordCount, error = @error
    WHERE id = @id
  `);
  const connectorStatusStmt = db.prepare(`
    INSERT INTO connectors (connector_name, scope_key, status, last_run_at, last_success_at, last_error, metadata_json)
    VALUES (@connectorName, @scopeKey, @status, @lastRunAt, @lastSuccessAt, @lastError, @metadataJson)
    ON CONFLICT(connector_name, scope_key) DO UPDATE SET
      status = excluded.status,
      last_run_at = excluded.last_run_at,
      last_success_at = excluded.last_success_at,
      last_error = excluded.last_error,
      metadata_json = excluded.metadata_json
  `);
  const rawRecordStmt = db.prepare(`
    INSERT OR REPLACE INTO raw_records (
      id, connector_name, source_name, source_record_id, source_url,
      fetched_at, valid_at, geometry_json, raw_tags_json, raw_json
    ) VALUES (
      @id, @connectorName, @sourceName, @sourceRecordId, @sourceUrl,
      @fetchedAt, @validAt, @geometryJson, @rawTagsJson, @rawJson
    )
  `);
  const selectObservationEntityStmt = db.prepare(`
    SELECT entity_id
    FROM observations
    WHERE connector_name = ? AND source_record_id = ?
    ORDER BY valid_at DESC, fetched_at DESC
    LIMIT 1
  `);
  const aliasCandidateStmt = db.prepare(`
    SELECT
      e.id,
      e.canonical_type,
      e.country_code,
      e.operator,
      g.latitude,
      g.longitude
    FROM entities e
    LEFT JOIN entity_geometry g ON g.entity_id = e.id
    WHERE e.canonical_type = ?
      AND (
        e.normalized_label = ?
        OR EXISTS (
          SELECT 1
          FROM entity_aliases a
          WHERE a.entity_id = e.id AND a.normalized_alias = ?
        )
      )
    LIMIT 20
  `);
  const upsertEntityStmt = db.prepare(`
    INSERT INTO entities (
      id, canonical_type, subtype, label, normalized_label, origin,
      confidence, country_code, operator, source_count, observation_count,
      last_observed_at, last_resolved_rule, last_resolved_confidence,
      metadata_json, created_at, updated_at
    ) VALUES (
      @id, @canonicalType, @subtype, @label, @normalizedLabel, @origin,
      @confidence, @countryCode, @operator, @sourceCount, @observationCount,
      @lastObservedAt, @lastResolvedRule, @lastResolvedConfidence,
      @metadataJson, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      subtype = excluded.subtype,
      label = excluded.label,
      normalized_label = excluded.normalized_label,
      origin = excluded.origin,
      confidence = excluded.confidence,
      country_code = excluded.country_code,
      operator = excluded.operator,
      source_count = excluded.source_count,
      observation_count = excluded.observation_count,
      last_observed_at = excluded.last_observed_at,
      last_resolved_rule = excluded.last_resolved_rule,
      last_resolved_confidence = excluded.last_resolved_confidence,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
  const upsertAliasStmt = db.prepare(`
    INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized_alias, source_name)
    VALUES (?, ?, ?, ?)
  `);
  const upsertGeometryStmt = db.prepare(`
    INSERT INTO entity_geometry (entity_id, geometry_type, latitude, longitude, altitude, bbox_json, geometry_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET
      geometry_type = excluded.geometry_type,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      altitude = excluded.altitude,
      bbox_json = excluded.bbox_json,
      geometry_json = excluded.geometry_json
  `);
  const upsertObservationStmt = db.prepare(`
    INSERT OR REPLACE INTO observations (
      id, entity_id, connector_name, source_name, source_record_id, source_url,
      fetched_at, valid_at, geometry_json, raw_tags_json, raw_record_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectEntityCountsStmt = db.prepare(`
    SELECT
      COUNT(DISTINCT connector_name) AS source_count,
      COUNT(*) AS observation_count,
      MAX(COALESCE(valid_at, fetched_at)) AS last_observed_at
    FROM observations
    WHERE entity_id = ?
  `);
  const selectEntityCreatedAtStmt = db.prepare(`
    SELECT created_at FROM entities WHERE id = ?
  `);

  for (const layer of DEFAULT_LAYER_DEFS) {
    seedLayerStmt.run({
      ...layer,
      entityTypesJson: JSON.stringify(layer.entityTypes),
      styleJson: JSON.stringify(layer.style),
    });
  }

  function beginRun(connectorName, scopeKey = 'global') {
    const id = `run-${connectorName}-${stableId(scopeKey, nowIso())}`;
    const timestamp = nowIso();
    insertRunStmt.run({
      id,
      connectorName,
      scopeKey,
      startedAt: timestamp,
      status: 'running',
      recordCount: 0,
    });
    connectorStatusStmt.run({
      connectorName,
      scopeKey,
      status: 'running',
      lastRunAt: timestamp,
      lastSuccessAt: null,
      lastError: null,
      metadataJson: '{}',
    });
    return id;
  }

  function finishRun(id, connectorName, scopeKey, status, recordCount, error = null, metadata = {}) {
    const finishedAt = nowIso();
    finishRunStmt.run({
      id,
      finishedAt,
      status,
      recordCount,
      error,
    });
    connectorStatusStmt.run({
      connectorName,
      scopeKey,
      status,
      lastRunAt: finishedAt,
      lastSuccessAt: status === 'success' ? finishedAt : null,
      lastError: error,
      metadataJson: JSON.stringify(metadata),
    });
  }

  function resolveEntity(record) {
    const exact = selectObservationEntityStmt.get(record.connectorName, record.sourceRecordId);
    if (exact?.entity_id) {
      return { entityId: exact.entity_id, ruleName: 'exact_source_record', confidence: 0.99 };
    }

    const normalizedLabel = normalizeText(record.label);
    if (!normalizedLabel) {
      return { entityId: record.entityId, ruleName: 'stable_id', confidence: 0.85 };
    }

    const candidates = aliasCandidateStmt.all(record.canonicalType, normalizedLabel, normalizedLabel);
    const threshold = TYPE_DISTANCE_THRESHOLDS_KM[record.canonicalType] ?? 5;
    for (const candidate of candidates) {
      if (record.countryCode && candidate.country_code && record.countryCode !== candidate.country_code) {
        continue;
      }
      if (record.operator && candidate.operator && normalizeText(record.operator) !== normalizeText(candidate.operator)) {
        continue;
      }
      const distanceKm = haversineKm(
        record.geometry.latitude,
        record.geometry.longitude,
        candidate.latitude,
        candidate.longitude,
      );
      if (distanceKm <= threshold) {
        return { entityId: candidate.id, ruleName: 'normalized_name_near_geometry', confidence: 0.8 };
      }
    }

    return { entityId: record.entityId, ruleName: 'stable_id', confidence: 0.85 };
  }

  const upsertRecordTx = db.transaction((records) => {
    const impacted = new Set();

    for (const record of records) {
      const resolution = resolveEntity(record);
      const entityId = resolution.entityId;
      const rawRecordId = `raw-${record.connectorName}-${stableId(record.sourceRecordId, record.validAt || record.fetchedAt)}`;

      rawRecordStmt.run({
        id: rawRecordId,
        connectorName: record.connectorName,
        sourceName: record.sourceName,
        sourceRecordId: record.sourceRecordId,
        sourceUrl: record.sourceUrl,
        fetchedAt: record.fetchedAt,
        validAt: record.validAt,
        geometryJson: JSON.stringify(record.geometry),
        rawTagsJson: JSON.stringify(record.rawTags ?? {}),
        rawJson: JSON.stringify(record.rawRecord ?? {}),
      });

      const countRowBefore = selectEntityCountsStmt.get(entityId);
      const createdAt = selectEntityCreatedAtStmt.get(entityId)?.created_at ?? record.fetchedAt;

      upsertEntityStmt.run({
        id: entityId,
        canonicalType: record.canonicalType,
        subtype: record.subtype,
        label: record.label,
        normalizedLabel: normalizeText(record.label),
        origin: record.origin,
        confidence: record.confidence,
        countryCode: record.countryCode,
        operator: record.operator,
        sourceCount: Math.max((countRowBefore?.source_count ?? 0), 1),
        observationCount: (countRowBefore?.observation_count ?? 0) + 1,
        lastObservedAt: record.validAt || record.fetchedAt,
        lastResolvedRule: resolution.ruleName,
        lastResolvedConfidence: resolution.confidence,
        metadataJson: JSON.stringify(record.metadata ?? {}),
        createdAt,
        updatedAt: record.fetchedAt,
      });

      const bbox = computeBbox(record.geometryType, record.geometry);
      upsertGeometryStmt.run(
        entityId,
        record.geometryType,
        record.geometry.latitude ?? null,
        record.geometry.longitude ?? null,
        record.geometry.altitude ?? 0,
        JSON.stringify(bbox),
        JSON.stringify(record.geometry),
      );

      for (const alias of new Set([record.label, ...(record.aliases ?? [])].filter(Boolean))) {
        upsertAliasStmt.run(entityId, alias, normalizeText(alias), record.sourceName);
      }

      const observationId = `obs-${record.connectorName}-${stableId(record.sourceRecordId, record.validAt || record.fetchedAt, entityId)}`;
      upsertObservationStmt.run(
        observationId,
        entityId,
        record.connectorName,
        record.sourceName,
        record.sourceRecordId,
        record.sourceUrl,
        record.fetchedAt,
        record.validAt || record.fetchedAt,
        JSON.stringify(record.geometry),
        JSON.stringify(record.rawTags ?? {}),
        rawRecordId,
        JSON.stringify(record.metadata ?? {}),
      );

      const countRow = selectEntityCountsStmt.get(entityId);
      db.prepare(`
        UPDATE entities
        SET
          source_count = ?,
          observation_count = ?,
          last_observed_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        countRow?.source_count ?? 1,
        countRow?.observation_count ?? 1,
        countRow?.last_observed_at ?? (record.validAt || record.fetchedAt),
        record.fetchedAt,
        entityId,
      );

      impacted.add(entityId);
    }

    return Array.from(impacted);
  });

  const latestObservationStmt = db.prepare(`
    SELECT id, source_url, fetched_at, valid_at, metadata_json
    FROM observations
    WHERE entity_id = ?
    ORDER BY valid_at DESC, fetched_at DESC
    LIMIT 1
  `);
  const relationIdsByEntityStmt = db.prepare(`
    SELECT id FROM relations
    WHERE source_entity_id = ? OR target_entity_id = ?
  `);
  const deleteRelationEvidenceByRelationStmt = db.prepare(`
    DELETE FROM relation_evidence WHERE relation_id = ?
  `);
  const deleteRelationsForEntityStmt = db.prepare(`
    DELETE FROM relations
    WHERE source_entity_id = ? OR target_entity_id = ?
  `);
  const upsertRelationStmt = db.prepare(`
    INSERT INTO relations (
      id, relation_type, source_entity_id, target_entity_id,
      confidence, rule_name, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      relation_type = excluded.relation_type,
      source_entity_id = excluded.source_entity_id,
      target_entity_id = excluded.target_entity_id,
      confidence = excluded.confidence,
      rule_name = excluded.rule_name,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
  const insertRelationEvidenceStmt = db.prepare(`
    INSERT INTO relation_evidence (
      id, relation_id, observation_id, evidence_type, description, source_url, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function getEntityLiteRows() {
    return db.prepare(`
      SELECT
        e.*,
        g.geometry_type,
        g.latitude,
        g.longitude,
        g.altitude,
        g.bbox_json,
        g.geometry_json
      FROM entities e
      LEFT JOIN entity_geometry g ON g.entity_id = e.id
    `).all().map((row) => ({
      ...toSummaryRow(row),
      aliasList: db.prepare(`
        SELECT alias FROM entity_aliases WHERE entity_id = ?
      `).all(row.id).map((alias) => alias.alias),
      latestObservation: latestObservationStmt.get(row.id),
    }));
  }

  const rebuildRelationsTx = db.transaction((entityIds) => {
    const touched = new Set(entityIds);
    const touchedRelationIds = new Set();

    for (const entityId of entityIds) {
      const relationIds = relationIdsByEntityStmt.all(entityId, entityId);
      for (const relation of relationIds) {
        deleteRelationEvidenceByRelationStmt.run(relation.id);
      }
      deleteRelationsForEntityStmt.run(entityId, entityId);
    }

    const allEntities = getEntityLiteRows();
    const airports = allEntities.filter((entity) => entity.canonicalType === 'airport');
    const ports = allEntities.filter((entity) => entity.canonicalType === 'port');
    const sensors = allEntities.filter((entity) => entity.canonicalType === 'sensor');
    const bridgeLike = allEntities.filter((entity) =>
      ['bridge', 'tower', 'substation', 'power_site', 'rail_node'].includes(entity.canonicalType),
    );

    function createRelation({
      relationType,
      sourceEntityId,
      targetEntityId,
      confidence,
      ruleName,
      metadata = {},
      symmetric = false,
      description,
      evidenceType = 'observation',
    }) {
      if ((!touched.has(sourceEntityId) && !touched.has(targetEntityId)) || sourceEntityId === targetEntityId) {
        return;
      }

      const id = relationId(relationType, sourceEntityId, targetEntityId, symmetric);
      if (touchedRelationIds.has(id)) {
        return;
      }
      const timestamp = nowIso();
      upsertRelationStmt.run(
        id,
        relationType,
        sourceEntityId,
        targetEntityId,
        clamp(confidence, 0.1, 0.99),
        ruleName,
        JSON.stringify(metadata),
        timestamp,
        timestamp,
      );

      const evidenceRows = [
        latestObservationStmt.get(sourceEntityId),
        latestObservationStmt.get(targetEntityId),
      ].filter(Boolean);

      let index = 0;
      for (const evidence of evidenceRows) {
        insertRelationEvidenceStmt.run(
          `re-${id}-${index}`,
          id,
          evidence.id,
          evidenceType,
          description,
          evidence.source_url || null,
          evidence.valid_at || evidence.fetched_at || timestamp,
        );
        index += 1;
      }

      touchedRelationIds.add(id);
    }

    for (const entity of allEntities) {
      if (!touched.has(entity.id)) {
        continue;
      }

      if (entity.canonicalType === 'aircraft') {
        for (const other of allEntities) {
          if (other.id === entity.id || other.canonicalType !== 'aircraft') {
            continue;
          }

          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            other.geometry.latitude,
            other.geometry.longitude,
          );
          const sameRoute = normalizeText(entity.metadata.originAirport) !== ''
            && normalizeText(entity.metadata.originAirport) === normalizeText(other.metadata.originAirport)
            && normalizeText(entity.metadata.destAirport) !== ''
            && normalizeText(entity.metadata.destAirport) === normalizeText(other.metadata.destAirport);
          const sameOperator = normalizeText(entity.operator) !== '' && normalizeText(entity.operator) === normalizeText(other.operator);
          if (distanceKm <= 120 && (sameRoute || sameOperator || distanceKm <= 40)) {
            createRelation({
              relationType: sameRoute || sameOperator ? 'route_affinity' : 'co_location',
              sourceEntityId: entity.id,
              targetEntityId: other.id,
              confidence: sameRoute ? 0.84 : sameOperator ? 0.78 : 0.62,
              ruleName: sameRoute ? 'same_route_nearby' : sameOperator ? 'same_operator_nearby' : 'nearby_aircraft',
              metadata: { distanceKm },
              symmetric: true,
              description: `${entity.label} and ${other.label} are operating in proximity.`,
            });
          }
        }

        for (const airport of airports) {
          const airportAliases = new Set(
            [normalizeText(airport.label), ...(airport.aliasList ?? []).map((value) => normalizeText(value))]
              .filter(Boolean),
          );
          const dest = normalizeText(entity.metadata.destAirport);
          const origin = normalizeText(entity.metadata.originAirport);
          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            airport.geometry.latitude,
            airport.geometry.longitude,
          );
          if ((dest && airportAliases.has(dest)) || (origin && airportAliases.has(origin)) || distanceKm <= 80) {
            createRelation({
              relationType: 'track_to_facility',
              sourceEntityId: entity.id,
              targetEntityId: airport.id,
              confidence: dest && airportAliases.has(dest) ? 0.9 : origin && airportAliases.has(origin) ? 0.82 : 0.58,
              ruleName: dest && airportAliases.has(dest)
                ? 'airport_code_match_destination'
                : origin && airportAliases.has(origin)
                  ? 'airport_code_match_origin'
                  : 'nearest_airport',
              metadata: { distanceKm },
              description: `${entity.label} is linked to ${airport.label}.`,
            });
          }
        }
      }

      if (entity.canonicalType === 'vessel') {
        for (const other of allEntities) {
          if (other.id === entity.id || other.canonicalType !== 'vessel') {
            continue;
          }

          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            other.geometry.latitude,
            other.geometry.longitude,
          );
          const sameDestination = normalizeText(entity.metadata.destination) !== ''
            && normalizeText(entity.metadata.destination) === normalizeText(other.metadata.destination);
          if (distanceKm <= 60 && (sameDestination || distanceKm <= 20)) {
            createRelation({
              relationType: sameDestination ? 'route_affinity' : 'co_location',
              sourceEntityId: entity.id,
              targetEntityId: other.id,
              confidence: sameDestination ? 0.8 : 0.6,
              ruleName: sameDestination ? 'same_destination_nearby' : 'nearby_vessels',
              metadata: { distanceKm },
              symmetric: true,
              description: `${entity.label} and ${other.label} are operating in surface proximity.`,
            });
          }
        }

        for (const port of ports) {
          const destination = normalizeText(entity.metadata.destination);
          const portLabel = normalizeText(port.label);
          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            port.geometry.latitude,
            port.geometry.longitude,
          );
          if ((destination && (portLabel.includes(destination) || destination.includes(portLabel))) || distanceKm <= 80) {
            createRelation({
              relationType: 'track_to_facility',
              sourceEntityId: entity.id,
              targetEntityId: port.id,
              confidence: destination && (portLabel.includes(destination) || destination.includes(portLabel)) ? 0.82 : 0.55,
              ruleName: destination && (portLabel.includes(destination) || destination.includes(portLabel))
                ? 'port_destination_match'
                : 'nearest_port',
              metadata: { distanceKm },
              description: `${entity.label} is linked to ${port.label}.`,
            });
          }
        }
      }

      if (entity.canonicalType === 'satellite') {
        const altitudeKm = Number(entity.metadata.altitudeKm ?? 0);
        const coverageRadiusKm = Math.sqrt(Math.max((6371 + altitudeKm) ** 2 - 6371 ** 2, 0));
        for (const sensor of sensors) {
          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            sensor.geometry.latitude,
            sensor.geometry.longitude,
          );
          if (distanceKm <= coverageRadiusKm) {
            createRelation({
              relationType: 'coverage_overlap',
              sourceEntityId: entity.id,
              targetEntityId: sensor.id,
              confidence: clamp(1 - distanceKm / Math.max(coverageRadiusKm, 1), 0.45, 0.92),
              ruleName: 'satellite_coverage_radius',
              metadata: { distanceKm, coverageRadiusKm },
              description: `${entity.label} currently covers ${sensor.label}.`,
            });
          }
        }
      }

      if (entity.canonicalType === 'sensor') {
        for (const candidate of allEntities) {
          if (!['aircraft', 'vessel', 'earthquake'].includes(candidate.canonicalType)) {
            continue;
          }

          const limitKm = candidate.canonicalType === 'aircraft' ? 250 : candidate.canonicalType === 'vessel' ? 180 : 120;
          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            candidate.geometry.latitude,
            candidate.geometry.longitude,
          );
          if (distanceKm <= limitKm) {
            createRelation({
              relationType: 'sensor_overlap',
              sourceEntityId: entity.id,
              targetEntityId: candidate.id,
              confidence: clamp(1 - distanceKm / limitKm, 0.35, 0.88),
              ruleName: 'sensor_proximity',
              metadata: { distanceKm },
              description: `${entity.label} is within observational range of ${candidate.label}.`,
            });
          }
        }
      }

      if (entity.canonicalType === 'road_segment') {
        for (const candidate of bridgeLike) {
          const distanceKm = haversineKm(
            entity.geometry.latitude,
            entity.geometry.longitude,
            candidate.geometry.latitude,
            candidate.geometry.longitude,
          );
          if (distanceKm <= 2) {
            createRelation({
              relationType: 'infrastructure_adjacency',
              sourceEntityId: entity.id,
              targetEntityId: candidate.id,
              confidence: clamp(1 - distanceKm / 2, 0.4, 0.86),
              ruleName: 'road_near_infrastructure',
              metadata: { distanceKm },
              description: `${entity.label} is adjacent to ${candidate.label}.`,
            });
          }
        }
      }
    }

    return Array.from(touchedRelationIds);
  });

  function getConnectorState(connectorName, scopeKey) {
    return db.prepare(`
      SELECT * FROM connectors
      WHERE connector_name = ? AND scope_key = ?
    `).get(connectorName, scopeKey);
  }

  async function fetchWikidataEntity(qid) {
    if (!wikidataEntityDataUrl || !/^Q\d+$/i.test(qid)) {
      return null;
    }

    if (wikidataCache.has(qid)) {
      return wikidataCache.get(qid);
    }

    const snapshotKey = `ontology-wikidata-${qid}`;
    const normalizedBaseUrl = wikidataEntityDataUrl.replace(/\/+$/, '');
    const url = `${normalizedBaseUrl}/${qid}.json`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': wikidataUserAgent,
        },
      });
      if (!response.ok) {
        throw new Error(`Wikidata HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (snapshotStore) {
        await snapshotStore.write(snapshotKey, payload);
      }

      const entity = payload?.entities?.[qid];
      const wikidata = entity ? {
        qid,
        label: pickLocalizedValue(entity.labels),
        description: pickLocalizedValue(entity.descriptions),
        aliases: Object.values(entity.aliases || {})
          .flatMap((entries) => Array.isArray(entries) ? entries : [])
          .map((entry) => String(entry?.value ?? '').trim())
          .filter(Boolean),
      } : null;
      wikidataCache.set(qid, wikidata);
      return wikidata;
    } catch (error) {
      if (snapshotStore) {
        const fallback = await snapshotStore.read(snapshotKey);
        const entity = fallback?.entities?.[qid];
        if (entity) {
          const wikidata = {
            qid,
            label: pickLocalizedValue(entity.labels),
            description: pickLocalizedValue(entity.descriptions),
            aliases: Object.values(entity.aliases || {})
              .flatMap((entries) => Array.isArray(entries) ? entries : [])
              .map((entry) => String(entry?.value ?? '').trim())
              .filter(Boolean),
          };
          wikidataCache.set(qid, wikidata);
          return wikidata;
        }
      }
      return null;
    }
  }

  async function fetchGeoNamesCountry(center) {
    if (!geonamesUsername || center.latitude == null || center.longitude == null) {
      return null;
    }

    const cacheKey = `${center.latitude.toFixed(2)},${center.longitude.toFixed(2)}`;
    if (geonamesCache.has(cacheKey)) {
      return geonamesCache.get(cacheKey);
    }

    const snapshotKey = `ontology-geonames-${cacheKey}`;
    const url = new URL('/countryCodeJSON', `${geonamesApiUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('lat', String(center.latitude));
    url.searchParams.set('lng', String(center.longitude));
    url.searchParams.set('username', geonamesUsername);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': wikidataUserAgent,
        },
      });
      if (!response.ok) {
        throw new Error(`GeoNames HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (snapshotStore) {
        await snapshotStore.write(snapshotKey, payload);
      }

      const geonames = payload?.countryCode ? {
        countryCode: String(payload.countryCode).trim(),
        countryName: String(payload.countryName || '').trim(),
      } : null;
      geonamesCache.set(cacheKey, geonames);
      return geonames;
    } catch {
      if (snapshotStore) {
        const fallback = await snapshotStore.read(snapshotKey);
        const geonames = fallback?.countryCode ? {
          countryCode: String(fallback.countryCode).trim(),
          countryName: String(fallback.countryName || '').trim(),
        } : null;
        geonamesCache.set(cacheKey, geonames);
        return geonames;
      }
      return null;
    }
  }

  async function buildInfrastructureEnrichment(elements) {
    const enriched = new Map();
    if (!Array.isArray(elements) || elements.length === 0) {
      return enriched;
    }

    const wikidataIds = Array.from(new Set(
      elements
        .map((element) => String(element?.tags?.wikidata ?? '').trim())
        .filter((value) => /^Q\d+$/i.test(value)),
    ));
    const wikidataResults = await Promise.all(wikidataIds.map((qid) => fetchWikidataEntity(qid)));
    const wikidataMap = new Map();
    for (const wikidata of wikidataResults) {
      if (wikidata?.qid) {
        wikidataMap.set(wikidata.qid, wikidata);
      }
    }

    for (const element of elements) {
      const sourceRecordId = `${element.type}:${element.id}`;
      const wikidataId = String(element?.tags?.wikidata ?? '').trim();
      const center = element.type === 'node'
        ? { latitude: element.lat ?? null, longitude: element.lon ?? null }
        : Array.isArray(element.geometry) && element.geometry.length > 0
          ? computeCenterFromGeometry('LineString', {
            points: element.geometry.map((point) => ({
              latitude: Number(point.lat),
              longitude: Number(point.lon),
              altitude: 0,
            })),
          })
          : {
            latitude: element.center?.lat ?? null,
            longitude: element.center?.lon ?? null,
          };

      const geonames = !element?.tags?.['addr:country']
        ? await fetchGeoNamesCountry(center)
        : null;
      enriched.set(sourceRecordId, {
        wikidata: wikidataMap.get(wikidataId) ?? null,
        geonames,
      });
    }

    return enriched;
  }

  async function fetchOverpassInfrastructure(bbox, entityTypes, scopeKey) {
    const query = buildOverpassQuery(bbox, entityTypes);
    if (!query) {
      return [];
    }

    const snapshotKey = `ontology-osm-${stableId(scopeKey, entityTypes.join(','))}`;
    let lastError = null;

    for (const url of overpassUrls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!response.ok) {
          throw new Error(`Overpass HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (snapshotStore) {
          await snapshotStore.write(snapshotKey, payload);
        }
        return payload.elements || [];
      } catch (error) {
        lastError = error;
      }
    }

    if (snapshotStore) {
      const fallback = await snapshotStore.read(snapshotKey);
      if (fallback?.elements) {
        return fallback.elements;
      }
    }

    throw lastError || new Error('Overpass fetch failed');
  }

  async function ensureInfrastructureForSearch({ bbox, layerIds }) {
    if (!bbox || !layerIds || layerIds.length === 0) {
      return;
    }

    const entityTypes = getEntityTypesForLayerIds(layerIds).filter((type) =>
      ['airport', 'port', 'military_site', 'power_site', 'substation', 'tower', 'rail_node', 'bridge', 'road_segment', 'facility'].includes(type),
    );
    if (entityTypes.length === 0) {
      return;
    }

    const scopeKey = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}:${entityTypes.join(',')}`;
    const connectorState = getConnectorState('osm_infrastructure', scopeKey);
    const lastSuccess = connectorState?.last_success_at ? Date.parse(connectorState.last_success_at) : 0;
    if (lastSuccess && Date.now() - lastSuccess < INFRA_REFRESH_SECONDS * 1000) {
      return;
    }

    const runId = beginRun('osm_infrastructure', scopeKey);
    try {
      const elements = await fetchOverpassInfrastructure(bbox, entityTypes, scopeKey);
      const fetchedAt = nowIso();
      const enrichmentByRecordId = await buildInfrastructureEnrichment(elements);
      const records = elements
        .map((element) => normalizeOsmElement(
          element,
          fetchedAt,
          enrichmentByRecordId.get(`${element.type}:${element.id}`) ?? null,
        ))
        .filter(Boolean);
      const impacted = upsertRecordTx(records);
      rebuildRelationsTx(impacted);
      finishRun(runId, 'osm_infrastructure', scopeKey, 'success', records.length, null, { bbox, entityTypes });
    } catch (error) {
      finishRun(runId, 'osm_infrastructure', scopeKey, 'error', 0, error.message, { bbox, entityTypes });
      console.warn('[ONTOLOGY] Infrastructure refresh failed:', error.message);
    }
  }

  async function syncFromFrontend(payload) {
    const fetchedAt = nowIso();
    const records = normalizeSyncPayload(payload, fetchedAt);
    const runId = beginRun('frontend_sync', 'global');
    try {
      const impacted = upsertRecordTx(records);
      rebuildRelationsTx(impacted);
      finishRun(runId, 'frontend_sync', 'global', 'success', records.length, null, {
        flights: payload.flights?.length ?? 0,
        ships: payload.ships?.length ?? 0,
        satellites: payload.satellites?.length ?? 0,
        cameras: payload.cameras?.length ?? 0,
        earthquakes: payload.earthquakes?.length ?? 0,
        roads: payload.roads?.length ?? 0,
      });
      return { ok: true, recordCount: records.length, impactedEntityCount: impacted.length };
    } catch (error) {
      finishRun(runId, 'frontend_sync', 'global', 'error', 0, error.message, {});
      throw error;
    }
  }

  function searchEntities({
    q = '',
    limit = 50,
    layerIds = [],
    canonicalTypes = [],
    source = '',
    country = '',
    minConfidence = 0,
    freshnessHours = 0,
    bbox = null,
    includeSynthetic = false,
  }) {
    const clauses = [];
    const params = [];

    if (q.trim()) {
      clauses.push(`(
        e.normalized_label LIKE ?
        OR EXISTS (
          SELECT 1 FROM entity_aliases a
          WHERE a.entity_id = e.id AND a.normalized_alias LIKE ?
        )
      )`);
      const like = `%${normalizeText(q)}%`;
      params.push(like, like);
    }

    if (canonicalTypes.length > 0) {
      clauses.push(`e.canonical_type IN (${canonicalTypes.map(() => '?').join(',')})`);
      params.push(...canonicalTypes);
    } else if (layerIds.length > 0) {
      const types = getEntityTypesForLayerIds(layerIds);
      if (types.length > 0) {
        clauses.push(`e.canonical_type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }

    if (!includeSynthetic) {
      clauses.push(`e.origin != 'synthetic'`);
    }

    if (source) {
      clauses.push(`
        EXISTS (
          SELECT 1 FROM observations o
          WHERE o.entity_id = e.id AND o.connector_name = ?
        )
      `);
      params.push(source);
    }

    if (country) {
      clauses.push(`e.country_code = ?`);
      params.push(country);
    }

    if (minConfidence > 0) {
      clauses.push(`e.confidence >= ?`);
      params.push(minConfidence);
    }

    if (freshnessHours > 0) {
      clauses.push(`e.last_observed_at >= ?`);
      params.push(new Date(Date.now() - freshnessHours * 3600 * 1000).toISOString());
    }

    if (bbox) {
      clauses.push(`g.latitude BETWEEN ? AND ? AND g.longitude BETWEEN ? AND ?`);
      params.push(bbox.south, bbox.north, bbox.west, bbox.east);
    }

    const sql = `
      SELECT
        e.*,
        g.geometry_type,
        g.latitude,
        g.longitude,
        g.altitude,
        g.bbox_json,
        g.geometry_json
      FROM entities e
      LEFT JOIN entity_geometry g ON g.entity_id = e.id
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY e.last_observed_at DESC NULLS LAST, e.confidence DESC, e.label ASC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);
    return rows.map(toSummaryRow);
  }

  function listRelations({ entityId = null, relationType = '', limit = 100 }) {
    const clauses = [];
    const params = [];

    if (entityId) {
      clauses.push('(r.source_entity_id = ? OR r.target_entity_id = ?)');
      params.push(entityId, entityId);
    }
    if (relationType) {
      clauses.push('r.relation_type = ?');
      params.push(relationType);
    }

    const rows = db.prepare(`
      SELECT
        r.*,
        se.label AS source_label,
        se.canonical_type AS source_type,
        sg.latitude AS source_latitude,
        sg.longitude AS source_longitude,
        sg.altitude AS source_altitude,
        te.label AS target_label,
        te.canonical_type AS target_type,
        tg.latitude AS target_latitude,
        tg.longitude AS target_longitude,
        tg.altitude AS target_altitude
      FROM relations r
      LEFT JOIN entities se ON se.id = r.source_entity_id
      LEFT JOIN entity_geometry sg ON sg.entity_id = se.id
      LEFT JOIN entities te ON te.id = r.target_entity_id
      LEFT JOIN entity_geometry tg ON tg.entity_id = te.id
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY r.confidence DESC, r.updated_at DESC
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => ({
      id: row.id,
      relationType: row.relation_type,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      confidence: row.confidence,
      ruleName: row.rule_name,
      metadata: parseJson(row.metadata_json, {}),
      source: {
        id: row.source_entity_id,
        label: row.source_label,
        canonicalType: row.source_type,
        latitude: row.source_latitude,
        longitude: row.source_longitude,
        altitude: row.source_altitude ?? 0,
      },
      target: {
        id: row.target_entity_id,
        label: row.target_label,
        canonicalType: row.target_type,
        latitude: row.target_latitude,
        longitude: row.target_longitude,
        altitude: row.target_altitude ?? 0,
      },
    }));
  }

  function getEntity(entityId) {
    const row = db.prepare(`
      SELECT
        e.*,
        g.geometry_type,
        g.latitude,
        g.longitude,
        g.altitude,
        g.bbox_json,
        g.geometry_json
      FROM entities e
      LEFT JOIN entity_geometry g ON g.entity_id = e.id
      WHERE e.id = ?
    `).get(entityId);

    if (!row) {
      return null;
    }

    const entity = toSummaryRow(row);
    const aliases = db.prepare(`
      SELECT alias, source_name FROM entity_aliases
      WHERE entity_id = ?
      ORDER BY alias ASC
    `).all(entityId);
    const observations = db.prepare(`
      SELECT id, connector_name, source_name, source_record_id, source_url, fetched_at, valid_at, metadata_json
      FROM observations
      WHERE entity_id = ?
      ORDER BY valid_at DESC, fetched_at DESC
      LIMIT 8
    `).all(entityId).map((observation) => ({
      id: observation.id,
      connectorName: observation.connector_name,
      sourceName: observation.source_name,
      sourceRecordId: observation.source_record_id,
      sourceUrl: observation.source_url,
      fetchedAt: observation.fetched_at,
      validAt: observation.valid_at,
      metadata: parseJson(observation.metadata_json, {}),
    }));

    return {
      ...entity,
      aliases,
      aliasList: aliases.map((alias) => alias.alias),
      observations,
      sourceConnectors: Array.from(new Set(observations.map((observation) => observation.connectorName))),
      relations: listRelations({ entityId, limit: 24 }),
    };
  }

  function getEvidence(entityId, page = 1, pageSize = 20) {
    const offset = Math.max(0, (page - 1) * pageSize);
    const observationRows = db.prepare(`
      SELECT
        o.id,
        o.connector_name,
        o.source_name,
        o.source_record_id,
        o.source_url,
        o.fetched_at,
        o.valid_at,
        o.metadata_json
      FROM observations o
      WHERE o.entity_id = ?
      ORDER BY o.valid_at DESC, o.fetched_at DESC
      LIMIT ? OFFSET ?
    `).all(entityId, pageSize, offset);

    const relationEvidenceRows = db.prepare(`
      SELECT
        re.id,
        re.relation_id,
        re.observation_id,
        re.evidence_type,
        re.description,
        re.source_url,
        re.recorded_at,
        r.relation_type,
        r.source_entity_id,
        r.target_entity_id
      FROM relation_evidence re
      INNER JOIN relations r ON r.id = re.relation_id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      ORDER BY re.recorded_at DESC
      LIMIT ? OFFSET ?
    `).all(entityId, entityId, pageSize, offset);

    return [
      ...observationRows.map((row) => ({
        id: row.id,
        kind: 'observation',
        connectorName: row.connector_name,
        sourceName: row.source_name,
        sourceRecordId: row.source_record_id,
        sourceUrl: row.source_url,
        recordedAt: row.valid_at || row.fetched_at,
        metadata: parseJson(row.metadata_json, {}),
      })),
      ...relationEvidenceRows.map((row) => ({
        id: row.id,
        kind: 'relation',
        relationId: row.relation_id,
        relationType: row.relation_type,
        observationId: row.observation_id,
        evidenceType: row.evidence_type,
        description: row.description,
        sourceUrl: row.source_url,
        recordedAt: row.recorded_at,
        sourceEntityId: row.source_entity_id,
        targetEntityId: row.target_entity_id,
      })),
    ].sort((left, right) => String(right.recordedAt).localeCompare(String(left.recordedAt)));
  }

  function listLayers() {
    const rows = db.prepare(`
      SELECT * FROM layer_defs ORDER BY category ASC, label ASC
    `).all();

    return rows.map((row) => {
      const entityTypes = parseJson(row.entity_types_json, []);
      const placeholders = entityTypes.map(() => '?').join(',');
      const count = entityTypes.length > 0
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM entities
            WHERE canonical_type IN (${placeholders})
          `).get(...entityTypes)?.count ?? 0
        : 0;

      return {
        id: row.id,
        label: row.label,
        category: row.category,
        description: row.description,
        sourceName: row.source_name,
        entityTypes,
        defaultEnabled: Boolean(row.default_enabled),
        style: parseJson(row.style_json, {}),
        refreshIntervalSeconds: row.refresh_interval_seconds,
        entityCount: count,
      };
    });
  }

  function listPresets() {
    return db.prepare(`
      SELECT * FROM saved_presets ORDER BY updated_at DESC, name ASC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      filters: parseJson(row.filters_json, {}),
      layerIds: parseJson(row.layer_ids_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function listConnectorStatus() {
    const items = db.prepare(`
      SELECT connector_name, scope_key, status, last_run_at, last_success_at, last_error, metadata_json
      FROM connectors
      ORDER BY connector_name ASC, scope_key ASC
    `).all().map((row) => ({
      connectorName: row.connector_name,
      scopeKey: row.scope_key,
      status: row.status,
      lastRunAt: row.last_run_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      metadata: parseJson(row.metadata_json, {}),
    }));

    return {
      configured: {
        overpassUrls,
        wikidataEntityDataUrl: wikidataEntityDataUrl || null,
        wikidataEnabled: Boolean(wikidataEntityDataUrl),
        geonamesApiUrl: geonamesUsername ? geonamesApiUrl : null,
        geonamesEnabled: Boolean(geonamesUsername),
      },
      items,
    };
  }

  function savePreset({ id = null, name, description = '', filters = {}, layerIds = [] }) {
    if (!name || typeof name !== 'string') {
      throw new Error('Preset name is required');
    }

    const presetId = id || `preset-${stableId(name, JSON.stringify(layerIds), JSON.stringify(filters))}`;
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO saved_presets (id, name, description, filters_json, layer_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        filters_json = excluded.filters_json,
        layer_ids_json = excluded.layer_ids_json,
        updated_at = excluded.updated_at
    `).run(
      presetId,
      name,
      description,
      JSON.stringify(filters),
      JSON.stringify(layerIds),
      timestamp,
      timestamp,
    );

    return {
      id: presetId,
      name,
      description,
      filters,
      layerIds,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  return {
    db,
    syncFromFrontend,
    ensureInfrastructureForSearch,
    searchEntities,
    getEntity,
    getEvidence,
    listLayers,
    listRelations,
    listConnectorStatus,
    listPresets,
    savePreset,
  };
}
