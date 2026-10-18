'use strict';
/**
 * 납품 주문 서비스
 *   - createOrder        : 주문 등록 + 거래처 단가 자동 매핑 + 금액 계산 + 여신 한도 검사
 *   - changeOrderStatus  : 상태 전이 검증 + (출고완료 시) 재고 차감 · 수불 기록 · 미수금 누적
 *   - getOrder           : 주문 단건 조회
 *
 * 모든 쓰기는 하나의 DB 트랜잭션 안에서 수행되며, 중간에 실패하면 전부 롤백된다.
 */
const { QueryTypes, UniqueConstraintError } = require('sequelize');
const { notFound, conflict, unprocessable } = require('../lib/errors');
const { withTransaction } = require('../lib/transaction');
const { parseQuantity, toWon, calcLineAmounts } = require('../lib/money');
const v = require('../lib/validate');
const { num, qty, serializeOrder } = require('../lib/serializers');
const { ORDER_STATUS, TAX_TYPE } = require('../models');
const { accrueReceivable } = require('./receivableService');

const { RECEIVED, IN_PRODUCTION, DELIVERED, CANCELLED } = ORDER_STATUS;

const STATUS_LABEL = Object.freeze({
  [RECEIVED]: '접수',
  [IN_PRODUCTION]: '생산중',
  [DELIVERED]: '출고완료',
  [CANCELLED]: '취소',
});

/**
 * 허용 상태 전이표.
 * - 재고가 이미 있는 품목은 생산 없이 바로 출고(RECEIVED → DELIVERED) 가능
 * - 출고완료/취소는 종결 상태. 출고 후 취소는 재고·미수금이 이미 반영되었으므로
 *   별도 반품(Return) 프로세스로 처리해야 한다.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [RECEIVED]: [IN_PRODUCTION, DELIVERED, CANCELLED],
  [IN_PRODUCTION]: [DELIVERED, CANCELLED],
  [DELIVERED]: [],
  [CANCELLED]: [],
});

const MOVEMENT_TYPE_B2B_DELIVERY = 'B2B_DELIVERY';
const REF_TYPE_B2B_ORDER = 'B2B_ORDER';

/** 주문 등록 요청 검증 → 정규화된 입력 */
function parseCreateOrderInput(body, { today, maxItems }) {
  v.requireBody(body);
  const customerId = v.parseId(body.customerId, 'customerId');
  const orderDate = v.parseDate(body.orderDate, 'orderDate', { defaultValue: today });
  const deliveryDueDate = v.parseDate(body.deliveryDueDate, 'deliveryDueDate', { required: true });
  if (deliveryDueDate < orderDate) {
    throw v.fail('deliveryDueDate', '출고 예정일은 주문일 이후여야 합니다.', deliveryDueDate);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw v.fail('items', '주문 품목이 1개 이상 있어야 합니다.');
  }
  if (body.items.length > maxItems) {
    throw v.fail('items', `한 주문에 최대 ${maxItems}개 품목까지 등록할 수 있습니다.`);
  }

  const seen = new Set();
  const items = body.items.map((item, i) => {
    const path = `items[${i}]`;
    if (!item || typeof item !== 'object') throw v.fail(path, '객체여야 합니다.');
    // 단가는 서버가 거래처 단가표에서 결정한다. 클라이언트가 보낸 단가는 받지 않는다(가격 조작 방지).
    if (item.unitPrice !== undefined) {
      throw unprocessable('UNIT_PRICE_NOT_ALLOWED', `${path}.unitPrice: 단가는 거래처 단가표에서 자동 적용되므로 보낼 수 없습니다.`, {
        field: `${path}.unitPrice`,
      });
    }
    const productId = v.parseId(item.productId, `${path}.productId`);
    if (seen.has(productId)) {
      throw unprocessable('DUPLICATE_ORDER_ITEM', `${path}.productId: 같은 품목이 중복되었습니다. 수량을 합쳐서 보내 주세요.`, {
        productId: Number(productId),
      });
    }
    seen.add(productId);
    return { productId, quantity: parseQuantity(item.quantity, `${path}.quantity`) };
  });

  const deliveryAddress = v.optionalString(body.deliveryAddress, 'deliveryAddress', 255);
  return {
    customerId,
    orderDate,
    deliveryDueDate,
    deliveryAddress,
    deliveryAddressDetail: v.optionalString(body.deliveryAddressDetail, 'deliveryAddressDetail', 255),
    memo: v.optionalString(body.memo, 'memo', 2000),
    items,
  };
}

