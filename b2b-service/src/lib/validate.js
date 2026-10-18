'use strict';
/**
 * 요청 입력 검증 헬퍼. 실패 시 422(VALIDATION_FAILED) AppError 를 던진다.
 * 외부 라이브러리 없이 필요한 규칙만 명시적으로 검사한다.
 */
const { unprocessable, badRequest } = require('./errors');

const fail = (field, message, value) =>
  unprocessable('VALIDATION_FAILED', `${field}: ${message}`, { field, ...(value !== undefined ? { value } : {}) });

const MAX_BIGINT_ID = 9223372036854775807n;

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', '요청 본문은 JSON 객체여야 합니다.');
  }
  return body;
}

/** 양의 정수 ID(BIGINT) → 문자열. 숫자/숫자 문자열 모두 허용 */
function parseId(value, field) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > MAX_BIGINT_ID) {
    throw fail(field, '양의 정수 ID 여야 합니다.', value);
  }
  return text;
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail(field, '문자열이어야 합니다.');
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw fail(field, `${maxLength}자 이하여야 합니다.`);
  return trimmed === '' ? null : trimmed;
}

function requiredString(value, field, maxLength) {
  const s = optionalString(value, field, maxLength);
  if (s === null) throw fail(field, '필수 항목입니다.');
  return s;
}

/** 'YYYY-MM-DD' 형식 + 실제 존재하는 날짜인지 (2026-02-30 거부) */
function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseDate(value, field, { required = false, defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail(field, '필수 항목입니다. (YYYY-MM-DD)');
    return defaultValue;
  }
  if (!isValidDateString(value)) throw fail(field, '올바른 날짜(YYYY-MM-DD)가 아닙니다.', value);
  return value;
}

/** 특정 타임존 기준 오늘 날짜 'YYYY-MM-DD' (서버가 UTC 여도 한국 영업일 기준으로 계산) */
function todayInTimeZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date()
  );
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseEnum(value, field, allowed, { required = true, defaultValue } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail(field, `필수 항목입니다. (${allowed.join(' | ')})`);
    return defaultValue;
  }
  if (!allowed.includes(value)) throw fail(field, `허용 값: ${allowed.join(' | ')}`, value);
  return value;
}

/** 원 단위 정수 금액 */
function parseWon(value, field, { min = 0, required = true, allowNull = false } = {}) {
  if (value === undefined || value === null) {
    if (allowNull && value === null) return null;
    if (required) throw fail(field, '필수 항목입니다.');
    return undefined;
  }
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n)) throw fail(field, '원 단위 정수여야 합니다.', value);
  if (n < min) throw fail(field, `${min} 이상이어야 합니다.`, value);
  return n;
}

function parseIntInRange(value, field, { min, max, defaultValue }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(field, `${min}~${max} 사이 정수여야 합니다.`, value);
  return n;
}

function parseBoolean(value, field, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw fail(field, 'true 또는 false 여야 합니다.', value);
}

/** Idempotency-Key 헤더 (선택). 네트워크 재시도/더블클릭에 의한 중복 등록 방지 */
function parseIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return null;
  if (!/^[\w.:-]{8,100}$/.test(key)) {
    throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 는 8~100자의 영문/숫자/-_.: 조합이어야 합니다.');
  }
  return key;
}

module.exports = {
  requireBody,
  parseId,
  optionalString,
  requiredString,
  isValidDateString,
  parseDate,
  todayInTimeZone,
  addDays,
  parseEnum,
  parseWon,
  parseIntInRange,
  parseBoolean,
  parseIdempotencyKey,
  fail,
};
