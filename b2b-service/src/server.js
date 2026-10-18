'use strict';
/**
 * 단독 실행용 엔트리포인트.
 *   DATABASE_URL=postgres://user:pass@host:5432/db node src/server.js
 *
 * 운영에서는 기존 인증 미들웨어 뒤에 라우터를 마운트한다 (src/index.js 참고).
 * B2B_DEV_HEADER_AUTH=1 이면 개발 편의를 위해 X-Tenant-Id / X-User-Id 헤더로
 * 컨텍스트를 받는다. 이 모드는 NODE_ENV=production 에서 켜지지 않는다.
 */
const express = require('express');
const { createSequelize, initModels, createB2BRouter } = require('./index');
const { requestId } = require('./lib/errors');

const PORT = Number(process.env.PORT || 3000);
const devHeaderAuth = process.env.B2B_DEV_HEADER_AUTH === '1' && process.env.NODE_ENV !== 'production';

async function main() {
  const sequelize = createSequelize();
  await sequelize.authenticate();
  const models = initModels(sequelize);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const getContext = devHeaderAuth
    ? (req) => ({ tenantId: req.get('X-Tenant-Id'), userId: req.get('X-User-Id') })
    : undefined; // 기본: req.auth / req.user (상위 인증 미들웨어가 채움)

  app.use(
    '/api/b2b',
    createB2BRouter({
      sequelize,
      models,
      config: { timeZone: process.env.B2B_TIMEZONE || 'Asia/Seoul' },
      ...(getContext ? { getContext } : {}),
    })
  );

  const server = app.listen(PORT, () => console.log(`[b2b] listening on :${PORT}${devHeaderAuth ? ' (dev header auth)' : ''}`));

  // 진행 중인 요청/트랜잭션을 마무리한 뒤 종료
  const shutdown = (signal) => {
    console.log(`[b2b] ${signal} received, shutting down`);
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[b2b] failed to start:', err);
  process.exit(1);
});
