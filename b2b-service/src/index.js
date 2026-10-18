'use strict';
/**
 * 기존 Express 앱에 붙이는 방법:
 *
 *   const { createSequelize, initModels, createB2BRouter } = require('./b2b-service/src');
 *   const sequelize = createSequelize(process.env.DATABASE_URL);
 *   const models = initModels(sequelize);
 *   app.use('/api/b2b', authMiddleware, createB2BRouter({ sequelize, models }));
 *
 * authMiddleware 는 req.auth = { tenantId, userId } (또는 req.user) 를 채워야 한다.
 */
const { createSequelize } = require('./db');
const { initModels, ORDER_STATUS, TAX_TYPE, PAYMENT_METHODS } = require('./models');
const { createB2BRouter } = require('./routes/b2b');

module.exports = { createSequelize, initModels, createB2BRouter, ORDER_STATUS, TAX_TYPE, PAYMENT_METHODS };