function createOrderService({ sequelize, models, config }) {
  const { Product, B2BCustomer, B2BOrder, B2BOrderItem, B2BOrderStatusHistory, InventoryMovement } = models;

  /** 주문 + 상세 + 거래처명 조회 (행 잠금은 outer join 에 쓸 수 없으므로 잠금 없이 별도 조회) */
  async function loadOrder(tenantId, orderId, transaction) {
    return B2BOrder.findOne({
      where: { id: orderId, tenantId },
      include: [
        { model: B2BOrderItem, as: 'items' },
        { model: B2BCustomer, as: 'customer', attributes: ['id', 'name'] },
      ],
      transaction,
    });
  }

  async function getOrder({ tenantId, orderId }) {
    const order = await loadOrder(tenantId, orderId);
    if (!order) throw notFound('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.');
    return serializeOrder(order);
  }

  /** 같은 Idempotency-Key 로 이미 만들어진 주문 반환 (다른 거래처 주문이면 키 재사용 오류) */
  async function findByIdempotencyKey(tenantId, idempotencyKey, customerId, transaction) {
    const existing = await B2BOrder.findOne({ where: { tenantId, idempotencyKey }, attributes: ['id', 'customerId'], transaction });
    if (!existing) return null;
    if (String(existing.customerId) !== customerId) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '같은 Idempotency-Key 로 다른 주문이 이미 등록되어 있습니다.');
    }
    return { order: serializeOrder(await loadOrder(tenantId, existing.id, transaction)), created: false };
  }

  // ===========================================================================
  // [POST] /orders — 납품 주문 등록
  // ===========================================================================
  async function createOrder({ tenantId, userId, body, idempotencyKey }) {
    const input = parseCreateOrderInput(body, { today: v.todayInTimeZone(config.timeZone), maxItems: config.maxOrderItems });

    try {
      return await withTransaction(sequelize, async (transaction) => {
        // 1) 거래처 행 잠금: 같은 거래처의 동시 주문을 직렬화하여 여신 한도 검사가
        //    경쟁 조건 없이 정확하게 동작하도록 한다.
        const customer = await B2BCustomer.findOne({
          where: { id: input.customerId, tenantId },
          lock: transaction.LOCK.NO_KEY_UPDATE,
          transaction,
        });
        if (!customer) throw notFound('CUSTOMER_NOT_FOUND', '거래처를 찾을 수 없습니다.');

        // 잠금 이후에 멱등키를 확인해야 동시 재시도 요청도 안전하게 같은 주문을 받는다.
        if (idempotencyKey) {
          const existing = await findByIdempotencyKey(tenantId, idempotencyKey, input.customerId, transaction);
          if (existing) return existing;
        }

        if (!customer.isActive) throw unprocessable('CUSTOMER_INACTIVE', '거래가 중지된 거래처입니다.');

        // 배송지: 요청값 우선, 없으면 거래처 기본 배송지
        const useDefaultAddress = !input.deliveryAddress;
        const deliveryAddress = input.deliveryAddress || customer.defaultDeliveryAddress;
        const deliveryAddressDetail = useDefaultAddress ? customer.defaultDeliveryAddressDetail : input.deliveryAddressDetail;
        if (!deliveryAddress) {
          throw unprocessable('DELIVERY_ADDRESS_REQUIRED', '배송지가 없습니다. deliveryAddress 를 보내거나 거래처 기본 배송지를 등록해 주세요.');
        }

        // 2) 품목 마스터 확인
        const productIds = input.items.map((i) => i.productId);
        const products = await Product.findAll({ where: { tenantId, id: productIds }, transaction });
        const productById = new Map(products.map((p) => [String(p.id), p]));

        const missingProducts = productIds.filter((id) => !productById.has(id));
        if (missingProducts.length) {
          throw unprocessable('PRODUCT_NOT_FOUND', '존재하지 않는 품목이 포함되어 있습니다.', { productIds: missingProducts.map(Number) });
        }
        const inactiveProducts = products.filter((p) => !p.isActive);
        if (inactiveProducts.length) {
          throw unprocessable('PRODUCT_INACTIVE', '판매 중지된 품목이 포함되어 있습니다.', {
            products: inactiveProducts.map((p) => ({ productId: num(p.id), productName: p.name })),
          });
        }

        // 3) 거래처별 맞춤 단가 자동 매핑
        //    주문일 기준으로 유효한 단가 중 가장 최근 시작된 단가 1건 (DISTINCT ON)
        const priceRows = await sequelize.query(
          `SELECT DISTINCT ON (product_id) id, product_id, unit_price
             FROM b2b_product_prices
            WHERE tenant_id   = :tenantId
              AND customer_id = :customerId
              AND product_id IN (:productIds)
              AND is_active
              AND valid_from <= CAST(:orderDate AS date)
              AND (valid_to IS NULL OR valid_to >= CAST(:orderDate AS date))
            ORDER BY product_id, valid_from DESC, id DESC`,
          {
            replacements: { tenantId, customerId: input.customerId, productIds, orderDate: input.orderDate },
            type: QueryTypes.SELECT,
            transaction,
          }
        );
        const priceByProduct = new Map(priceRows.map((r) => [String(r.product_id), r]));

        const unpriced = productIds.filter((id) => !priceByProduct.has(id));
        if (unpriced.length) {
          throw unprocessable('PRICE_NOT_SET', '거래처 납품 단가가 등록되지 않은 품목이 있습니다.', {
            orderDate: input.orderDate,
            products: unpriced.map((id) => ({ productId: Number(id), productName: productById.get(id).name })),
          });
        }

        // 4) 라인별 공급가액/부가세 계산 (BigInt 정수 연산)
        let totalSupply = 0n;
        let totalVat = 0n;
        const lines = input.items.map((item, idx) => {
          const product = productById.get(item.productId);
          const price = priceByProduct.get(item.productId);
          if (!Object.values(TAX_TYPE).includes(product.taxType)) {
            throw unprocessable('INVALID_TAX_TYPE', `품목 '${product.name}'의 과세 유형이 올바르지 않습니다.`, {
              productId: num(product.id),
              taxType: product.taxType,
            });
          }
          const unitPrice = toWon(price.unit_price);
          const { supply, vat, total } = calcLineAmounts(item.quantity.milli, unitPrice, product.taxType);
          totalSupply += supply;
          totalVat += vat;
          return {
            lineNo: idx + 1,
            productId: item.productId,
            productPriceId: String(price.id),
            productName: product.name,
            unit: product.unit,
            taxType: product.taxType,
            quantity: item.quantity.text,
            unitPrice: unitPrice.toString(),
            supplyAmount: supply.toString(),
            vatAmount: vat.toString(),
            lineTotal: total.toString(),
          };
        });
        const totalAmount = totalSupply + totalVat;

        // 5) 여신(외상) 한도 검사: 현재 미수금 + 출고 전 주문액 + 이번 주문액 ≤ 한도
        if (customer.creditLimit !== null) {
          const [exposure] = await sequelize.query(
            `SELECT COALESCE((SELECT balance FROM accounts_receivable WHERE customer_id = :customerId), 0) AS balance,
                    COALESCE((SELECT SUM(total_amount) FROM b2b_orders
                               WHERE customer_id = :customerId AND status IN ('RECEIVED', 'IN_PRODUCTION')), 0) AS pending`,
            { replacements: { customerId: input.customerId }, type: QueryTypes.SELECT, transaction }
          );
          const creditLimit = toWon(customer.creditLimit);
          const balance = toWon(exposure.balance);
          const pending = toWon(exposure.pending);
          const projected = balance + pending + totalAmount;
          if (projected > creditLimit) {
            throw conflict('CREDIT_LIMIT_EXCEEDED', '거래처 여신 한도를 초과하여 주문을 등록할 수 없습니다.', {
              creditLimit: num(creditLimit),
              currentBalance: num(balance),
              pendingOrderAmount: num(pending),
              orderAmount: num(totalAmount),
              exceededBy: num(projected - creditLimit),
            });
          }
        }

        // 6) 주문번호 채번 (시퀀스 → 동시성 안전, 롤백 시 번호 공백은 허용)
        const [{ seq }] = await sequelize.query(`SELECT nextval('b2b_order_no_seq') AS seq`, { type: QueryTypes.SELECT, transaction });
        const orderNo = `B2B-${input.orderDate.replace(/-/g, '')}-${String(seq).padStart(6, '0')}`;

        // 7) 저장
        const order = await B2BOrder.create(
          {
            tenantId,
            orderNo,
            customerId: input.customerId,
            orderDate: input.orderDate,
            deliveryDueDate: input.deliveryDueDate,
            status: RECEIVED,
            deliveryAddress,
            deliveryAddressDetail,
            totalSupplyAmount: totalSupply.toString(),
            totalVatAmount: totalVat.toString(),
            totalAmount: totalAmount.toString(),
            idempotencyKey,
            memo: input.memo,
            createdBy: userId,
          },
          { transaction }
        );
        await B2BOrderItem.bulkCreate(
          lines.map((l) => ({ ...l, orderId: order.id })),
          { transaction }
        );
        await B2BOrderStatusHistory.create({ orderId: order.id, fromStatus: null, toStatus: RECEIVED, changedBy: userId }, { transaction });

        return { order: serializeOrder(await loadOrder(tenantId, order.id, transaction)), created: true };
      });
    } catch (err) {
      // 다른 거래처로 같은 키가 동시에 들어오는 등 잠금으로 직렬화되지 않은 경합의 최종 방어선
      if (idempotencyKey && err instanceof UniqueConstraintError && err.parent?.constraint === 'uq_b2b_orders_idempotency') {
        const existing = await findByIdempotencyKey(tenantId, idempotencyKey, input.customerId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * 출고 시 재고 차감 (반드시 상위 트랜잭션 안에서 호출).
   *
   * 1. 품목별 필요 수량 합산
   * 2. 재고 행을 product_id 오름차순으로 SELECT ... FOR NO KEY UPDATE
   *    → 여러 주문이 동시에 출고돼도 항상 같은 순서로 잠그므로 교착(deadlock)이 생기지 않는다.
   *    (이 모듈의 행 잠금은 모두 NO KEY UPDATE: 쓰기끼리는 직렬화하되, 다른 테이블이 이 행을
   *     FK 로 참조하며 INSERT 할 때 거는 KEY SHARE 잠금과는 충돌하지 않게 한다.)
   * 3. UPDATE ... WHERE quantity >= 필요수량 (조건부 차감, 음수 재고 원천 차단)
   * 4. 하나라도 부족하면 부족 내역 전체를 모아 409 → 트랜잭션 전체 롤백
   * 5. 수불 이력(inventory_movements) 기록. UNIQUE 제약으로 이중 차감 재차 방지.
   */
  async function deductInventoryForOrder({ tenantId, order, items, userId, transaction }) {
    const required = new Map();
    for (const item of items) {
      const key = String(item.productId);
      const { milli } = parseQuantity(String(item.quantity));
      const prev = required.get(key);
      required.set(key, { milli: (prev?.milli ?? 0n) + milli, productName: item.productName, unit: item.unit });
    }
    const productIds = [...required.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    const milliToText = (m) => `${m / 1000n}.${String(m % 1000n).padStart(3, '0')}`;

    const locked = await sequelize.query(
      `SELECT id, product_id, quantity
         FROM inventories
        WHERE tenant_id = :tenantId AND product_id IN (:productIds)
        ORDER BY product_id
        FOR NO KEY UPDATE`,
      { replacements: { tenantId, productIds }, type: QueryTypes.SELECT, transaction }
    );
    const inventoryByProduct = new Map(locked.map((r) => [String(r.product_id), r]));

    const shortages = [];
    const changes = [];
    for (const productId of productIds) {
      const need = required.get(productId);
      const needText = milliToText(need.milli);
      const inventory = inventoryByProduct.get(productId);
      if (!inventory) {
        shortages.push({ productId: Number(productId), productName: need.productName, unit: need.unit, required: qty(needText), available: 0 });
        continue;
      }
      const [updated] = await sequelize.query(
        `UPDATE inventories
            SET quantity = quantity - CAST(:quantity AS numeric), updated_at = now()
          WHERE id = :id AND quantity >= CAST(:quantity AS numeric)
        RETURNING quantity`,
        { replacements: { id: inventory.id, quantity: needText }, transaction }
      );
      if (updated.length === 0) {
        shortages.push({
          productId: Number(productId),
          productName: need.productName,
          unit: need.unit,
          required: qty(needText),
          available: qty(inventory.quantity),
        });
        continue;
      }
      changes.push({
        inventoryId: inventory.id,
        productId,
        productName: need.productName,
        unit: need.unit,
        quantityChange: `-${needText}`,
        quantityBefore: inventory.quantity,
        quantityAfter: updated[0].quantity,
      });
    }

    if (shortages.length) {
      throw conflict('INSUFFICIENT_STOCK', '재고가 부족하여 출고할 수 없습니다.', { shortages });
    }

    await InventoryMovement.bulkCreate(
      changes.map((c) => ({
        tenantId,
        inventoryId: c.inventoryId,
        productId: c.productId,
        movementType: MOVEMENT_TYPE_B2B_DELIVERY,
        quantityChange: c.quantityChange,
        quantityAfter: c.quantityAfter,
        refType: REF_TYPE_B2B_ORDER,
        refId: order.id,
        createdBy: userId,
      })),
      { transaction }
    );

    return changes.map((c) => ({
      productId: Number(c.productId),
      productName: c.productName,
      unit: c.unit,
      quantityBefore: qty(c.quantityBefore),
      quantityChange: qty(c.quantityChange),
      quantityAfter: qty(c.quantityAfter),
    }));
  }

  // ===========================================================================
  // [PATCH] /orders/:id/status — 주문 상태 변경
  // ===========================================================================
  async function changeOrderStatus({ tenantId, userId, orderId, body }) {
    v.requireBody(body);
    const toStatus = v.parseEnum(body.status, 'status', Object.values(ORDER_STATUS));
    const reason = v.optionalString(body.reason, 'reason', 1000);
    if (toStatus === CANCELLED && !reason) throw v.fail('reason', '주문 취소 시 사유는 필수입니다.');

    return withTransaction(sequelize, async (transaction) => {
      // 주문 행 잠금: 동시에 들어온 "출고완료" 요청 중 하나만 통과시켜 재고 이중 차감을 막는다.
      const order = await B2BOrder.findOne({ where: { id: orderId, tenantId }, lock: transaction.LOCK.NO_KEY_UPDATE, transaction });
      if (!order) throw notFound('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.');

      const fromStatus = order.status;

      // 이미 목표 상태면 아무 것도 하지 않음 (네트워크 재시도에 대해 멱등)
      if (fromStatus === toStatus) {
        return { order: serializeOrder(await loadOrder(tenantId, order.id, transaction)), changed: false, inventory: [], receivable: null };
      }

      if (!ALLOWED_TRANSITIONS[fromStatus]?.includes(toStatus)) {
        throw conflict(
          'INVALID_STATUS_TRANSITION',
          `'${STATUS_LABEL[fromStatus] ?? fromStatus}' 상태의 주문은 '${STATUS_LABEL[toStatus]}'(으)로 변경할 수 없습니다.`,
          { fromStatus, toStatus, allowed: ALLOWED_TRANSITIONS[fromStatus] ?? [] }
        );
      }

      const now = new Date();
      const patch = { status: toStatus };
      let inventory = [];
      let receivable = null;

      if (toStatus === IN_PRODUCTION) {
        patch.productionStartedAt = now;
      } else if (toStatus === DELIVERED) {
        // ── 출고완료: 재고 차감 + 수불 기록 + 미수금 누적을 한 트랜잭션으로 ──
        const items = await B2BOrderItem.findAll({ where: { orderId: order.id }, order: [['lineNo', 'ASC']], transaction });
        inventory = await deductInventoryForOrder({ tenantId, order, items, userId, transaction });
        receivable = await accrueReceivable(sequelize, {
          tenantId,
          customerId: order.customerId,
          amount: order.totalAmount,
          deliveredAt: now,
          transaction,
        });
        patch.deliveredAt = now;
      } else if (toStatus === CANCELLED) {
        patch.cancelledAt = now;
        patch.cancelReason = reason;
      }

      await order.update(patch, { transaction });
      await B2BOrderStatusHistory.create(
        { orderId: order.id, fromStatus, toStatus, reason, changedBy: userId, changedAt: now },
        { transaction }
      );

      return { order: serializeOrder(await loadOrder(tenantId, order.id, transaction)), changed: true, inventory, receivable };
    });
  }

  return { createOrder, changeOrderStatus, getOrder };
}

module.exports = { createOrderService, ALLOWED_TRANSITIONS, STATUS_LABEL, parseCreateOrderInput };
