'use strict';
/**
 * 금액/수량 계산. 모든 계산은 BigInt 정수 연산으로 수행한다.
 *   - 금액: 원 단위 정수
 *   - 수량: 소수 셋째 자리까지 → 1/1000 단위 정수(milli)로 환산해 계산
 *
 * 반올림 정책 (세금계산서 실무 기준)
 *   - 공급가액 = 수량 × 단가 → 원 미만 반올림
 *   - 부가세   = 공급가액 × 10% → 원 미만 절사
 */
const { unprocessable } = require('./errors');

const VAT_RATE_PERCENT = 10n;
const QTY_SCALE = 1000n;
const MAX_QUANTITY_INTEGER_DIGITS = 9; // NUMERIC(12,3)
const QUANTITY_PATTERN = /^(\d{1,9})(?:\.(\d{1,3}))?$/;

/**
 * 수량 문자열/숫자 → { text: '12.500', milli: 12500n }
 * 지수 표기(1e3), 음수, 0, 4자리 이상 소수는 거부한다.
 */
function parseQuantity(value, field = 'quantity') {
  const raw = typeof value === 'number' ? String(value) : value;
  const match = typeof raw === 'string' ? QUANTITY_PATTERN.exec(raw.trim()) : null;
  if (!match) {
    throw unprocessable(
      'INVALID_QUANTITY',
      `${field}: 수량은 0보다 큰 숫자(정수 ${MAX_QUANTITY_INTEGER_DIGITS}자리, 소수 3자리 이내)여야 합니다.`,
      { field, value }
    );
  }
  const intPart = match[1];
  const fracPart = (match[2] || '').padEnd(3, '0');
  const milli = BigInt(intPart) * QTY_SCALE + BigInt(fracPart);
  if (milli <= 0n) {
    throw unprocessable('INVALID_QUANTITY', `${field}: 수량은 0보다 커야 합니다.`, { field, value });
  }
  return { milli, text: `${BigInt(intPart)}.${fracPart}` };
}

/** 원 단위 정수 금액(문자열/숫자/BigInt) → BigInt */
function toWon(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Invalid KRW amount: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`Invalid KRW amount: ${value}`);
}

/**
 * 주문 라인 금액 계산
 * @param {bigint} quantityMilli 수량 × 1000
 * @param {bigint} unitPrice     단가(원, VAT 별도)
 * @param {'TAXABLE'|'EXEMPT'} taxType
 */
function calcLineAmounts(quantityMilli, unitPrice, taxType) {
  const supply = (quantityMilli * unitPrice + QTY_SCALE / 2n) / QTY_SCALE; // 반올림
  const vat = taxType === 'TAXABLE' ? (supply * VAT_RATE_PERCENT) / 100n : 0n; // 절사
  return { supply, vat, total: supply + vat };
}

/** BigInt/문자열 금액 → JSON 응답용 Number (안전 범위 검증) */
function toSafeNumber(value) {
  if (value === null || value === undefined) return value;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Amount exceeds safe integer range: ${value}`);
  return n;
}

module.exports = { parseQuantity, toWon, calcLineAmounts, toSafeNumber, VAT_RATE_PERCENT };
