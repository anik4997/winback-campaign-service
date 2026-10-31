// fake pg pool: `handler(sql, params)` decides what each query returns
function fakeDb(handler) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/^\s*(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
    return (await handler(sql, params)) || { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { fakeDb, listen };
