import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function binaryResponse(bytes: number[], contentType = 'image/jpeg', status = 200) {
  return new Response(Uint8Array.from(bytes), {
    status,
    headers: {
      'content-type': contentType,
    },
  });
}

const originalEnv = { ...process.env };
const fetchMock = vi.fn();
const authHeader = { 'x-tac-view-token': 'contract-token' };

let tempDir: string;
let app: import('express').Express;
let stopBackgroundTasks: (() => void) | undefined;

describe('server contracts', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tac-view-contracts-'));
    process.env.TAC_VIEW_DISABLE_BACKGROUND_TASKS = '1';
    process.env.TAC_VIEW_AUTH_TOKEN = 'contract-token';
    process.env.TAC_VIEW_SNAPSHOT_DIR = path.join(tempDir, 'snapshots');
    process.env.NSW_TRANSPORT_API_KEY = 'nsw-test-key';
    process.env.ACLED_ACCESS_KEY = 'acled-test-key';
    process.env.ACLED_EMAIL = 'ops@example.com';
    process.env.RELIEFWEB_APPNAME = 'TacViewContracts';
    process.env.NEWS_API_KEY = 'news-test-key';
    vi.stubGlobal('fetch', fetchMock);

    const serverModule = await import('../../../app/server/app.js');
    app = serverModule.app;
    stopBackgroundTasks = serverModule.stopBackgroundTasks;
  });

  afterAll(async () => {
    stopBackgroundTasks?.();
    vi.unstubAllGlobals();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('protects /api routes with the desktop auth token', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(401);
  });

  it('returns runtime health metadata', async () => {
    const response = await request(app).get('/api/health').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.runtime.authTokenEnabled).toBe(true);
    expect(response.body.runtime.ontology).toMatchObject({
      overpassUrlCount: expect.any(Number),
      wikidataEnabled: expect.any(Boolean),
      geonamesEnabled: expect.any(Boolean),
    });
    expect(response.body.runtime.externalIntel).toMatchObject({
      acledConfigured: true,
      gdeltConfigured: true,
      reliefwebConfigured: true,
      newsApiConfigured: true,
    });
  });

  it('normalizes geolocation responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'success',
      lat: 37.7749,
      lon: -122.4194,
      city: 'San Francisco',
      country: 'United States',
      countryCode: 'US',
      regionName: 'California',
      query: '203.0.113.10',
    }));

    const response = await request(app).get('/api/geolocation').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      latitude: 37.7749,
      longitude: -122.4194,
      countryCode: 'US',
    });
  });

  it('normalizes Overpass traffic responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      elements: [
        {
          type: 'way',
          id: 42,
          tags: {
            name: 'Main Street',
            highway: 'primary',
            maxspeed: '60',
          },
          geometry: [
            { lat: -33.867, lon: 151.207 },
            { lat: -33.866, lon: 151.208 },
          ],
        },
      ],
    }));

    const response = await request(app)
      .get('/api/traffic/roads?south=-33.87&west=151.20&north=-33.86&east=151.21')
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('overpass');
    expect(response.body.roads[0]).toMatchObject({
      id: 'way:42',
      name: 'Main Street',
      highway: 'primary',
    });
  });

  it('returns TLE payloads from the satellites endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      member: [
        {
          name: 'ISS (ZARYA)',
          line1: '1 25544U 98067A   24001.00000000  .00016717  00000+0  10270-3 0  9993',
          line2: '2 25544  51.6415 352.6767 0004026 123.4495 307.1889 15.50000000432109',
        },
      ],
    }));

    const response = await request(app).get('/api/satellites?group=stations').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.text).toContain('ISS (ZARYA)');
  });

  it('aggregates CCTV feeds and preserves the response contract', async () => {
    fetchMock.mockImplementation((input: URL | RequestInfo) => {
      const url = String(input);

      if (url.includes('api.tfl.gov.uk')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'jam-1',
            commonName: 'TfL Cam',
            placeType: 'JamCam',
            lat: 51.5,
            lon: -0.1,
            additionalProperties: [
              { key: 'imageUrl', value: 'https://cams.example/tfl.jpg' },
              { key: 'available', value: 'true' },
            ],
          },
        ]));
      }

      if (url.includes('data.austintexas.gov')) {
        return Promise.resolve(jsonResponse([
          {
            camera_id: 'cam-2',
            location_name: 'Austin Cam',
            camera_status: 'TURNED_ON',
            screenshot_address: 'https://cams.example/austin.jpg',
            modified_date: '2026-03-07T00:00:00Z',
            location: {
              coordinates: [-97.74, 30.27],
            },
          },
        ]));
      }

      if (url.includes('transport.nsw.gov.au')) {
        return Promise.resolve(jsonResponse({
          features: [
            {
              id: 'cam-3',
              properties: {
                title: 'NSW Cam',
                region: 'Sydney',
                href: 'https://cams.example/nsw.jpg',
                direction: 'Northbound',
              },
              geometry: {
                coordinates: [151.2, -33.86],
              },
            },
          ],
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const response = await request(app).get('/api/cctv').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.body.meta.totalCameras).toBe(3);
    expect(response.body.cameras).toHaveLength(3);
  });

  it('proxies CCTV images without changing the content type', async () => {
    fetchMock.mockResolvedValueOnce(binaryResponse([1, 2, 3, 4], 'image/png'));

    const response = await request(app)
      .get('/api/cctv/image')
      .query({ url: 'https://cams.example/frame.png' })
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(Array.isArray(response.body)).toBe(false);
  });

  it('aggregates external intel feeds across ACLED, GDELT, ReliefWeb, and NewsAPI', async () => {
    fetchMock.mockImplementation((input: URL | RequestInfo) => {
      const url = String(input);

      if (url.startsWith('https://acleddata.com/api/acled/read')) {
        return Promise.resolve(jsonResponse({
          data: [
            {
              event_id_cnty: 'acled-1',
              event_date: '2026-03-11',
              event_type: 'Battles',
              sub_event_type: 'Armed clash',
              country: 'Sudan',
              admin1: 'Khartoum',
              location: 'Omdurman',
              latitude: 15.65,
              longitude: 32.48,
              fatalities: 12,
              notes: 'Heavy clashes reported near key logistics routes.',
            },
          ],
        }));
      }

      if (url.startsWith('https://api.gdeltproject.org/api/v2/doc/doc')) {
        return Promise.resolve(jsonResponse({
          articles: [
            {
              url: 'https://news.example/gdelt-story',
              title: 'Military logistics disrupted near Red Sea port',
              seendate: '20260312T020000Z',
              domain: 'news.example',
              language: 'English',
              sourcecountry: 'Egypt',
            },
          ],
        }));
      }

      if (url.startsWith('https://api.reliefweb.int/v2/reports')) {
        return Promise.resolve(jsonResponse({
          data: [
            {
              id: 9001,
              fields: {
                title: 'Flooding situation report',
                headline: {
                  summary: 'Rapid assessment teams deployed after severe flooding.',
                },
                date: {
                  created: '2026-03-12T01:00:00.000Z',
                },
                source: [{ shortname: 'OCHA' }],
                primary_country: { name: 'Mozambique' },
                url_alias: 'https://reliefweb.int/report/mozambique/flooding-situation-report',
              },
            },
          ],
        }));
      }

      if (url.startsWith('https://newsapi.org/v2/everything')) {
        return Promise.resolve(jsonResponse({
          articles: [
            {
              source: { name: 'Global Desk' },
              title: 'Airport operations resume after storm disruption',
              description: 'Crews restored flight operations following overnight damage assessments.',
              url: 'https://news.example/newsapi-story',
              publishedAt: '2026-03-12T03:00:00.000Z',
            },
          ],
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const response = await request(app)
      .get('/api/intel/briefing')
      .query({ lat: 15.6, lon: 32.5, radiusKm: 300, limit: 8 })
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { source: string }) => item.source)).toEqual(expect.arrayContaining([
      'acled',
      'gdelt',
      'reliefweb',
      'newsapi',
    ]));
    expect(response.body.sources).toMatchObject({
      acled: expect.objectContaining({ configured: true, ok: true, itemCount: 1 }),
      gdelt: expect.objectContaining({ configured: true, ok: true, itemCount: 1 }),
      reliefweb: expect.objectContaining({ configured: true, ok: true, itemCount: 1 }),
      newsapi: expect.objectContaining({ configured: true, ok: true, itemCount: 1 }),
    });
    expect(response.body.items[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      summary: expect.any(String),
      category: expect.any(String),
      severity: expect.any(String),
      publishedAt: expect.any(String),
    });
  });

  it('passes through the GDELT GEO payload for geospatial intel overlays', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Port cluster', value: 3 },
          geometry: { type: 'Point', coordinates: [32.5, 15.6] },
        },
      ],
    }));

    const response = await request(app)
      .get('/api/intel/gdelt/geo')
      .query({ q: 'port', lat: 15.6, lon: 32.5, radiusKm: 250 })
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('gdelt-geo');
    expect(response.body.payload.type).toBe('FeatureCollection');
    expect(response.body.payload.features).toHaveLength(1);
  });

  it('normalizes regional live flight responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      aircraft: [
        {
          hex: 'ABC123',
          flight: 'WVA101',
          r: 'HL0001',
          t: 'A321',
          desc: 'Test Aircraft',
          ownOp: 'Tac View Air',
          lat: 37.5,
          lon: 127.0,
          alt_baro: 32000,
          gs: 430,
          track: 84,
          baro_rate: 0,
          squawk: '1200',
          category: 'A3',
        },
      ],
    }));

    const response = await request(app)
      .get('/api/flights/live?lat=37.5&lon=127.0&dist=25')
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      icao24: 'abc123',
      callsign: 'WVA101',
      altitudeFeet: 32000,
    });
  });

  it('normalizes global flight responses', async () => {
    fetchMock.mockImplementation((input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('flightradar24.com')) {
        return Promise.resolve(jsonResponse({
          full_count: 1,
          abc: [
            'abc123',
            37.5,
            127.0,
            90,
            35000,
            450,
            '1200',
            '',
            'A321',
            'HL0001',
            0,
            'RKSI',
            'RJTT',
            'WVA101',
            '',
            0,
            '',
            '',
            'Tac View Air',
          ],
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const response = await request(app).get('/api/flights').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      icao24: 'abc123',
      originAirport: 'RKSI',
      destAirport: 'RJTT',
    });
  });

  it('serves cached ship snapshots without opening a websocket burst', async () => {
    const snapshotPath = path.join(tempDir, 'snapshots', 'ships-moving.json');
    await writeFile(snapshotPath, JSON.stringify({
      updatedAt: '2026-03-07T00:00:00Z',
      value: [
        {
          mmsi: '123456789',
          name: 'MV Test',
          latitude: 35.1,
          longitude: 129.0,
          heading: 180,
          cog: 180,
          sog: 12.5,
          navStatus: 0,
          shipType: 70,
          destination: 'BUSAN',
          imo: 1234567,
          callSign: 'D7AB',
          length: 200,
          width: 32,
          country: 'KR',
          countryCode: 'KR',
          timestamp: '2026-03-07T00:00:00Z',
        },
      ],
    }), 'utf8');

    const response = await request(app).get('/api/ships?moving=1').set(authHeader);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      mmsi: '123456789',
      destination: 'BUSAN',
    });
  });

  it('syncs ontology snapshots and exposes search, detail, evidence, and relations APIs', async () => {
    const syncResponse = await request(app)
      .post('/api/ontology/sync')
      .set(authHeader)
      .send({
        flights: [
          {
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
          },
          {
            icao24: 'def456',
            callsign: 'TAC202',
            registration: 'N202TV',
            aircraftType: 'A321',
            latitude: 37.66,
            longitude: -122.33,
            altitude: 10950,
            velocityKnots: 418,
            heading: 94,
            originAirport: 'SFO',
            destAirport: 'LAX',
            airline: 'Tac View Air',
            operator: 'Tac View Air',
          },
        ],
        ships: [],
        satellites: [],
        cameras: [],
        earthquakes: [],
        roads: [],
      });

    expect(syncResponse.status).toBe(200);
    expect(syncResponse.body.ok).toBe(true);
    expect(syncResponse.body.recordCount).toBe(2);

    const searchResponse = await request(app)
      .get('/api/ontology/search?q=TAC101')
      .set(authHeader);
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.items[0]).toMatchObject({
      id: 'flight-abc123',
      canonicalType: 'aircraft',
    });

    const detailResponse = await request(app)
      .get('/api/ontology/entities/flight-abc123')
      .set(authHeader);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.observations.length).toBeGreaterThan(0);

    const evidenceResponse = await request(app)
      .get('/api/ontology/entities/flight-abc123/evidence?page=1&pageSize=10')
      .set(authHeader);
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.body.items.length).toBeGreaterThan(0);

    const relationsResponse = await request(app)
      .get('/api/ontology/relations?entityId=flight-abc123')
      .set(authHeader);
    expect(relationsResponse.status).toBe(200);
    expect(relationsResponse.body.items.some((item: { ruleName: string }) => item.ruleName === 'same_route_nearby')).toBe(true);
  });

  it('lists ontology layers and refreshes infrastructure-backed ontology entities', async () => {
    const facilitySyncResponse = await request(app)
      .post('/api/ontology/sync')
      .set(authHeader)
      .send({
        flights: [],
        ships: [],
        satellites: [],
        cameras: [
          {
            id: 'facility-cam',
            name: 'Facility Watch',
            source: 'caltrans',
            country: 'US',
            countryName: 'United States',
            region: 'California',
            latitude: 37.631,
            longitude: -122.389,
            imageUrl: 'https://cams.example/facility.jpg',
            available: true,
            lastUpdated: '2026-03-07T00:00:00.000Z',
          },
        ],
        earthquakes: [],
        roads: [],
      });

    expect(facilitySyncResponse.status).toBe(200);

    const layersResponse = await request(app)
      .get('/api/ontology/layers')
      .set(authHeader);

    expect(layersResponse.status).toBe(200);
    expect(layersResponse.body.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      'ontology-aircraft',
      'ontology-vessels',
      'ontology-satellites',
      'ontology-sensors',
      'ontology-earthquakes',
      'ontology-airports',
      'ontology-ports',
      'ontology-military-sites',
      'ontology-power-sites',
      'ontology-towers',
      'ontology-rail-nodes',
      'ontology-bridges',
      'ontology-roads',
      'ontology-facilities',
    ]));

    fetchMock.mockImplementation((input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.includes('overpass')) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      return Promise.resolve(jsonResponse({
        elements: [
          {
            type: 'node',
            id: 101,
            lat: 37.61,
            lon: -122.41,
            tags: { aeroway: 'aerodrome', name: 'Bravo Airfield', iata: 'BRV', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 102,
            lat: 37.62,
            lon: -122.4,
            tags: { harbour: 'yes', name: 'Harbor Gate', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 103,
            lat: 37.63,
            lon: -122.39,
            tags: { military: 'naval_base', name: 'Delta Base', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 104,
            lat: 37.64,
            lon: -122.38,
            tags: { power: 'plant', name: 'Grid One', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 105,
            lat: 37.65,
            lon: -122.37,
            tags: { power: 'substation', name: 'South Substation', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 106,
            lat: 37.66,
            lon: -122.36,
            tags: { man_made: 'tower', name: 'Signal Tower', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 107,
            lat: 37.67,
            lon: -122.35,
            tags: { railway: 'station', name: 'Central Junction', 'addr:country': 'US' },
          },
          {
            type: 'way',
            id: 108,
            center: { lat: 37.68, lon: -122.34 },
            geometry: [
              { lat: 37.679, lon: -122.341 },
              { lat: 37.681, lon: -122.339 },
            ],
            tags: { bridge: 'yes', name: 'Bay Bridge', 'addr:country': 'US' },
          },
          {
            type: 'way',
            id: 109,
            center: { lat: 37.69, lon: -122.33 },
            geometry: [
              { lat: 37.689, lon: -122.331 },
              { lat: 37.691, lon: -122.329 },
            ],
            tags: { highway: 'primary', name: 'Main Causeway', 'addr:country': 'US' },
          },
          {
            type: 'node',
            id: 110,
            lat: 37.6304,
            lon: -122.3897,
            tags: { amenity: 'hospital', name: 'Civic Medical Center', 'addr:country': 'US' },
          },
        ],
      }));
    });

    const searchResponse = await request(app)
      .get('/api/ontology/search')
      .query({
        layers: [
          'ontology-airports',
          'ontology-ports',
          'ontology-military-sites',
          'ontology-power-sites',
          'ontology-towers',
          'ontology-rail-nodes',
          'ontology-bridges',
          'ontology-roads',
          'ontology-facilities',
        ].join(','),
        south: 37.5,
        west: -122.5,
        north: 37.8,
        east: -122.2,
        limit: 50,
      })
      .set(authHeader);

    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.items.map((item: { canonicalType: string }) => item.canonicalType)).toEqual(expect.arrayContaining([
      'airport',
      'port',
      'military_site',
      'power_site',
      'substation',
      'tower',
      'rail_node',
      'bridge',
      'road_segment',
      'facility',
    ]));

    const facilityDetailResponse = await request(app)
      .get('/api/ontology/entities/facility-facility-node-110')
      .set(authHeader);

    expect(facilityDetailResponse.status).toBe(200);
    expect(facilityDetailResponse.body.canonicalType).toBe('facility');
    expect(facilityDetailResponse.body.relations.some((relation: { ruleName: string }) =>
      ['facility_near_sensor', 'facility_near_road'].includes(relation.ruleName))).toBe(true);

    const connectorsResponse = await request(app)
      .get('/api/ontology/connectors')
      .set(authHeader);

    expect(connectorsResponse.status).toBe(200);
    expect(connectorsResponse.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorName: 'osm_infrastructure',
        status: 'success',
        metadata: expect.objectContaining({
          entityTypes: expect.arrayContaining([
            'airport',
            'port',
            'military_site',
            'power_site',
            'substation',
            'tower',
            'rail_node',
            'bridge',
            'road_segment',
            'facility',
          ]),
        }),
      }),
    ]));
  });

  it('saves and lists ontology presets', async () => {
    const createResponse = await request(app)
      .post('/api/ontology/presets')
      .set(authHeader)
      .send({
        name: 'Harbor Watch',
        description: 'Ports and sensors around current AOI',
        filters: {
          canonicalTypes: ['port', 'sensor'],
          country: 'US',
          minConfidence: 0.6,
        },
        layerIds: ['infra-ports', 'dynamic-sensors'],
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.name).toBe('Harbor Watch');

    const listResponse = await request(app)
      .get('/api/ontology/presets')
      .set(authHeader);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.items.some((item: { name: string }) => item.name === 'Harbor Watch')).toBe(true);
  });

  it('lists ontology connector configuration and runtime state', async () => {
    const response = await request(app)
      .get('/api/ontology/connectors')
      .set(authHeader);

    expect(response.status).toBe(200);
    expect(response.body.configured).toMatchObject({
      overpassUrls: expect.any(Array),
      wikidataEnabled: expect.any(Boolean),
      geonamesEnabled: expect.any(Boolean),
    });
    expect(Array.isArray(response.body.items)).toBe(true);
  });
});
