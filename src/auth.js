const crypto = require('crypto');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// merchant comes from the api key, never from the request body.
// otherwise anyone could pass another merchant's id and mail their customers
function requireMerchant(db) {
  return async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';
      const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!key) return res.status(401).json({ error: 'missing api key' });

      const { rows } = await db.query('select id from merchants where api_key_hash = $1', [hashKey(key)]);
      if (!rows.length) return res.status(401).json({ error: 'invalid api key' });

      req.merchantId = rows[0].id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireMerchant, hashKey };
