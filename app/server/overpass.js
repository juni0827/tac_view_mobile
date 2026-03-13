const LEGACY_OVERPASS_URL_ALIASES = new Map([
  ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
]);

export const DEFAULT_OVERPASS_URLS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/cgi/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

function getBboxSpan(bbox) {
  return Math.max(
    Math.abs(Number(bbox?.north ?? 0) - Number(bbox?.south ?? 0)),
    Math.abs(Number(bbox?.east ?? 0) - Number(bbox?.west ?? 0)),
  );
}

function splitBbox(bbox) {
  const midLat = (bbox.south + bbox.north) / 2;
  const midLon = (bbox.west + bbox.east) / 2;
  return [
    { south: bbox.south, west: bbox.west, north: midLat, east: midLon },
    { south: bbox.south, west: midLon, north: midLat, east: bbox.east },
    { south: midLat, west: bbox.west, north: bbox.north, east: midLon },
    { south: midLat, west: midLon, north: bbox.north, east: bbox.east },
  ].filter((tile) => tile.north > tile.south && tile.east > tile.west);
}

function tileBbox(bbox, maxSpan) {
  const safeMaxSpan = Math.max(0.05, Number(maxSpan) || 0.5);
  const tiles = [];
  for (let south = bbox.south; south < bbox.north; south += safeMaxSpan) {
    const north = Math.min(bbox.north, south + safeMaxSpan);
    for (let west = bbox.west; west < bbox.east; west += safeMaxSpan) {
      const east = Math.min(bbox.east, west + safeMaxSpan);
      tiles.push({ south, west, north, east });
    }
  }
  return tiles.length > 0 ? tiles : [bbox];
}

function mergeOverpassElement(previous, next) {
  if (!previous) {
    return next;
  }

  return {
    ...previous,
    ...next,
    tags: { ...(previous.tags || {}), ...(next.tags || {}) },
    geometry: Array.isArray(previous.geometry) && previous.geometry.length > 0
      ? previous.geometry
      : next.geometry,
    center: previous.center || next.center,
  };
}

function dedupeOverpassElements(elements) {
  const deduped = new Map();

  for (const element of elements) {
    if (!element?.type || element?.id == null) {
      continue;
    }

    const key = `${element.type}:${element.id}`;
    deduped.set(key, mergeOverpassElement(deduped.get(key), element));
  }

  return Array.from(deduped.values());
}

export function normalizeOverpassUrls(urls) {
  const normalized = Array.isArray(urls)
    ? urls
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean)
      .map((entry) => LEGACY_OVERPASS_URL_ALIASES.get(entry) ?? entry)
    : [];

  const deduped = [];
  const seen = new Set();
  for (const url of normalized) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    deduped.push(url);
  }

  if (deduped.length === 0) {
    return [...DEFAULT_OVERPASS_URLS];
  }

  const includesLegacyAlias = Array.isArray(urls)
    && urls.some((entry) => LEGACY_OVERPASS_URL_ALIASES.has(String(entry ?? '').trim()));
  if (!includesLegacyAlias) {
    return deduped;
  }

  const customUrls = deduped.filter((url) => !DEFAULT_OVERPASS_URLS.includes(url));
  return customUrls.length > 0
    ? [...customUrls, ...DEFAULT_OVERPASS_URLS]
    : [...DEFAULT_OVERPASS_URLS];
}

function buildOverpassRequestError(url, error, timeoutMs) {
  if (error?.name === 'AbortError') {
    return new Error(`Overpass API request timeout (${Math.round(timeoutMs / 1000)}s) (${url})`);
  }

  const rawMessage = String(error?.message ?? 'Unknown error');
  if (rawMessage.includes(url)) {
    return new Error(rawMessage);
  }

  const detail = error?.cause?.code || error?.cause?.message || rawMessage;
  return new Error(`${url} failed: ${detail}`);
}

async function requestOverpassJson(url, query, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status === 429) {
      throw new Error(`Overpass API HTTP 429 (${url})`);
    }

    if (!response.ok) {
      throw new Error(`Overpass API HTTP ${response.status} (${url})`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchOverpassJson(query, {
  urls = DEFAULT_OVERPASS_URLS,
  timeoutMs = 15000,
  onRequestError,
} = {}) {
  const overpassUrls = normalizeOverpassUrls(urls);
  let winnerChosen = false;
  let lastError = null;

  const attempts = overpassUrls.map((url) =>
    requestOverpassJson(url, query, timeoutMs)
      .then((payload) => {
        winnerChosen = true;
        return payload;
      })
      .catch((error) => {
        const normalizedError = buildOverpassRequestError(url, error, timeoutMs);
        lastError = normalizedError;
        if (!(winnerChosen && normalizedError.message.includes('request timeout'))) {
          onRequestError?.(url, normalizedError);
        }
        throw normalizedError;
      }),
  );

  try {
    return await Promise.any(attempts);
  } catch (error) {
    if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
      throw error.errors[error.errors.length - 1];
    }
    throw lastError || error || new Error('All Overpass servers failed');
  }
}

export async function fetchOverpassElementsByTiles({
  bbox,
  buildQuery,
  urls = DEFAULT_OVERPASS_URLS,
  timeoutMs = 15000,
  onRequestError,
  maxTileSpan = 0.5,
  minTileSpan = 0.2,
  abortAfterTerminalFailures = 3,
} = {}) {
  if (!bbox || typeof buildQuery !== 'function') {
    return { elements: [], failedTiles: [] };
  }

  const queue = tileBbox(bbox, maxTileSpan);
  const collected = [];
  const failedTiles = [];
  let lastError = null;
  let successfulTiles = 0;
  let terminalFailureCount = 0;

  while (queue.length > 0) {
    const tile = queue.shift();
    const query = buildQuery(tile);
    if (!query) {
      continue;
    }

    try {
      const payload = await fetchOverpassJson(query, {
        urls,
        timeoutMs,
        onRequestError,
      });
      const elements = Array.isArray(payload?.elements) ? payload.elements : [];
      collected.push(...elements);
      successfulTiles += 1;
      terminalFailureCount = 0;
    } catch (error) {
      lastError = error;
      const span = getBboxSpan(tile);

      if (span > minTileSpan + 1e-9) {
        queue.unshift(...splitBbox(tile));
        continue;
      }

      failedTiles.push({ bbox: tile, error });
      terminalFailureCount += 1;
      if (successfulTiles === 0 && terminalFailureCount >= abortAfterTerminalFailures) {
        throw error;
      }
    }
  }

  if (collected.length === 0 && lastError) {
    throw lastError;
  }

  return {
    elements: dedupeOverpassElements(collected),
    failedTiles,
  };
}
