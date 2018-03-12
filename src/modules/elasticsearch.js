const config = require('../constants');
const elasticSearchBuilder = require('../plugins/elasticsearch');
const { stream } = require('../pipeline/augmented');
const app = require('../apps/api');
const { parseFilterQuery, createFilter } = require('../lib/filter');
const elasticsearch = elasticSearchBuilder(config.elasticsearch.configuration);

// As we are using elasticsearch, we don't need to use the memory to hold logs
config.logs.memory.retention = 0;
config.session.timerange = true;
config.modules.session.active = false;

stream.map(elasticsearch.index);

app.get('/logs', (req, res) => {
  const { query } = req;
  elasticsearch
    .searchLogs(parseFilterQuery(query))
    .then(logs => res.send(logs));
});

const transformSession = sessionName => ({ es, hub }) =>
  Object.assign(es, {
    end: Math.floor(new Date(es.end).getTime() / 1000),
    updated: Math.floor(new Date(es.end).getTime() / 1000),
    reputation: hub.reputation,
    type: sessionName,
    [sessionName]: hub,
  });

const searchFns = {
  robot: elasticsearch.searchRobots,
  address: elasticsearch.searchAddresses,
};

const searchSessions = ({ type, query }) => {
  if (searchFns[type]) {
    return searchFns[type](parseFilterQuery(query)).then(sessions =>
      sessions.map(transformSession(type))
    );
  }
};

app.get('/sessions/:type', (req, res) => {
  const { params, query } = req;
  const { type } = params;
  searchSessions({ type, query }).then(sessions => res.send(sessions));
});

// TODO FIXME when merging branch advanced-addresses, this should be imported
// from ../lib/rules
const getters = {
  address: ['address', 'value'],
  robot: ['robot', 'id'],
};

app.get('/sessions/:type/:id', (req, res) => {
  const { params, query } = req;
  const { type, id } = params;
  const { filter } = query;
  const sessionFilter = createFilter({
    id: getters[type].join('.'),
    values: [id],
  });
  searchSessions({
    type,
    query: Object.assign({}, query, {
      filter: `${filter ? filter + ';' : ''}${sessionFilter}`,
    }),
  }).then(sessions => res.send(sessions[0]));
});
