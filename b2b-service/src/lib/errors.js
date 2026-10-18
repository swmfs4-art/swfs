'use strict';
const crypto = require('crypto');
const {
  ValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  DatabaseError,
  ConnectionError,
  TimeoutError,
} = require('sequelize');

/**
 * 비즈니스 오류. status 는 HTTP 상태코드, code 는 클라이언트가 분기할 수 있는 고정 문자열.
 * details 에는 어떤 품목의 단가가 없는지, 어느 품목 재고가 얼마나 부족한지 등 화면에
 * 바로 보여줄 수 있는 정보를 담는다.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message, details) => new AppError(404, code, message, details);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

// PostgreSQL SQLSTATE
const PG = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  INVALID_TEXT_REPRESENTATION: '22P02',
  NUMERIC_OUT_OF_RANGE: '22003',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
});

const pgCode = (err) => err?.parent?.code || err?.original?.code || err?.code;

/** 트랜잭션 재시도로 해결 가능한 동시성 오류인지 */
const isRetryableDbError = (err) => [PG.SERIALIZATION_FAILURE, PG.DEADLOCK_DETECTED].includes(pgCode(err));

/** Sequelize / pg 오류를 AppError 로 변환. 변환 불가하면 null (→ 500). */
function translateDbError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof UniqueConstraintError) {
    return conflict('DUPLICATE_RESOURCE', '이미 존재하는 데이터입니다.', {
      constraint: err.parent?.constraint,
      fields: err.fields,
    });
  }
  if (err instanceof ForeignKeyConstraintError) {
    return conflict('REFERENCE_CONSTRAINT', '연결된 데이터가 없거나, 다른 데이터가 참조 중입니다.', {
      constraint: err.parent?.constraint,
    });
  }
  if (err instanceof ValidationError) {
    return unprocessable(
      'VALIDATION_FAILED',
      '입력값이 올바르지 않습니다.',
      err.errors?.map((e) => ({ field: e.path, message: e.message }))
    );
  }
  if (err instanceof ConnectionError || err instanceof TimeoutError) {
    return new AppError(503, 'DATABASE_UNAVAILABLE', '데이터베이스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (err instanceof DatabaseError) {
    switch (pgCode(err)) {
      case PG.CHECK_VIOLATION:
      case PG.NOT_NULL_VIOLATION:
      case PG.INVALID_TEXT_REPRESENTATION:
      case PG.NUMERIC_OUT_OF_RANGE:
        return unprocessable('CONSTRAINT_VIOLATION', '데이터 제약 조건을 위반했습니다.', {
          constraint: err.parent?.constraint,
        });
      case PG.EXCLUSION_VIOLATION:
        return conflict('PERIOD_OVERLAP', '적용 기간이 겹치는 데이터가 이미 있습니다.', {
          constraint: err.parent?.constraint,
        });
      case PG.SERIALIZATION_FAILURE:
      case PG.DEADLOCK_DETECTED:
      case PG.LOCK_NOT_AVAILABLE:
        return new AppError(503, 'CONCURRENT_UPDATE', '동시에 처리 중인 요청이 있습니다. 잠시 후 다시 시도해 주세요.');
      default:
        return null;
    }
  }
  return null;
}

/** 모든 요청에 X-Request-Id 부여 (로그와 에러 응답을 연결하기 위함) */
function requestId(req, res, next) {
  const incoming = req.get('X-Request-Id');
  req.id = incoming && /^[\w.-]{1,100}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

/** Express 4/5 공용: async 핸들러의 reject 를 next(err) 로 전달 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 라우터 전용 에러 핸들러. 내부 오류 메시지/스택은 응답에 노출하지 않는다. */
function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let appErr = translateDbError(err);

    // express.json() 파싱 실패
    if (!appErr && err?.type === 'entity.parse.failed') {
      appErr = badRequest('INVALID_JSON', '요청 본문이 올바른 JSON 형식이 아닙니다.');
    }
    if (!appErr && err?.type === 'entity.too.large') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.');
    }

    if (!appErr) {
      logger.error(
        JSON.stringify({
          level: 'error',
          msg: 'Unhandled B2B API error',
          requestId: req.id,
          method: req.method,
          path: req.originalUrl,
          error: err?.message,
          stack: err?.stack,
        })
      );
      appErr = new AppError(500, 'INTERNAL_ERROR', '서버 내부 오류가 발생했습니다.');
    } else if (appErr.status >= 500) {
      logger.warn(
        JSON.stringify({ level: 'warn', msg: appErr.code, requestId: req.id, path: req.originalUrl, error: err?.message })
      );
    }

    if (res.headersSent) return;
    if (appErr.status === 503) res.set('Retry-After', '1');
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId: req.id,
      },
    });
  };
}

module.exports = {
  AppError,
  badRequest,
  notFound,
  conflict,
  unprocessable,
  PG,
  pgCode,
  isRetryableDbError,
  translateDbError,
  requestId,
  asyncHandler,
  errorHandler,
};
