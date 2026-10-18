'use strict';
/**
 * 미수금(외상매출금) 원장 / 입금 처리 / 거래처별 미수금 현황 집계.
 *
 * 회계 인식 시점
 *   - 외상 발생(total_order_amount 증가) : 주문이 DELIVERED(출고완료)로 바뀌는 순간
 *   - 회수(total_paid_amount 증가)       : 입금 등록 시
 *   - 잔액(balance)                       : DB GENERATED 컬럼 = 발생 누계 - 입금 누계
 */
const { QueryTypes, Transaction, UniqueConstraintError } = require('sequelize');
const { notFound, conflict } = require('../lib/errors');
const { withTransaction } = require('../lib/transaction');
const { toWon } = require('../lib/money');
const v = require('../lib/validate');
const { num, serializeReceivable, serializePayment } = require('../lib/serializers');
const { PAYMENT_METHODS } = require('../models');

const AR_RETURNING = 'customer_id, total_order_amount, total_paid_amount, balance, last_delivered_at, last_settled_date';

/**
 * 출고 확정 시 외상 매출 누적 (원자적 UPSERT).
 * 반드시 호출자의 트랜잭션 안에서 실행되어 재고 차감·상태 변경과 함께 커밋/롤백된다.
 */
async function accrueReceivable(sequelize, { tenantId, customerId, amount, deliveredAt, transaction }) {
  const [row] = await sequelize.query(
    `INSERT INTO accounts_receivable (tenant_id, customer_id, total_order_amount, last_delivered_at, created_at, updated_at)
     VALUES (:tenantId, :customerId, :amount, :deliveredAt, now(), now())
     ON CONFLICT (customer_id) DO UPDATE
       SET total_order_amount = accounts_receivable.total_order_amount + EXCLUDED.total_order_amount,
           last_delivered_at  = GREATEST(accounts_receivable.last_delivered_at, EXCLUDED.last_delivered_at),
           updated_at         = now()
     RETURNING ${AR_RETURNING}`,
    { replacements: { tenantId, customerId, amount: String(amount), deliveredAt }, type: QueryTypes.SELECT, transaction }
  );
  return serializeReceivable(row);
}

// 정렬 옵션 화이트리스트 (SQL 인젝션 방지: 사용자 입력을 ORDER BY 에 직접 넣지 않음)
const SORTS = Object.freeze({
  balance_desc: 'balance DESC, customer_id ASC',
  overdue_desc: 'overdue_amount DESC, balance DESC, customer_id ASC',
  name_asc: 'customer_name ASC, customer_id ASC',
  last_settled_asc: 'last_settled_date ASC NULLS FIRST, customer_id ASC',
});

/**
 * 거래처별 미수금 집계 CTE.
 *
 *  ar         : 미수금 원장(누계/입금/잔액)
 *  delivered  : 출고완료 주문 + 결제기한(출고일 + 결제조건일수) + 거래처별 누적 출고액
 *  open_items : FIFO 충당 — 입금액은 가장 오래된 출고 건부터 상계된다고 보고
 *               각 출고 건에 남은 미회수 금액을 계산
 *               open = clamp(누적출고액 - 총입금액, 0, 해당 건 금액)
 *  aging      : 기준일(asOf) 대비 결제기한 경과일로 연체 구간(에이징) 집계
 *  pending    : 아직 출고 전(접수/생산중) 주문 금액 = 향후 외상 예정액
 *  base       : 거래처 기준 LEFT JOIN (외상이 없는 거래처도 0 으로 포함)
 */
