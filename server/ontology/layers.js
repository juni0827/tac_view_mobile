export const DEFAULT_LAYER_DEFS = [
  {
    id: 'ontology-aircraft',
    label: 'AIRCRAFT ONTOLOGY',
    category: 'dynamic',
    description: 'Observed aircraft tracks and related evidence.',
    sourceName: 'ontology',
    entityTypes: ['aircraft'],
    defaultEnabled: 0,
    style: { color: '#00D4FF', mode: 'point' },
    refreshIntervalSeconds: 60,
  },
  {
    id: 'ontology-vessels',
    label: 'VESSEL ONTOLOGY',
    category: 'dynamic',
    description: 'Observed vessels and AIS-derived evidence.',
    sourceName: 'ontology',
    entityTypes: ['vessel'],
    defaultEnabled: 0,
    style: { color: '#00BFA5', mode: 'point' },
    refreshIntervalSeconds: 120,
  },
  {
    id: 'ontology-satellites',
    label: 'SATELLITE ONTOLOGY',
    category: 'dynamic',
    description: 'Observed orbital positions and coverage relations.',
    sourceName: 'ontology',
    entityTypes: ['satellite'],
    defaultEnabled: 0,
    style: { color: '#39FF14', mode: 'point' },
    refreshIntervalSeconds: 300,
  },
  {
    id: 'ontology-sensors',
    label: 'SENSOR NETWORK',
    category: 'dynamic',
    description: 'CCTV and related sensor entities with provenance.',
    sourceName: 'ontology',
    entityTypes: ['sensor'],
    defaultEnabled: 0,
    style: { color: '#FF3B30', mode: 'point' },
    refreshIntervalSeconds: 300,
  },
  {
    id: 'ontology-earthquakes',
    label: 'SEISMIC EVENTS',
    category: 'dynamic',
    description: 'Observed earthquake events and nearby linked entities.',
    sourceName: 'ontology',
    entityTypes: ['earthquake'],
    defaultEnabled: 0,
    style: { color: '#FF9500', mode: 'point' },
    refreshIntervalSeconds: 300,
  },
  {
    id: 'ontology-airports',
    label: 'AIRPORTS',
    category: 'infrastructure',
    description: 'OpenStreetMap aerodromes and aviation facilities.',
    sourceName: 'osm',
    entityTypes: ['airport'],
    defaultEnabled: 1,
    style: { color: '#00D4FF', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-ports',
    label: 'PORTS',
    category: 'infrastructure',
    description: 'Open ports, ferry terminals, and harbour entities.',
    sourceName: 'osm',
    entityTypes: ['port'],
    defaultEnabled: 1,
    style: { color: '#00BFA5', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-military-sites',
    label: 'MILITARY SITES',
    category: 'infrastructure',
    description: 'Open military-tagged infrastructure and compounds.',
    sourceName: 'osm',
    entityTypes: ['military_site'],
    defaultEnabled: 0,
    style: { color: '#FF3B30', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-power-sites',
    label: 'POWER SITES',
    category: 'infrastructure',
    description: 'Power plants, generators, and grid infrastructure.',
    sourceName: 'osm',
    entityTypes: ['power_site', 'substation'],
    defaultEnabled: 0,
    style: { color: '#FFD60A', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-towers',
    label: 'TOWERS',
    category: 'infrastructure',
    description: 'Open tower and mast infrastructure.',
    sourceName: 'osm',
    entityTypes: ['tower'],
    defaultEnabled: 0,
    style: { color: '#FF9500', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-rail-nodes',
    label: 'RAIL NODES',
    category: 'infrastructure',
    description: 'Stations, junctions, and railway-linked nodes.',
    sourceName: 'osm',
    entityTypes: ['rail_node'],
    defaultEnabled: 0,
    style: { color: '#7DF9FF', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-bridges',
    label: 'BRIDGES',
    category: 'infrastructure',
    description: 'Bridge structures and link segments.',
    sourceName: 'osm',
    entityTypes: ['bridge'],
    defaultEnabled: 0,
    style: { color: '#FFE640', mode: 'line' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-roads',
    label: 'ROAD SEGMENTS',
    category: 'infrastructure',
    description: 'Road infrastructure from traffic and OSM sources.',
    sourceName: 'osm',
    entityTypes: ['road_segment'],
    defaultEnabled: 0,
    style: { color: '#A0A0A0', mode: 'line' },
    refreshIntervalSeconds: 43200,
  },
  {
    id: 'ontology-facilities',
    label: 'GENERAL FACILITIES',
    category: 'infrastructure',
    description: 'Fallback facility entities and uncategorized sites.',
    sourceName: 'ontology',
    entityTypes: ['facility'],
    defaultEnabled: 0,
    style: { color: '#CCCCCC', mode: 'point' },
    refreshIntervalSeconds: 43200,
  },
];

export function getLayerIdsForEntityType(entityType) {
  return DEFAULT_LAYER_DEFS
    .filter((layer) => layer.entityTypes.includes(entityType))
    .map((layer) => layer.id);
}

export function getEntityTypesForLayerIds(layerIds) {
  const ids = new Set(layerIds);
  const entityTypes = new Set();
  for (const layer of DEFAULT_LAYER_DEFS) {
    if (!ids.has(layer.id)) {
      continue;
    }
    for (const entityType of layer.entityTypes) {
      entityTypes.add(entityType);
    }
  }
  return Array.from(entityTypes);
}
