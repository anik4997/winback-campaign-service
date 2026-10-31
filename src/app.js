const express = require('express');
const { webhookRouter } = require('./webhooks');
const { campaignRouter } = require('./campaigns');

function createApp({ db, webhookSecret }) {
  const app = express();

  // webhooks need the raw body for HMAC, so mount them before express.json()
  app.use('/webhooks', webhookRouter({ db, secret: webhookSecret }));

  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/campaigns', campaignRouter({ db }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