function buildReceivablesCte(filterSql) {
  return `
    WITH ar AS (
      SELECT customer_id, total_order_amount, total_paid_amount, balance, last_delivered_at, last_settled_date
        FROM accounts_receivable
       WHERE tenant_id = :tenantId
    ),
    delivered AS (
      SELECT o.customer_id,
             o.total_amount,
             CAST(o.delivered_at AT TIME ZONE :timeZone AS date) + c.payment_terms_days AS due_date,
             SUM(o.total_amount) OVER (
               PARTITION BY o.customer_id
               ORDER BY o.delivered_at, o.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_amount
        FROM b2b_orders o
        JOIN b2b_customers c ON c.id = o.customer_id
       WHERE o.tenant_id = :tenantId
         AND o.status = 'DELIVERED'
    ),
    open_items AS (
      SELECT d.customer_id,
             d.due_date,
             GREATEST(0, LEAST(d.total_amount, d.cumulative_amount - COALESCE(ar.total_paid_amount, 0))) AS open_amount
        FROM delivered d
        LEFT JOIN ar ON ar.customer_id = d.customer_id
    ),
    aging AS (
      SELECT customer_id,
             COALESCE(SUM(open_amount) FILTER (WHERE due_date >= CAST(:asOf AS date)), 0)                     AS not_due_amount,
             COALESCE(SUM(open_amount) FILTER (WHERE CAST(:asOf AS date) - due_date BETWEEN 1 AND 30), 0)  AS overdue_1_30,
             COALESCE(SUM(open_amount) FILTER (WHERE CAST(:asOf AS date) - due_date BETWEEN 31 AND 60), 0) AS overdue_31_60,
             COALESCE(SUM(open_amount) FILTER (WHERE CAST(:asOf AS date) - due_date BETWEEN 61 AND 90), 0) AS overdue_61_90,
             COALESCE(SUM(open_amount) FILTER (WHERE CAST(:asOf AS date) - due_date > 90), 0)              AS overdue_over_90,
             MIN(due_date) FILTER (WHERE open_amount > 0)                                                   AS oldest_open_due_date
        FROM open_items
       GROUP BY customer_id
    ),
    pending AS (
      SELECT customer_id,
             COUNT(*)          AS pending_order_count,
             SUM(total_amount) AS pending_amount
        FROM b2b_orders
       WHERE tenant_id = :tenantId
         AND status IN ('RECEIVED', 'IN_PRODUCTION')
       GROUP BY customer_id
    ),
    base AS (
      SELECT c.id                                    AS customer_id,
             c.name                                  AS customer_name,
             c.business_no,
             c.contact_name,
             c.contact_phone,
             c.payment_terms_days,
             c.credit_limit,
             c.is_active,
             COALESCE(ar.total_order_amount, 0)      AS total_order_amount,
             COALESCE(ar.total_paid_amount, 0)       AS total_paid_amount,
             COALESCE(ar.balance, 0)                 AS balance,
             ar.last_delivered_at,
             ar.last_settled_date,
             COALESCE(ag.not_due_amount, 0)          AS not_due_amount,
             COALESCE(ag.overdue_1_30, 0)            AS overdue_1_30,
             COALESCE(ag.overdue_31_60, 0)           AS overdue_31_60,
             COALESCE(ag.overdue_61_90, 0)           AS overdue_61_90,
             COALESCE(ag.overdue_over_90, 0)         AS overdue_over_90,
             COALESCE(ag.overdue_1_30 + ag.overdue_31_60 + ag.overdue_61_90 + ag.overdue_over_90, 0) AS overdue_amount,
             ag.oldest_open_due_date,
             CASE WHEN ag.oldest_open_due_date < CAST(:asOf AS date)
                  THEN CAST(:asOf AS date) - ag.oldest_open_due_date
                  ELSE 0 END                         AS max_overdue_days,
             COALESCE(p.pending_order_count, 0)      AS pending_order_count,
             COALESCE(p.pending_amount, 0)           AS pending_amount,
             CASE WHEN c.credit_limit IS NULL THEN NULL
                  ELSE c.credit_limit - COALESCE(ar.balance, 0) - COALESCE(p.pending_amount, 0)
             END                                     AS available_credit
        FROM b2b_customers c
        LEFT JOIN ar          ON ar.customer_id = c.id
        LEFT JOIN aging ag    ON ag.customer_id = c.id
        LEFT JOIN pending p   ON p.customer_id  = c.id
       WHERE c.tenant_id = :tenantId
       ${filterSql}
    )`;
}

function serializeReceivableRow(r) {
  return {
    customerId: num(r.customer_id),
    customerName: r.customer_name,
    businessNo: r.business_no,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    isActive: r.is_active,
    paymentTermsDays: r.payment_terms_days,
    creditLimit: num(r.credit_limit),
    availableCredit: num(r.available_credit),
    totalOrderAmount: num(r.total_order_amount), // 누적 외상값(출고 기준)
    totalPaidAmount: num(r.total_paid_amount), // 누적 입금액
    balance: num(r.balance), // 미입금 잔액 (음수 = 선수금)
    lastDeliveredAt: r.last_delivered_at,
    lastSettledDate: r.last_settled_date, // 최종 정산일
    pendingOrderCount: num(r.pending_order_count),
    pendingAmount: num(r.pending_amount), // 출고 전 주문(향후 외상 예정)
    aging: {
      notDue: num(r.not_due_amount),
      overdue1To30: num(r.overdue_1_30),
      overdue31To60: num(r.overdue_31_60),
      overdue61To90: num(r.overdue_61_90),
      overdueOver90: num(r.overdue_over_90),
      overdueTotal: num(r.overdue_amount),
      oldestOpenDueDate: r.oldest_open_due_date,
      maxOverdueDays: num(r.max_overdue_days),
    },
  };
}

