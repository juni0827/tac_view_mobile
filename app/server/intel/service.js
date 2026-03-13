const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const GDELT_DOC_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_GEO_API_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';
const RELIEFWEB_REPORTS_API_URL = 'https://api.reliefweb.int/v2/reports';
const NEWS_API_URL = 'https://newsapi.org/v2/everything';
const DEFAULT_INTEL_QUERY = '"conflict" OR military OR airbase OR port OR airport OR earthquake OR flood OR wildfire';
const DEFAULT_RELIEFWEB_QUERY = 'conflict OR earthquake OR flood OR wildfire OR displacement';

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function truncateText(value, maxLength = 220) {
  const normalized = normalizeString(value).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseOptionalNumber(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(value) {
  const normalized = normalizeString(value);
  const gdeltMatch = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (gdeltMatch) {
    const [, year, month, day, hour, minute, second] = gdeltMatch;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function deriveIntelSeverity(text, fatalities = 0) {
  const normalized = `${text || ''}`.toLowerCase();
  if (fatalities >= 10 || /(battle|explosion|missile|airstrike|fatal|killed|violence)/.test(normalized)) {
    return 'high';
  }
  if (fatalities > 0 || /(protest|storm|wildfire|flood|earthquake|evacuation|aid)/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function dedupeIntelItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.source}:${item.url || ''}:${item.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortIntelItems(items) {
  return [...items].sort((left, right) =>
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime(),
  );
}

function summarizeIntelLocation(parts) {
  const values = parts
    .map((value) => normalizeString(value))
    .filter(Boolean);
  return values.length > 0 ? values.join(', ') : null;
}

function buildLatLonBounds(latitude, longitude, radiusKm) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const latitudeDelta = radiusKm / 111.32;
  const longitudeScale = Math.max(Math.cos((latitude * Math.PI) / 180), 0.05);
  const longitudeDelta = radiusKm / (111.32 * longitudeScale);
  return {
    minLatitude: Math.max(-90, latitude - latitudeDelta),
    maxLatitude: Math.min(90, latitude + latitudeDelta),
    minLongitude: Math.max(-180, longitude - longitudeDelta),
    maxLongitude: Math.min(180, longitude + longitudeDelta),
  };
}

function formatGdeltTimespan(days) {
  return days === 1 ? '1day' : `${days}days`;
}

async function fetchJson(url, init = {}, label = 'request') {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }
  return response.json();
}

function normalizeAcledItems(payload, options) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const searchTerm = normalizeString(options.q).toLowerCase();
  return rows
    .filter((row) => {
      if (!searchTerm) {
        return true;
      }

      const haystack = [
        row.event_type,
        row.sub_event_type,
        row.actor1,
        row.actor2,
        row.country,
        row.admin1,
        row.location,
        row.notes,
      ].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    })
    .slice(0, options.limit)
    .map((row, index) => {
      const fatalities = Number.parseInt(String(row.fatalities || '0'), 10) || 0;
      const locationLabel = summarizeIntelLocation([row.location, row.admin1, row.country]);
      const title = firstNonEmptyString(
        row.event_type && row.sub_event_type ? `${row.event_type}: ${row.sub_event_type}` : '',
        row.event_type,
        row.sub_event_type,
        'ACLED event',
      );
      return {
        id: String(row.event_id_cnty || row.event_id_no_cnty || `acled-${index}`),
        source: 'acled',
        category: 'conflict',
        severity: deriveIntelSeverity(`${title} ${row.notes || ''}`, fatalities),
        title,
        summary: truncateText(firstNonEmptyString(
          row.notes,
          fatalities > 0 ? `${fatalities} reported fatalities.` : '',
          locationLabel,
        )),
        url: null,
        publishedAt: toIsoString(firstNonEmptyString(row.event_date, row.timestamp, Date.now())),
        locationLabel,
        latitude: parseOptionalNumber(row.latitude),
        longitude: parseOptionalNumber(row.longitude),
      };
    });
}

function normalizeGdeltItems(payload, options) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  return rows.slice(0, options.limit).map((row, index) => ({
    id: `gdelt-${index}-${Buffer.from(firstNonEmptyString(row.url, row.title, String(index))).toString('base64url').slice(0, 16)}`,
    source: 'gdelt',
    category: 'news',
    severity: deriveIntelSeverity(`${row.title || ''} ${row.domain || ''}`),
    title: truncateText(firstNonEmptyString(row.title, row.domain, 'GDELT article'), 140),
    summary: truncateText(firstNonEmptyString(
      row.domain ? `Source: ${row.domain}` : '',
      row.language ? `Language: ${row.language}` : '',
      row.sourcecountry ? `Country: ${row.sourcecountry}` : '',
    )),
    url: firstNonEmptyString(row.url) || null,
    publishedAt: toIsoString(firstNonEmptyString(row.seendate, Date.now())),
    locationLabel: firstNonEmptyString(row.sourcecountry) || null,
    latitude: null,
    longitude: null,
  }));
}

function normalizeNewsApiItems(payload, options) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  return rows.slice(0, options.limit).map((row, index) => ({
    id: `newsapi-${index}-${Buffer.from(firstNonEmptyString(row.url, row.title, String(index))).toString('base64url').slice(0, 16)}`,
    source: 'newsapi',
    category: 'news',
    severity: deriveIntelSeverity(`${row.title || ''} ${row.description || ''}`),
    title: truncateText(firstNonEmptyString(row.title, row.source?.name, 'News API article'), 140),
    summary: truncateText(firstNonEmptyString(row.description, row.content, row.source?.name)),
    url: firstNonEmptyString(row.url) || null,
    publishedAt: toIsoString(firstNonEmptyString(row.publishedAt, Date.now())),
    locationLabel: firstNonEmptyString(row.source?.name) || null,
    latitude: null,
    longitude: null,
  }));
}

function normalizeReliefWebItems(payload, options) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.slice(0, options.limit).map((row, index) => {
    const fields = row?.fields || {};
    const title = firstNonEmptyString(fields.title, fields.headline?.title, 'ReliefWeb report');
    const sourceName = Array.isArray(fields.source) ? firstNonEmptyString(fields.source[0]?.shortname, fields.source[0]?.name) : '';
    const locationLabel = summarizeIntelLocation([
      fields.primary_country?.name,
      Array.isArray(fields.country) ? fields.country[0]?.name : '',
    ]);
    return {
      id: `reliefweb-${row.id || index}`,
      source: 'reliefweb',
      category: 'humanitarian',
      severity: deriveIntelSeverity(`${title} ${fields.headline?.summary || ''}`),
      title: truncateText(title, 140),
      summary: truncateText(firstNonEmptyString(fields.headline?.summary, sourceName, locationLabel)),
      url: firstNonEmptyString(fields.url_alias) || (row.id ? `https://reliefweb.int/node/${row.id}` : null),
      publishedAt: toIsoString(firstNonEmptyString(fields.date?.created, fields.date?.original, Date.now())),
      locationLabel,
      latitude: null,
      longitude: null,
    };
  });
}

