'use strict';
/**
 * 납품/B2B API 라우터.  app.use('/api/b2b', createB2BRouter({...}))
 *
 *  POST   /customers                           거래처 등록
 *  GET    /customers                           거래처 목록
 *  POST   /customers/:customerId/prices        거래처별 맞춤 단가 등록/변경
 *  GET    /customers/:customerId/prices        거래처 적용 단가 조회
 *  POST   /orders                              ★ 납품 주문 등록 (단가 자동 매핑 + 금액 계산)
 *  GET    /orders/:orderId                     주문 단건 조회
 *  PATCH  /orders/:orderId/status              ★ 주문 상태 변경 (출고완료 시 재고 차감 트랜잭션)
 *  GET    /receivables                         ★ 거래처별 미수금 현황 (집계)
 *  POST   /receivables/:customerId/payments    입금 등록 (미수금 차감)
 */
const express = require('express');
const { AppError, asyncHandler, errorHandler, requestId } = require('../lib/errors');
const v = require('../lib/validate');
const { createOrderService } = require('../services/orderService');
const { createReceivableService } = require('../services/receivableService');
const { createCustomerService } = require('../services/customerService');

const DEFAULT_CONFIG = Object.freeze({
  timeZone: 'Asia/Seoul', // 영업일(주문일·입금일·연체일) 계산 기준
  maxOrderItems: 200,
});

/**
 * 기본 인증 컨텍스트 해석기.
 * 기존 인증 미들웨어가 req.auth 또는 req.user 에 tenantId / userId 를 넣어 준다고 가정한다.
 * 다른 구조라면 createB2BRouter({ getContext }) 로 교체한다.
 */
function defaultGetContext(req) {
  const src = req.auth || req.user || {};
  return { tenantId: src.tenantId, userId: src.userId ?? src.id };
}

function createB2BRouter({ sequelize, models, config = {}, getContext = defaultGetContext, logger = console }) {
  if (!sequelize || !models) throw new Error('createB2BRouter: sequelize 와 models 는 필수입니다.');
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const deps = { sequelize, models, config: cfg };

  const orders = createOrderService(deps);
  const receivables = createReceivableService(deps);
  const customers = createCustomerService(deps);

  const router = express.Router();
  router.use((req, res, next) => (req.id ? next() : requestId(req, res, next)));
  router.use(express.json({ limit: '1mb' }));

  // 테넌트/사용자 컨텍스트 확인 — 인증되지 않은 요청은 어떤 데이터도 조회할 수 없다.
  router.use(
    asyncHandler(async (req, res, next) => {
      const ctx = await getContext(req);
      if (!ctx || ctx.tenantId === undefined || ctx.tenantId === null) {
        throw new AppError(401, 'UNAUTHENTICATED', '인증 정보(tenant)가 없습니다.');
      }
      let tenantId;
      try {
        tenantId = v.parseId(String(ctx.tenantId), 'tenantId');
      } catch {
        throw new AppError(401, 'UNAUTHENTICATED', '인증 정보(tenant)가 올바르지 않습니다.');
      }
      req.b2b = { tenantId, userId: ctx.userId === undefined || ctx.userId === null ? null : String(ctx.userId).slice(0, 64) };
      next();
    })
  );

  const ctx = (req) => req.b2b;

  // ── 거래처 ───────────────────────────────────────────────────────────────
  router.post(
    '/customers',
    asyncHandler(async (req, res) => {
      res.status(201).json({ data: await customers.createCustomer({ ...ctx(req), body: req.body }) });
    })
  );

  router.get(
    '/customers',
    asyncHandler(async (req, res) => {
      res.json(await customers.listCustomers({ ...ctx(req), query: req.query }));
    })
  );

  router.post(
    '/customers/:customerId/prices',
    asyncHandler(async (req, res) => {
      const customerId = v.parseId(req.params.customerId, 'customerId');
      res.status(201).json({ data: await customers.setPrice({ ...ctx(req), customerId, body: req.body }) });
    })
  );

  router.get(
    '/customers/:customerId/prices',
    asyncHandler(async (req, res) => {
      const customerId = v.parseId(req.params.customerId, 'customerId');
      res.json(await customers.listPrices({ ...ctx(req), customerId, query: req.query }));
    })
  );

  // ── 주문 ─────────────────────────────────────────────────────────────────
  /**
   * POST /orders
   * Headers: Idempotency-Key (선택, 권장)
   * Body: {
   *   customerId: 12,
   *   orderDate?: '2026-10-18',          // 기본: 오늘(Asia/Seoul)
   *   deliveryDueDate: '2026-10-20',
   *   deliveryAddress?: '...',           // 기본: 거래처 기본 배송지
   *   deliveryAddressDetail?: '...',
   *   memo?: '...',
   *   items: [{ productId: 3, quantity: 10 }, { productId: 7, quantity: '2.5' }]
   * }
   * 201: 신규 생성 / 200: 같은 Idempotency-Key 로 이미 생성된 주문
   */
  router.post(
    '/orders',
    asyncHandler(async (req, res) => {
      const result = await orders.createOrder({ ...ctx(req), body: req.body, idempotencyKey: v.parseIdempotencyKey(req) });
      if (result.created) res.location(`${req.baseUrl}/orders/${result.order.id}`);
      res.status(result.created ? 201 : 200).json({ data: result.order, created: result.created });
    })
  );

  router.get(
    '/orders/:orderId',
    asyncHandler(async (req, res) => {
      const orderId = v.parseId(req.params.orderId, 'orderId');
      res.json({ data: await orders.getOrder({ ...ctx(req), orderId }) });
    })
  );

  /**
   * PATCH /orders/:orderId/status
   * Body: { status: 'RECEIVED' | 'IN_PRODUCTION' | 'DELIVERED' | 'CANCELLED', reason?: '...' }
   * DELIVERED 응답에는 재고 차감 내역(inventory)과 갱신된 미수금(receivable)이 포함된다.
   */
  router.patch(
    '/orders/:orderId/status',
    asyncHandler(async (req, res) => {
      const orderId = v.parseId(req.params.orderId, 'orderId');
      const result = await orders.changeOrderStatus({ ...ctx(req), orderId, body: req.body });
      res.json({ data: result.order, changed: result.changed, inventory: result.inventory, receivable: result.receivable });
    })
  );

  // ── 미수금 ───────────────────────────────────────────────────────────────
  /**
   * GET /receivables?asOf=2026-10-18&search=&onlyOutstanding=true&overdueOnly=false
   *                  &sort=balance_desc|overdue_desc|name_asc|last_settled_asc&limit=50&offset=0
   */
  router.get(
    '/receivables',
    asyncHandler(async (req, res) => {
      res.json(await receivables.listReceivables({ ...ctx(req), query: req.query }));
    })
  );

  router.post(
    '/receivables/:customerId/payments',
    asyncHandler(async (req, res) => {
      const customerId = v.parseId(req.params.customerId, 'customerId');
      const result = await receivables.recordPayment({
        ...ctx(req),
        customerId,
        body: req.body,
        idempotencyKey: v.parseIdempotencyKey(req),
      });
      res.status(result.created ? 201 : 200).json({ data: result.payment, receivable: result.receivable, created: result.created });
    })
  );

  // 라우터 범위 404 / 에러 처리 (상위 앱의 에러 핸들러와 독립적으로 일관된 JSON 응답)
  router.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', `${req.method} ${req.originalUrl} 경로를 찾을 수 없습니다.`)));
  router.use(errorHandler(logger));

  return router;
}

module.exports = { createB2BRouter, defaultGetContext, DEFAULT_CONFIG };
