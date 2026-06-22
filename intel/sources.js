const DIRECT_SOURCES = {
  wikidataSparql: 'https://query.wikidata.org/sparql',
  wikidataSearch: 'https://www.wikidata.org/w/api.php',
  opensanctionsSdnCsv: 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv',
};

const CACHE_PATHS = {
  wikidataSparql: '/wikidata/sparql',
  wikidataSearch: '/wikidata/api',
  opensanctionsSdnCsv: '/opensanctions/datasets/latest/us_ofac_sdn/targets.simple.csv',
};

const YENTE_SCHEMAS = {
  person: 'Person',
  company: 'Company',
  vessel: 'Vessel',
  aircraft: 'Airplane',
  ip: '',
  country: '',
};

function buildOsintUrl(source, params = {}, osintCacheBaseUrl = '') {
  const direct = DIRECT_SOURCES[source];
  if (!direct) throw new Error(`Unknown OSINT source: ${source}`);

  const base = (osintCacheBaseUrl || '').trim().replace(/\/+$/, '');
  const url = base
    ? new URL(`${base}${CACHE_PATHS[source]}`)
    : new URL(direct);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function yenteSchemaForType(type) {
  return YENTE_SCHEMAS[(type || '').toLowerCase()] || '';
}

function buildYenteSearchUrl(yenteBaseUrl, dataset, query, type = '', limit = 5) {
  const safeDataset = /^[A-Za-z0-9_-]+$/.test(dataset || '') ? dataset : 'default';
  const url = new URL(`/search/${safeDataset}`, yenteBaseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const schema = yenteSchemaForType(type);
  if (schema) url.searchParams.set('schema', schema);
  return url;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function propValues(properties, ...names) {
  for (const name of names) {
    const values = asArray(properties?.[name]);
    if (values.length) return values.map(String);
  }
  return [];
}

function searchHits(body) {
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.responses)) {
    return body.responses.flatMap((response) => Array.isArray(response?.results) ? response.results : []);
  }
  return [];
}

function mapYenteSearchResults(body) {
  return searchHits(body).map((hit) => {
    const entity = hit.entity || hit;
    const properties = entity.properties || hit.properties || {};
    const name = entity.caption || hit.caption || propValues(properties, 'name', 'names')[0] || entity.id || hit.id || '';
    const topics = [
      ...asArray(hit.topics),
      ...propValues(properties, 'topics', 'topic'),
    ].map(String);

    return {
      id: entity.id || hit.id || name,
      schema: entity.schema || hit.schema || 'LegalEntity',
      name,
      aliases: propValues(properties, 'alias', 'aliases', 'weakAlias', 'previousName'),
      countries: propValues(properties, 'country', 'countries', 'jurisdiction'),
      programs: propValues(properties, 'programId', 'programIds', 'program_ids'),
      sanctions: topics.join('; '),
      first_seen: propValues(properties, 'first_seen', 'firstSeen')[0],
      score: hit.score,
      source: 'Yente',
      datasets: asArray(hit.datasets || entity.datasets).map(String),
    };
  }).filter((entry) => entry.name);
}

function sanctionNodeId(entry) {
  const raw = entry?.id || entry?.name || 'unknown';
  const safe = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `sanction:${safe || 'unknown'}`;
}

module.exports = {
  buildOsintUrl,
  buildYenteSearchUrl,
  mapYenteSearchResults,
  sanctionNodeId,
  yenteSchemaForType,
};
