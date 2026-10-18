'use strict';
const { isRetryableDbError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Managed transaction + 동시성 오류(deadlock 40P01 / serialization 40001) 자동 재시도.
 *
 * - fn 안에서 예외가 나면 Sequelize 가 자동 ROLLBACK, 정상 종료 시 COMMIT.
 * - 재시도는 트랜잭션 전체를 처음부터 다시 실행하므로 fn 은 DB 외 부수효과
 *   (외부 API 호출, 메일 발송 등)를 가지면 안 된다. 그런 작업은 커밋 이후에 수행할 것.
 * - lock_timeout 으로 행 잠금 대기를 제한해 커넥션 풀이 무한 대기에 묶이지 않게 한다.
 */
async function withTransaction(sequelize, fn, { retries = 3, isolationLevel, lockTimeoutMs = 5000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sequelize.transaction({ isolationLevel }, async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '${Number(lockTimeoutMs)}ms'`, { transaction });
        return fn(transaction);
      });
    } catch (err) {
      if (attempt >= retries || !isRetryableDbError(err)) throw err;
      // 지수 백오프 + 지터
      await sleep(2 ** attempt * 50 + Math.floor(Math.random() * 50));
    }
  }
}

module.exports = { withTransaction };