export function getExternalIntelRuntimeStatus(runtimeConfig) {
  return {
    acledConfigured: Boolean(runtimeConfig.server.acledAccessKey && runtimeConfig.server.acledEmail),
    gdeltConfigured: true,
    reliefwebConfigured: Boolean(runtimeConfig.server.reliefwebAppName),
    newsApiConfigured: Boolean(runtimeConfig.server.newsApiKey),
  };
}

export function createIntelService({ getCachedValue, rememberValue }) {
  async function loadCachedJson(cacheKey, ttlSeconds, loader) {
    const cached = await getCachedValue(cacheKey, Math.min(ttlSeconds, 90));
    if (cached !== undefined) {
      return cached;
    }

    const value = await loader();
    return rememberValue(cacheKey, value, ttlSeconds);
  }

  function buildIntelRequestOptions(query) {
    return {
      limit: clampInteger(query.limit, 1, 25, 8),
      days: clampInteger(query.days, 1, 30, 7),
      latitude: parseOptionalNumber(query.lat),
      longitude: parseOptionalNumber(query.lon),
      radiusKm: clampNumber(query.radiusKm, 25, 2500, 400),
      q: normalizeString(query.q),
    };
  }

  async function fetchAcledIntel(options) {
    const configured = Boolean(process.env.ACLED_ACCESS_KEY && process.env.ACLED_EMAIL);
    if (!configured) {
      return {
        items: [],
        status: { configured: false, ok: false, itemCount: 0, error: 'ACLED credentials not configured' },
      };
    }

    const cacheKey = `intel-acled-${JSON.stringify(options)}`;
    const payload = await loadCachedJson(cacheKey, 600, async () => {
      const url = new URL(ACLED_API_URL);
      url.searchParams.set('key', process.env.ACLED_ACCESS_KEY);
      url.searchParams.set('email', process.env.ACLED_EMAIL);
      url.searchParams.set('_format', 'json');
      url.searchParams.set('limit', String(options.limit));
      url.searchParams.set('fields', 'event_id_cnty|event_id_no_cnty|event_date|country|admin1|location|latitude|longitude|event_type|sub_event_type|actor1|actor2|fatalities|notes');
      const today = new Date();
      const from = new Date(today.getTime() - options.days * 24 * 60 * 60 * 1000);
      url.searchParams.set('event_date', `${from.toISOString().slice(0, 10)}|${today.toISOString().slice(0, 10)}`);
      url.searchParams.set('event_date_where', 'BETWEEN');
      const bounds = buildLatLonBounds(options.latitude, options.longitude, options.radiusKm);
      if (bounds) {
        url.searchParams.set('latitude', `${bounds.minLatitude}|${bounds.maxLatitude}`);
        url.searchParams.set('latitude_where', 'BETWEEN');
        url.searchParams.set('longitude', `${bounds.minLongitude}|${bounds.maxLongitude}`);
        url.searchParams.set('longitude_where', 'BETWEEN');
      }
      return fetchJson(url, { headers: { 'User-Agent': 'TAC_VIEW/1.0' } }, 'ACLED');
    });

    const items = normalizeAcledItems(payload, options);
    return {
      items,
      status: { configured: true, ok: true, itemCount: items.length, error: null },
    };
  }

  async function fetchGdeltDocIntel(options) {
    const cacheKey = `intel-gdelt-doc-${JSON.stringify(options)}`;
    const payload = await loadCachedJson(cacheKey, 180, async () => {
      const url = new URL(GDELT_DOC_API_URL);
      url.searchParams.set('query', options.q || DEFAULT_INTEL_QUERY);
      url.searchParams.set('mode', 'ArtList');
      url.searchParams.set('format', 'json');
      url.searchParams.set('maxrecords', String(options.limit));
      url.searchParams.set('timespan', formatGdeltTimespan(options.days));
      return fetchJson(url, { headers: { 'User-Agent': 'TAC_VIEW/1.0' } }, 'GDELT DOC');
    });

    const items = normalizeGdeltItems(payload, options);
    return {
      items,
      status: { configured: true, ok: true, itemCount: items.length, error: null },
    };
  }

  async function fetchGdeltGeoIntel(query) {
    const options = buildIntelRequestOptions(query);
    const cacheKey = `intel-gdelt-geo-${JSON.stringify(options)}`;
    return loadCachedJson(cacheKey, 180, async () => {
      const url = new URL(GDELT_GEO_API_URL);
      const queryTerms = options.q || DEFAULT_INTEL_QUERY;
      const geoQuery = Number.isFinite(options.latitude) && Number.isFinite(options.longitude)
        ? `${queryTerms} near:${options.latitude},${options.longitude},${Math.round(options.radiusKm)}km`
        : queryTerms;
      url.searchParams.set('query', geoQuery);
      url.searchParams.set('mode', 'PointHeatmap');
      url.searchParams.set('format', 'GeoJSON');
      return fetchJson(url, { headers: { 'User-Agent': 'TAC_VIEW/1.0' } }, 'GDELT GEO');
    });
  }

  async function fetchReliefWebIntel(options) {
    const configured = Boolean(process.env.RELIEFWEB_APPNAME);
    if (!configured) {
      return {
        items: [],
        status: { configured: false, ok: false, itemCount: 0, error: 'ReliefWeb appname not configured' },
      };
    }

    const cacheKey = `intel-reliefweb-${JSON.stringify(options)}`;
    const payload = await loadCachedJson(cacheKey, 300, async () => {
      const url = new URL(RELIEFWEB_REPORTS_API_URL);
      url.searchParams.set('appname', process.env.RELIEFWEB_APPNAME);
      url.searchParams.set('limit', String(options.limit));
      url.searchParams.append('sort[]', 'date.created:desc');
      url.searchParams.set('query[value]', options.q || DEFAULT_RELIEFWEB_QUERY);
      url.searchParams.append('query[fields][]', 'title');
      url.searchParams.append('query[fields][]', 'headline.title');
      url.searchParams.append('query[fields][]', 'headline.summary');
      url.searchParams.append('fields[include][]', 'title');
      url.searchParams.append('fields[include][]', 'headline');
      url.searchParams.append('fields[include][]', 'date');
      url.searchParams.append('fields[include][]', 'source');
      url.searchParams.append('fields[include][]', 'primary_country');
      url.searchParams.append('fields[include][]', 'country');
      url.searchParams.append('fields[include][]', 'url_alias');
      return fetchJson(url, { headers: { 'User-Agent': 'TAC_VIEW/1.0' } }, 'ReliefWeb');
    });

    const items = normalizeReliefWebItems(payload, options);
    return {
      items,
      status: { configured: true, ok: true, itemCount: items.length, error: null },
    };
  }

  async function fetchNewsApiIntel(options) {
    const configured = Boolean(process.env.NEWS_API_KEY);
    if (!configured) {
      return {
        items: [],
        status: { configured: false, ok: false, itemCount: 0, error: 'NewsAPI key not configured' },
      };
    }

    const cacheKey = `intel-newsapi-${JSON.stringify(options)}`;
    const payload = await loadCachedJson(cacheKey, 300, async () => {
      const url = new URL(NEWS_API_URL);
      url.searchParams.set('q', options.q || DEFAULT_INTEL_QUERY);
      url.searchParams.set('pageSize', String(options.limit));
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('language', 'en');
      url.searchParams.set('from', new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString());
      return fetchJson(url, {
        headers: {
          'User-Agent': 'TAC_VIEW/1.0',
          'X-Api-Key': process.env.NEWS_API_KEY,
        },
      }, 'NewsAPI');
    });

    const items = normalizeNewsApiItems(payload, options);
    return {
      items,
      status: { configured: true, ok: true, itemCount: items.length, error: null },
    };
  }

  async function resolveIntelSource(handler) {
    try {
      return await handler();
    } catch (error) {
      return {
        items: [],
        status: {
          configured: true,
          ok: false,
          itemCount: 0,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async function buildBriefing(options) {
    const [acled, gdelt, reliefweb, newsapi] = await Promise.all([
      resolveIntelSource(() => fetchAcledIntel(options)),
      resolveIntelSource(() => fetchGdeltDocIntel(options)),
      resolveIntelSource(() => fetchReliefWebIntel(options)),
      resolveIntelSource(() => fetchNewsApiIntel(options)),
    ]);

    const items = sortIntelItems(dedupeIntelItems([
      ...acled.items,
      ...gdelt.items,
      ...reliefweb.items,
      ...newsapi.items,
    ])).slice(0, options.limit);

    return {
      items,
      sources: {
        acled: acled.status,
        gdelt: gdelt.status,
        reliefweb: reliefweb.status,
        newsapi: newsapi.status,
      },
    };
  }

  return {
    buildIntelRequestOptions,
    fetchAcledIntel,
    fetchGdeltDocIntel,
    fetchGdeltGeoIntel,
    fetchReliefWebIntel,
    fetchNewsApiIntel,
    resolveIntelSource,
    buildBriefing,
  };
}
