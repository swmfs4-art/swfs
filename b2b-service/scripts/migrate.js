'use strict';
/**
 * 단순 SQL 마이그레이션 러너.
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *
 * migrations/*.sql 을 파일명 순서대로, 파일 하나당 트랜잭션 하나로 적용하고
 * schema_migrations 테이블에 기록한다. 이미 적용된 파일은 건너뛴다.
 * (Sequelize CLI / umzug 를 쓰는 프로젝트라면 SQL 파일 내용을 그대로 옮기면 된다.)
 */
const fs = require('fs');
const path = require('path');
const { createSequelize } = require('../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function migrate(sequelize, { logger = console } = {}) {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const [rows] = await sequelize.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(sql, { transaction });
      await sequelize.query('INSERT INTO schema_migrations (name) VALUES (:name)', {
        replacements: { name: file },
        transaction,
      });
    });
    logger.info(`[migrate] applied ${file}`);
  }
}

if (require.main === module) {
  const sequelize = createSequelize();
  migrate(sequelize)
    .then(() => sequelize.close())
    .catch(async (err) => {
      console.error('[migrate] failed:', err);
      await sequelize.close();
      process.exit(1);
    });
}

module.exports = { migrate };
