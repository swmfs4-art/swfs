'use strict';
/**
 * 실제 PostgreSQL 대상 통합 테스트.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/atc_b2b_test npm test
 * 주의: 대상 DB 의 public 스키마를 초기화한다. 테스트 전용 DB 에서만 실행할 것.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createSequelize, initModels, createB2BRouter } = require('../src');
const { migrate } = require('../scripts/migrate');
const { isValidBusinessNo } = require('../src/services/customerService');
const { todayInTimeZone, addDays } = require('../src/lib/validate');

const DB_URL = process.env.TEST_DATABASE_URL;
const TENANT = 1;
const OTHER_TENANT = 2;

/** 체크섬이 맞는 사업자번호 생성 */
function makeBusinessNo(prefix9) {
  for (let d = 0; d <= 9; d += 1) if (isValidBusinessNo(`${prefix9}${d}`)) return `${prefix9}${d}`;
  throw new Error('unreachable');
}

describe('B2B API', { skip: !DB_URL && 'TEST_DATABASE_URL 미설정' }, () => {
  let sequelize;
  let server;
  let baseUrl;
  const P = {}; // 품목 id

  async function api(method, path, { body, tenant = TENANT, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}/api/b2b${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-tenant-id': String(tenant), 'x-user-id': 'tester', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json };
  }

  const stock = async (productId) => {
    const [[row]] = await sequelize.query('SELECT quantity FROM inventories WHERE product_id = :productId', { replacements: { productId } });
    return Number(row.quantity);
  };

  async function createCustomer(fields = {}) {
    const res = await api('POST', '/customers', {
      body: {
        name: '테스트 거래처',
        businessNo: makeBusinessNo(String(100000000 + Math.floor(Math.random() * 800000000))),
        contactName: '김담당',
        contactPhone: '010-1234-5678',
        defaultDeliveryAddress: '서울시 강남구 테헤란로 1',
        paymentTermsDays: 30,
        ...fields,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  async function setPrice(customerId, productId, unitPrice, extra = {}) {
    const res = await api('POST', `/customers/${customerId}/prices`, { body: { productId, unitPrice, validFrom: '2026-01-01', ...extra } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  async function createOrder(customerId, items, extra = {}, headers = {}) {
    return api('POST', '/orders', {
      body: { customerId, orderDate: todayInTimeZone('Asia/Seoul'), deliveryDueDate: addDays(todayInTimeZone('Asia/Seoul'), 2), items, ...extra },
      headers,
    });
  }

  before(async () => {
    sequelize = createSequelize(DB_URL);
    await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(sequelize, { logger: { info() {} } });

    // 품목 마스터 + 재고 시드 (기존 시스템 테이블)
    const seed = [
      ['sauce', TENANT, '수제 바베큐 소스 1kg', 'EA', 'FINISHED', 'TAXABLE', '100'],
      ['kimchi', TENANT, '포기김치 10kg', 'BOX', 'FINISHED', 'TAXABLE', '50'],
      ['cabbage', TENANT, '절임배추', 'KG', 'RAW', 'EXEMPT', '200.000'],
      ['other', OTHER_TENANT, '타 테넌트 품목', 'EA', 'FINISHED', 'TAXABLE', '10'],
    ];
    for (const [key, tenantId, name, unit, type, tax, qty] of seed) {
      const [[row]] = await sequelize.query(
        `INSERT INTO products (tenant_id, name, unit, product_type, tax_type) VALUES (:tenantId, :name, :unit, :type, :tax) RETURNING id`,
        { replacements: { tenantId, name, unit, type, tax } }
      );
      P[key] = Number(row.id);
      await sequelize.query('INSERT INTO inventories (tenant_id, product_id, quantity) VALUES (:tenantId, :id, :qty)', {
        replacements: { tenantId, id: row.id, qty },
      });
    }

    const models = initModels(sequelize);
    const app = express();
    app.use(
      '/api/b2b',
      createB2BRouter({
        sequelize,
        models,
        getContext: (req) => ({ tenantId: req.get('x-tenant-id'), userId: req.get('x-user-id') }),
        logger: { error() {}, warn() {} },
      })
    );
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await sequelize?.close();
  });

  test('주문 등록: 거래처 단가 자동 매핑 + 공급가액/부가세(면세 포함) 계산', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 12_345);
    await setPrice(c.id, P.cabbage, 3_333);

    // 다른 거래처는 같은 품목을 다른 단가로 납품
    const c2 = await createCustomer({ name: '다른 거래처' });
    await setPrice(c2.id, P.sauce, 9_000);

    const res = await createOrder(c.id, [
      { productId: P.sauce, quantity: 3 },
      { productId: P.cabbage, quantity: '2.5' },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const o = res.body.data;
    assert.match(o.orderNo, /^B2B-\d{8}-\d{6}$/);
    assert.equal(o.status, 'RECEIVED');
    assert.equal(o.deliveryAddress, '서울시 강남구 테헤란로 1');

    const [sauce, cabbage] = o.items;
    assert.deepEqual(
      [sauce.unitPrice, sauce.supplyAmount, sauce.vatAmount, sauce.lineTotal],
      [12_345, 37_035, 3_703, 40_738] // VAT 3703.5 → 절사
    );
    assert.deepEqual(
      [cabbage.taxType, cabbage.quantity, cabbage.supplyAmount, cabbage.vatAmount],
      ['EXEMPT', 2.5, 8_333, 0] // 8332.5 → 반올림, 면세
    );
    assert.equal(o.totalSupplyAmount, 45_368);
    assert.equal(o.totalVatAmount, 3_703);
    assert.equal(o.totalAmount, 49_071);

    const res2 = await createOrder(c2.id, [{ productId: P.sauce, quantity: 1 }]);
    assert.equal(res2.body.data.items[0].unitPrice, 9_000);
  });

  test('단가 변경: 기존 단가 자동 마감, 주문일 기준 단가 적용', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 10_000, { validFrom: '2026-01-01' });
    await setPrice(c.id, P.sauce, 11_000, { validFrom: '2026-06-01' });

    const prices = await api('GET', `/customers/${c.id}/prices?asOf=2026-03-01`);
    assert.equal(prices.body.items[0].unitPrice, 10_000);
    assert.equal(prices.body.items[0].validTo, '2026-05-31');

    const before = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }], { orderDate: '2026-05-31', deliveryDueDate: '2026-06-02' });
    const afterChange = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }], { orderDate: '2026-06-01', deliveryDueDate: '2026-06-02' });
    assert.equal(before.body.data.items[0].unitPrice, 10_000);
    assert.equal(afterChange.body.data.items[0].unitPrice, 11_000);
  });

  test('주문 등록 검증: 단가 미등록, 클라이언트 단가, 중복 품목, 타 테넌트 품목, 날짜', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);

    let res = await createOrder(c.id, [{ productId: P.kimchi, quantity: 1 }]);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'PRICE_NOT_SET');
    assert.equal(res.body.error.details.products[0].productId, P.kimchi);

    res = await createOrder(c.id, [{ productId: P.sauce, quantity: 1, unitPrice: 1 }]);
    assert.equal(res.body.error.code, 'UNIT_PRICE_NOT_ALLOWED');

    res = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }, { productId: P.sauce, quantity: 2 }]);
    assert.equal(res.body.error.code, 'DUPLICATE_ORDER_ITEM');

    res = await createOrder(c.id, [{ productId: P.other, quantity: 1 }]);
    assert.equal(res.body.error.code, 'PRODUCT_NOT_FOUND');

    res = await createOrder(c.id, [{ productId: P.sauce, quantity: '1.2345' }]);
    assert.equal(res.body.error.code, 'INVALID_QUANTITY');

    res = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }], { orderDate: '2026-10-10', deliveryDueDate: '2026-10-09' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.field, 'deliveryDueDate');

    res = await api('POST', '/orders', { body: '{bad json' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
    assert.ok(res.body.error.requestId);
  });

  test('Idempotency-Key: 같은 키로 재요청하면 기존 주문을 반환', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);
    const headers = { 'Idempotency-Key': `order-${Date.now()}` };
    const [a, b] = await Promise.all([
      createOrder(c.id, [{ productId: P.sauce, quantity: 1 }], {}, headers),
      createOrder(c.id, [{ productId: P.sauce, quantity: 1 }], {}, headers),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.data.id, b.body.data.id);
  });

  test('여신 한도 초과 시 주문 거부', async () => {
    const c = await createCustomer({ creditLimit: 50_000 });
    await setPrice(c.id, P.sauce, 10_000);
    const ok = await createOrder(c.id, [{ productId: P.sauce, quantity: 4 }]); // 44,000
    assert.equal(ok.status, 201);
    const res = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }]); // +11,000 → 55,000
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CREDIT_LIMIT_EXCEEDED');
    assert.equal(res.body.error.details.exceededBy, 5_000);
  });

  test('상태 변경: 출고완료 시 재고 차감 + 수불 기록 + 미수금 누적 (트랜잭션)', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 10_000);
    await setPrice(c.id, P.cabbage, 2_000);
    const { body } = await createOrder(c.id, [
      { productId: P.sauce, quantity: 2 },
      { productId: P.cabbage, quantity: '1.250' },
    ]);
    const orderId = body.data.id;
    const sauceBefore = await stock(P.sauce);
    const cabbageBefore = await stock(P.cabbage);

    let res = await api('PATCH', `/orders/${orderId}/status`, { body: { status: 'IN_PRODUCTION' } });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.productionStartedAt);
    assert.equal(await stock(P.sauce), sauceBefore, '생산 시작만으로는 재고가 변하지 않음');

    res = await api('PATCH', `/orders/${orderId}/status`, { body: { status: 'DELIVERED' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'DELIVERED');
    assert.equal(await stock(P.sauce), sauceBefore - 2);
    assert.equal(await stock(P.cabbage), cabbageBefore - 1.25);
    assert.equal(res.body.inventory.length, 2);
    assert.equal(res.body.receivable.totalOrderAmount, 22_000 + 2_500);
    assert.equal(res.body.receivable.balance, 24_500);

    const [[mv]] = await sequelize.query('SELECT COUNT(*)::int AS n FROM inventory_movements WHERE ref_id = :orderId', { replacements: { orderId } });
    assert.equal(mv.n, 2);

    // 같은 상태로 재요청 → 멱등 (재고 이중 차감 없음)
    res = await api('PATCH', `/orders/${orderId}/status`, { body: { status: 'DELIVERED' } });
    assert.equal(res.body.changed, false);
    assert.equal(await stock(P.sauce), sauceBefore - 2);

    // 출고 후 취소 불가
    res = await api('PATCH', `/orders/${orderId}/status`, { body: { status: 'CANCELLED', reason: '변심' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');

    const [history] = await sequelize.query('SELECT to_status FROM b2b_order_status_history WHERE order_id = :orderId ORDER BY id', {
      replacements: { orderId },
    });
    assert.deepEqual(history.map((h) => h.to_status), ['RECEIVED', 'IN_PRODUCTION', 'DELIVERED']);
  });

  test('재고 부족 시 전체 롤백 (일부 품목만 차감되는 일 없음)', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);
    await setPrice(c.id, P.kimchi, 1_000);
    const kimchiStock = await stock(P.kimchi);
    const { body } = await createOrder(c.id, [
      { productId: P.sauce, quantity: 1 },
      { productId: P.kimchi, quantity: kimchiStock + 1 },
    ]);
    const sauceBefore = await stock(P.sauce);

    const res = await api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'DELIVERED' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(res.body.error.details.shortages.map((s) => s.productId), [P.kimchi]);
    assert.equal(await stock(P.sauce), sauceBefore, '소스 재고도 롤백되어야 함');

    const order = await api('GET', `/orders/${body.data.id}`);
    assert.equal(order.body.data.status, 'RECEIVED');
    const [[ar]] = await sequelize.query('SELECT COUNT(*)::int AS n FROM accounts_receivable WHERE customer_id = :id', { replacements: { id: c.id } });
    assert.equal(ar.n, 0, '미수금도 생기지 않아야 함');
  });

  test('동시 출고 요청: 한 번만 차감', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);
    const { body } = await createOrder(c.id, [{ productId: P.sauce, quantity: 5 }]);
    const before = await stock(P.sauce);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'DELIVERED' } }))
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results.filter((r) => r.body.changed).length, 1);
    assert.equal(await stock(P.sauce), before - 5);
  });

  test('동시성: 신규 거래처의 첫 출고·선입금·주문 등록이 동시에 들어와도 원장이 정합', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.kimchi, 1_000); // 1개 = 1,100
    const orders = [];
    for (let i = 0; i < 4; i += 1) orders.push((await createOrder(c.id, [{ productId: P.kimchi, quantity: 1 }])).body.data.id);
    const before = await stock(P.kimchi);

    const results = await Promise.all([
      ...orders.map((id) => api('PATCH', `/orders/${id}/status`, { body: { status: 'DELIVERED' } })),
      ...[1, 2, 3].map(() => api('POST', `/receivables/${c.id}/payments`, { body: { amount: 500, allowOverpayment: true } })),
      ...[1, 2].map(() => createOrder(c.id, [{ productId: P.kimchi, quantity: 1 }])),
    ]);
    assert.ok(results.every((r) => r.status < 300), JSON.stringify(results.filter((r) => r.status >= 300).map((r) => r.body)));

    const [[ledger]] = await sequelize.query(
      `SELECT ar.total_order_amount, ar.total_paid_amount, ar.balance,
              (SELECT SUM(total_amount) FROM b2b_orders WHERE customer_id = :id AND status = 'DELIVERED') AS delivered_sum,
              (SELECT SUM(amount) FROM b2b_payments WHERE customer_id = :id) AS paid_sum
         FROM accounts_receivable ar WHERE ar.customer_id = :id`,
      { replacements: { id: c.id } }
    );
    assert.equal(Number(ledger.total_order_amount), 4_400);
    assert.equal(Number(ledger.total_order_amount), Number(ledger.delivered_sum));
    assert.equal(Number(ledger.total_paid_amount), Number(ledger.paid_sum));
    assert.equal(Number(ledger.balance), 4_400 - 1_500);
    assert.equal(await stock(P.kimchi), before - 4);
  });

  test('취소는 사유 필수, 재고 변동 없음', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);
    const { body } = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }]);
    let res = await api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'CANCELLED' } });
    assert.equal(res.status, 422);
    res = await api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'CANCELLED', reason: '거래처 요청' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.cancelReason, '거래처 요청');
    res = await api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'DELIVERED' } });
    assert.equal(res.body.error.code, 'INVALID_STATUS_TRANSITION');
  });

  test('미수금 현황: 누적 외상값, 입금, 잔액, FIFO 에이징, 합계', async () => {
    const c = await createCustomer({ name: '에이징 거래처', paymentTermsDays: 10 });
    await setPrice(c.id, P.sauce, 10_000); // 1개 = 11,000 (VAT 포함)
    const today = todayInTimeZone('Asia/Seoul');

    const ids = [];
    for (const q of [1, 2, 3]) {
      const { body } = await createOrder(c.id, [{ productId: P.sauce, quantity: q }], { orderDate: addDays(today, -60), deliveryDueDate: today });
      await api('PATCH', `/orders/${body.data.id}/status`, { body: { status: 'DELIVERED' } });
      ids.push(body.data.id);
    }
    // 출고일을 과거로 조정: 50일 전(기한 40일 경과), 25일 전(15일 경과), 오늘(미도래)
    await sequelize.query(`UPDATE b2b_orders SET delivered_at = now() - interval '50 days' WHERE id = :id`, { replacements: { id: ids[0] } });
    await sequelize.query(`UPDATE b2b_orders SET delivered_at = now() - interval '25 days' WHERE id = :id`, { replacements: { id: ids[1] } });
    // 출고 전 주문 (향후 외상 예정)
    await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }]);

    // 입금 5,000 → FIFO: 가장 오래된 11,000 건에서 먼저 차감 → 6,000 남음
    let pay = await api('POST', `/receivables/${c.id}/payments`, {
      body: { amount: 5_000, paidDate: today, reference: '에이징상사' },
      headers: { 'Idempotency-Key': `pay-${Date.now()}` },
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.receivable.balance, 66_000 - 5_000);

    // 초과 입금 거부
    pay = await api('POST', `/receivables/${c.id}/payments`, { body: { amount: 1_000_000 } });
    assert.equal(pay.status, 409);
    assert.equal(pay.body.error.code, 'OVERPAYMENT');

    const res = await api('GET', `/receivables?search=${encodeURIComponent('에이징')}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.items.length, 1);
    const r = res.body.items[0];
    assert.equal(r.totalOrderAmount, 66_000);
    assert.equal(r.totalPaidAmount, 5_000);
    assert.equal(r.balance, 61_000);
    assert.equal(r.lastSettledDate, today);
    assert.equal(r.pendingOrderCount, 1);
    assert.equal(r.pendingAmount, 11_000);
    assert.deepEqual(
      { ...r.aging, oldestOpenDueDate: undefined },
      { notDue: 33_000, overdue1To30: 22_000, overdue31To60: 6_000, overdue61To90: 0, overdueOver90: 0, overdueTotal: 28_000, oldestOpenDueDate: undefined, maxOverdueDays: 40 }
    );
    assert.equal(res.body.summary.totalOutstanding, 61_000);
    assert.equal(res.body.summary.totalOrderAmount, 66_000);

    // 전체 목록 합계는 거래처별 행의 합과 일치
    const all = await api('GET', '/receivables?limit=200');
    const sum = all.body.items.reduce((acc, i) => acc + i.totalOrderAmount, 0);
    assert.equal(all.body.summary.totalOrderAmount, sum);
    assert.equal(all.body.pagination.total, all.body.items.length);
    const sorted = all.body.items.map((i) => i.balance);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));

    const bad = await api('GET', '/receivables?sort=balance;drop table x');
    assert.equal(bad.status, 422);
  });

  test('테넌트 격리 및 인증', async () => {
    const c = await createCustomer();
    await setPrice(c.id, P.sauce, 1_000);
    const { body } = await createOrder(c.id, [{ productId: P.sauce, quantity: 1 }]);

    let res = await api('GET', `/orders/${body.data.id}`, { tenant: OTHER_TENANT });
    assert.equal(res.status, 404);
    res = await api('PATCH', `/orders/${body.data.id}/status`, { tenant: OTHER_TENANT, body: { status: 'DELIVERED' } });
    assert.equal(res.status, 404);
    res = await api('GET', '/receivables', { tenant: OTHER_TENANT });
    assert.equal(res.body.items.length, 0);
    res = await api('GET', '/receivables', { tenant: '' });
    assert.equal(res.status, 401);
  });

  test('거래처 등록 검증: 사업자번호 체크섬/중복', async () => {
    let res = await api('POST', '/customers', { body: { name: 'x', businessNo: '1234567890' } });
    assert.equal(res.body.error.code, 'INVALID_BUSINESS_NO');
    const businessNo = makeBusinessNo('220816251');
    res = await api('POST', '/customers', { body: { name: 'x', businessNo } });
    assert.equal(res.status, 201);
    res = await api('POST', '/customers', { body: { name: 'y', businessNo: `${businessNo.slice(0, 3)}-${businessNo.slice(3, 5)}-${businessNo.slice(5)}` } });
    assert.equal(res.status, 409);
  });
});