function createReceivableService({ sequelize, models, config }) {
  const { B2BCustomer, B2BPayment } = models;

  /** [GET] /receivables — 거래처별 미수금 현황 + 전체 합계 */
  async function listReceivables({ tenantId, query }) {
    const today = v.todayInTimeZone(config.timeZone);
    const asOf = v.parseDate(query.asOf, 'asOf', { defaultValue: today });
    const search = v.optionalString(query.search, 'search', 100);
    const onlyOutstanding = v.parseBoolean(query.onlyOutstanding, 'onlyOutstanding', false);
    const overdueOnly = v.parseBoolean(query.overdueOnly, 'overdueOnly', false);
    const sort = v.parseEnum(query.sort, 'sort', Object.keys(SORTS), { required: false, defaultValue: 'balance_desc' });
    const limit = v.parseIntInRange(query.limit, 'limit', { min: 1, max: 200, defaultValue: 50 });
    const offset = v.parseIntInRange(query.offset, 'offset', { min: 0, max: 1_000_000, defaultValue: 0 });

    const replacements = { tenantId, timeZone: config.timeZone, asOf, limit, offset };
    const filters = [];
    if (search) {
      const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
      replacements.namePattern = `%${escaped}%`;
      replacements.bizPattern = `%${escaped.replace(/-/g, '')}%`;
      filters.push('AND (c.name ILIKE :namePattern OR c.business_no LIKE :bizPattern)');
    }
    if (onlyOutstanding) filters.push('AND COALESCE(ar.balance, 0) > 0');
    if (overdueOnly) filters.push('AND ag.oldest_open_due_date < CAST(:asOf AS date)');
    const cte = buildReceivablesCte(filters.join('\n       '));

    // 목록과 합계를 같은 스냅샷에서 읽어 숫자가 서로 어긋나지 않게 한다.
    const { rows, summary } = await sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const rows = await sequelize.query(`${cte} SELECT * FROM base ORDER BY ${SORTS[sort]} LIMIT :limit OFFSET :offset`, {
          replacements,
          type: QueryTypes.SELECT,
          transaction,
        });
        const [summary] = await sequelize.query(
          `${cte}
           SELECT COUNT(*)                                     AS customer_count,
                  COUNT(*) FILTER (WHERE balance > 0)          AS outstanding_customer_count,
                  COUNT(*) FILTER (WHERE overdue_amount > 0)   AS overdue_customer_count,
                  COALESCE(SUM(total_order_amount), 0)         AS total_order_amount,
                  COALESCE(SUM(total_paid_amount), 0)          AS total_paid_amount,
                  COALESCE(SUM(balance), 0)                    AS net_balance,
                  COALESCE(SUM(GREATEST(balance, 0)), 0)       AS total_outstanding,
                  COALESCE(SUM(GREATEST(-balance, 0)), 0)      AS total_prepaid,
                  COALESCE(SUM(not_due_amount), 0)             AS not_due_amount,
                  COALESCE(SUM(overdue_1_30), 0)               AS overdue_1_30,
                  COALESCE(SUM(overdue_31_60), 0)              AS overdue_31_60,
                  COALESCE(SUM(overdue_61_90), 0)              AS overdue_61_90,
                  COALESCE(SUM(overdue_over_90), 0)            AS overdue_over_90,
                  COALESCE(SUM(overdue_amount), 0)             AS overdue_amount,
                  COALESCE(SUM(pending_amount), 0)             AS pending_amount
             FROM base`,
          { replacements, type: QueryTypes.SELECT, transaction }
        );
        return { rows, summary };
      }
    );

    return {
      asOf,
      summary: {
        customerCount: num(summary.customer_count),
        outstandingCustomerCount: num(summary.outstanding_customer_count),
        overdueCustomerCount: num(summary.overdue_customer_count),
        totalOrderAmount: num(summary.total_order_amount), // 전체 누적 외상값
        totalPaidAmount: num(summary.total_paid_amount),
        totalOutstanding: num(summary.total_outstanding), // 전체 미입금 잔액(선수금 제외)
        totalPrepaid: num(summary.total_prepaid),
        netBalance: num(summary.net_balance),
        pendingAmount: num(summary.pending_amount),
        aging: {
          notDue: num(summary.not_due_amount),
          overdue1To30: num(summary.overdue_1_30),
          overdue31To60: num(summary.overdue_31_60),
          overdue61To90: num(summary.overdue_61_90),
          overdueOver90: num(summary.overdue_over_90),
          overdueTotal: num(summary.overdue_amount),
        },
      },
      pagination: { limit, offset, total: num(summary.customer_count), sort },
      items: rows.map(serializeReceivableRow),
    };
  }

  /**
   * [POST] /receivables/:customerId/payments — 입금 등록 (미수금 차감)
   * 기본적으로 미수금 잔액을 초과하는 입금은 거부한다. 선입금(선수금)으로 받으려면
   * allowOverpayment: true 를 명시한다.
   */
  async function recordPayment({ tenantId, userId, customerId, body, idempotencyKey }) {
    v.requireBody(body);
    const today = v.todayInTimeZone(config.timeZone);
    const amount = v.parseWon(body.amount, 'amount', { min: 1 });
    const paidDate = v.parseDate(body.paidDate, 'paidDate', { defaultValue: today });
    if (paidDate > today) throw v.fail('paidDate', '미래 날짜로 입금을 등록할 수 없습니다.', paidDate);
    const method = v.parseEnum(body.method, 'method', PAYMENT_METHODS, { required: false, defaultValue: 'BANK_TRANSFER' });
    const reference = v.optionalString(body.reference, 'reference', 100);
    const memo = v.optionalString(body.memo, 'memo', 1000);
    const allowOverpayment = v.parseBoolean(body.allowOverpayment, 'allowOverpayment', false);

    const findExisting = async (transaction) => {
      const payment = await B2BPayment.findOne({ where: { tenantId, idempotencyKey }, transaction });
      if (!payment) return null;
      if (String(payment.customerId) !== customerId || toWon(payment.amount) !== BigInt(amount)) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', '같은 Idempotency-Key 로 다른 입금이 이미 등록되어 있습니다.');
      }
      const [ar] = await sequelize.query(`SELECT ${AR_RETURNING} FROM accounts_receivable WHERE customer_id = :customerId`, {
        replacements: { customerId },
        type: QueryTypes.SELECT,
        transaction,
      });
      return { payment: serializePayment(payment), receivable: serializeReceivable(ar), created: false };
    };

    try {
      return await withTransaction(sequelize, async (transaction) => {
        // 거래처 행 잠금 → 같은 거래처의 동시 입금 처리를 직렬화 (초과 입금 검사 정확성 보장)
        const customer = await B2BCustomer.findOne({ where: { id: customerId, tenantId }, lock: transaction.LOCK.NO_KEY_UPDATE, transaction });
        if (!customer) throw notFound('CUSTOMER_NOT_FOUND', '거래처를 찾을 수 없습니다.');

        if (idempotencyKey) {
          const existing = await findExisting(transaction);
          if (existing) return existing;
        }

        const [current] = await sequelize.query('SELECT balance FROM accounts_receivable WHERE customer_id = :customerId', {
          replacements: { customerId },
          type: QueryTypes.SELECT,
          transaction,
        });
        const balance = current ? toWon(current.balance) : 0n;
        if (!allowOverpayment && BigInt(amount) > balance) {
          throw conflict('OVERPAYMENT', '입금액이 미수금 잔액을 초과합니다. 선입금이면 allowOverpayment 를 true 로 보내 주세요.', {
            balance: num(balance),
            amount,
          });
        }

        const payment = await B2BPayment.create(
          { tenantId, customerId, amount, paidDate, method, reference, memo, idempotencyKey, createdBy: userId },
          { transaction }
        );

        const [ar] = await sequelize.query(
          `INSERT INTO accounts_receivable (tenant_id, customer_id, total_paid_amount, last_settled_date, created_at, updated_at)
           VALUES (:tenantId, :customerId, :amount, CAST(:paidDate AS date), now(), now())
           ON CONFLICT (customer_id) DO UPDATE
             SET total_paid_amount = accounts_receivable.total_paid_amount + EXCLUDED.total_paid_amount,
                 last_settled_date = GREATEST(accounts_receivable.last_settled_date, EXCLUDED.last_settled_date),
                 updated_at        = now()
           RETURNING ${AR_RETURNING}`,
          { replacements: { tenantId, customerId, amount: String(amount), paidDate }, type: QueryTypes.SELECT, transaction }
        );

        return { payment: serializePayment(payment), receivable: serializeReceivable(ar), created: true };
      });
    } catch (err) {
      // 서로 다른 커넥션에서 같은 키로 동시에 들어온 경우: 먼저 커밋된 건을 그대로 돌려준다.
      if (idempotencyKey && err instanceof UniqueConstraintError && err.parent?.constraint === 'uq_b2b_payments_idempotency') {
        const existing = await findExisting(undefined);
        if (existing) return existing;
      }
      throw err;
    }
  }

  return { listReceivables, recordPayment };
}

module.exports = { createReceivableService, accrueReceivable, buildReceivablesCte };
