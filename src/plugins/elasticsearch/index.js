require('date-format-lite');
const elasticsearch = require('elasticsearch');
const { database, filters } = require('access-watch-sdk');
const logsIndexConfig = require('./logs-index-config.json');
const config = require('../../constants');
const monitoring = require('../../lib/monitoring');
const { iso } = require('../../lib/util');

const monitor = monitoring.registerOutput({ name: 'Elasticsearch' });

const { logsIndexName, retention } = config.elasticsearch;
const accessWatchSdkDatabase = database();

const generateIndexName = date =>
  `${logsIndexName}-${date.format('YYYY-MM-DD', 0)}`;

const getIndexDate = index =>
  index.slice(logsIndexName.length + 1).replace(/-/g, '/');

const getGcDate = () =>
  new Date(new Date().getTime() - retention * 24 * 3600 * 1000);

const indexesDb = {};

const reportOnError = promise =>
  promise.catch(e => {
    // Remove the eventual Error: that might come from the error from ES
    const errString = e.message.replace('Error :', '');
    monitor.status = `Error: ${errString}`;
    console.error(`Elasticsearch error: ${errString}`);
  });

const createIndexIfNotExists = client => index => {
  if (!indexesDb[index]) {
    indexesDb[index] = reportOnError(
      client.indices.exists({ index }).then(exists => {
        if (!exists) {
          return client.indices.create({
            index,
            body: logsIndexConfig,
          });
        }
      })
    );
  }
  return indexesDb[index];
};

const indexLog = client => log => {
  const logTime = new Date(log.getIn(['request', 'time']));
  const gcDate = getGcDate();
  if (logTime.getTime() > gcDate.getTime()) {
    const index = generateIndexName(logTime);
    createIndexIfNotExists(client)(index).then(() => {
      reportOnError(
        client
          .index({
            index,
            type: 'log',
            routing: log.getIn(['address', 'value']),
            body: log.toJS(),
          })
          .then(() => {
            monitor.status = 'Connected and indexing';
            monitor.hit();
          })
      );
    });
  } else {
    console.log(
      `Not indexing old log (${logTime}), current retention: ${retention}`
    );
  }
};

const indexesGc = client => () => {
  reportOnError(
    client.indices.get({ index: '*' }).then(indices => {
      Object.keys(indices)
        .filter(i => i.indexOf(logsIndexName) !== -1)
        .forEach(index => {
          const indexDate = new Date(getIndexDate(index));
          const gcDate = getGcDate();
          if (indexDate.getTime() < gcDate.getTime()) {
            reportOnError(client.indices.delete({ index }));
          }
        });
    })
  );
};

const caseInsentivizeRegexpValue = value => {
  const getChar = c => {
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    return lower !== upper ? `[${lower}${upper}]` : c;
  };
  return ('' + value)
    .split('')
    .map(getChar)
    .join('');
};

const prefixIfNeeded = (id, type) => (type === 'log' ? id : `${type}.${id}`);

const getESValue = ({ id, value }, type) => {
  const filter = filters[type].find(f => prefixIfNeeded(f.id, type) === id);
  if (filter && filter.fullText) {
    // Performance-wise this is not the greatest, but it's the only working
    // way I found for wildcard + case-insensitive matching for ES
    return {
      regexp: {
        [id]: `.*${caseInsentivizeRegexpValue(value)}.*`,
      },
    };
  }
  return { match: { [id]: value } };
};

const search = client => (query = {}, type) => {
  const { start, end, limit: size, aggs, filter } = query;
  let bool = {
    filter: [
      {
        exists: {
          field: 'identity.id',
        },
      },
    ],
  };
  const body = {
    sort: [
      {
        'request.time': {
          order: 'desc',
        },
      },
    ],
  };
  if (filter) {
    bool.must = Object.keys(filter).map(id => {
      const { negative, values } = filter[id];
      const cond =
        values.length === 1
          ? getESValue({ id, value: values[0] }, type)
          : {
              bool: {
                should: values.map(value => getESValue({ id, value }, type)),
              },
            };
      return negative ? { bool: { must_not: cond } } : cond;
    });
  }
  if (start || end) {
    bool.filter.push({
      range: {
        'request.time': Object.assign(
          start ? { gte: iso(start) } : {},
          end ? { lte: iso(end) } : {}
        ),
      },
    });
  }
  if (aggs) {
    body.aggs = aggs;
  }
  body.query = { bool };
  return reportOnError(
    client.search({
      index: `${logsIndexName}-*`,
      type: 'log',
      body,
      size,
    })
  );
};

const searchLogs = client => (query = {}) =>
  search(client)(query, 'log').then(({ hits }) => {
    if (hits) {
      return hits.hits.map(({ _source }) => _source);
    }
    return [];
  });

const searchSessions = ({
  fetchFn,
  sessionId,
  queryConstants = {},
  type,
}) => client => (query = {}) =>
  search(client)(
    Object.assign(
      {
        aggs: {
          sessions: {
            terms: {
              field: sessionId,
              size: query.limit || 50,
            },
          },
        },
        limit: 0,
      },
      queryConstants,
      query
    ),
    type
  )
    .then(({ aggregations: { sessions: { buckets } } }) =>
      buckets.map(({ key, doc_count }) => ({
        id: key,
        count: doc_count,
      }))
    )
    .then(sessions =>
      Promise.all(sessions.map(({ id }) => fetchFn(id))).then(sessionsData =>
        sessionsData.map((sessionData, i) =>
          Object.assign(
            {
              count: sessions[i].count,
            },
            sessionData
          )
        )
      )
    );

const searchRobots = searchSessions({
  queryConstants: {
    'identity.type': 'robot',
  },
  fetchFn: id => accessWatchSdkDatabase.getRobot({ uuid: id }),
  sessionId: 'robot.id',
  type: 'robot',
});

const searchAddresses = searchSessions({
  fetchFn: address => accessWatchSdkDatabase.getAddress(address),
  sessionId: 'address.value',
  type: 'address',
});

const logsEndpoint = client => {
  const search = searchLogs(client);
  return (req, res) => {
    const { query } = req;
    search(query).then(logs => res.send(logs));
  };
};

const elasticSearchBuilder = config => {
  const esClient = new elasticsearch.Client(config);
  const gc = indexesGc(esClient);
  monitor.status = 'Started';
  setImmediate(gc);
  setInterval(gc, 24 * 3600 * 1000);
  return {
    index: indexLog(esClient),
    searchLogs: searchLogs(esClient),
    searchRobots: searchRobots(esClient),
    searchAddresses: searchAddresses(esClient),
    logsEndpoint: logsEndpoint(esClient),
  };
};

module.exports = elasticSearchBuilder;
