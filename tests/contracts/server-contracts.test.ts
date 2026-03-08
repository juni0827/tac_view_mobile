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
    vi.stubGlobal('fetch', fetchMock);

    const serverModule = await import('../../server/app.js');
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
});
