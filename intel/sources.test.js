const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOsintUrl,
  buildYenteSearchUrl,
  mapYenteSearchResults,
  sanctionNodeId,
  yenteSchemaForType,
} = require('./sources');

test('buildOsintUrl routes Wikidata and OpenSanctions requests through the cache base', () => {
  const base = 'http://osiris-cache:8080/proxy/osint/';

  const sparqlUrl = buildOsintUrl('wikidataSparql', { query: 'SELECT * WHERE {}', format: 'json' }, base);
  assert.equal(sparqlUrl.origin, 'http://osiris-cache:8080');
  assert.equal(sparqlUrl.pathname, '/proxy/osint/wikidata/sparql');
  assert.equal(sparqlUrl.searchParams.get('query'), 'SELECT * WHERE {}');

  const searchUrl = buildOsintUrl('wikidataSearch', { action: 'wbsearchentities', search: 'Acme', format: 'json' }, base);
  assert.equal(searchUrl.pathname, '/proxy/osint/wikidata/api');
  assert.equal(searchUrl.searchParams.get('search'), 'Acme');

  const sanctionsUrl = buildOsintUrl('opensanctionsSdnCsv', {}, base);
  assert.equal(sanctionsUrl.pathname, '/proxy/osint/opensanctions/datasets/latest/us_ofac_sdn/targets.simple.csv');
});

test('buildOsintUrl falls back to direct allowlisted sources without a cache base', () => {
  const sparqlUrl = buildOsintUrl('wikidataSparql', { query: 'SELECT * WHERE {}', format: 'json' }, '');
  assert.equal(sparqlUrl.origin, 'https://query.wikidata.org');
  assert.equal(sparqlUrl.pathname, '/sparql');

  const sanctionsUrl = buildOsintUrl('opensanctionsSdnCsv', {}, '');
  assert.equal(sanctionsUrl.origin, 'https://data.opensanctions.org');
  assert.equal(sanctionsUrl.pathname, '/datasets/latest/us_ofac_sdn/targets.simple.csv');
});

test('buildYenteSearchUrl scopes local search by dataset, query, limit, and schema', () => {
  const url = buildYenteSearchUrl('http://yente:8000/', 'default', 'Acme Ltd', 'company', 5);

  assert.equal(url.origin, 'http://yente:8000');
  assert.equal(url.pathname, '/search/default');
  assert.equal(url.searchParams.get('q'), 'Acme Ltd');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('schema'), 'Company');
});

test('yenteSchemaForType maps graph entity types to OpenSanctions schemas', () => {
  assert.equal(yenteSchemaForType('person'), 'Person');
  assert.equal(yenteSchemaForType('company'), 'Company');
  assert.equal(yenteSchemaForType('vessel'), 'Vessel');
  assert.equal(yenteSchemaForType('aircraft'), 'Airplane');
  assert.equal(yenteSchemaForType('country'), '');
});

test('mapYenteSearchResults normalizes local Yente hits into sanction entries', () => {
  const entries = mapYenteSearchResults({
    results: [
      {
        id: 'Q123',
        caption: 'Acme Trading',
        schema: 'Company',
        score: 0.97,
        datasets: ['us_ofac_sdn'],
        properties: {
          alias: ['Acme Ltd'],
          country: ['ru'],
          topics: ['sanction'],
          programId: ['OFAC-SDN'],
          first_seen: ['2024-01-01'],
        },
      },
    ],
  });

  assert.deepEqual(entries, [
    {
      id: 'Q123',
      schema: 'Company',
      name: 'Acme Trading',
      aliases: ['Acme Ltd'],
      countries: ['ru'],
      programs: ['OFAC-SDN'],
      sanctions: 'sanction',
      first_seen: '2024-01-01',
      score: 0.97,
      source: 'Yente',
      datasets: ['us_ofac_sdn'],
    },
  ]);
});

test('sanctionNodeId falls back to a stable name-derived id when source id is missing', () => {
  assert.equal(
    sanctionNodeId({ id: '', name: 'Acme Trading, Ltd.' }),
    'sanction:acme-trading-ltd',
  );
});
