'use strict';
const { Sequelize } = require('sequelize');

/**
 * Sequelize 인스턴스 생성.
 * BIGINT / NUMERIC 은 pg 드라이버가 문자열로 돌려준다. 금액·수량 정밀도를 지키기 위해
 * 일부러 그대로 두고, 응답 직렬화 시점에만 숫자로 변환한다 (src/lib/serializers.js).
 */
function createSequelize(databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL 환경변수가 설정되지 않았습니다.');
  }
  return new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: process.env.SQL_LOG === '1' ? console.log : false,
    pool: {
      max: Number(process.env.DB_POOL_MAX || 10),
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    dialectOptions: process.env.DB_SSL === '1' ? { ssl: { require: true, rejectUnauthorized: true } } : {},
    define: {
      underscored: true,
      freezeTableName: true,
    },
    ...options,
  });
}

module.exports = { createSequelize };
