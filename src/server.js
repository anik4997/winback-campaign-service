require('dotenv').config();
const { createApp } = require('./app');
const { pool } = require('./db');

const port = process.env.PORT || 3000;

const app = createApp({
  db: pool,
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
});

app.listen(port, () => {
  console.log(`api listening on :${port}`);
});
