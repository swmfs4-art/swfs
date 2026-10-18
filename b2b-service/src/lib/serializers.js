'use strict';
/**
 * DB 행 → API 응답(JSON) 변환.
 * pg 는 BIGINT/NUMERIC 을 문자열로 주므로 여기서 Number 로 바꾼다.
 *   - 금액(원): Number.MAX_SAFE_INTEGER(약 9천조) 이내 검증 후 변환
 *   - 수량: NUMERIC(12,3) → 유효숫자 12자리라 double 로 정확히 표현됨
 */
const { toSafeNumber } = require('./money');

const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);
const num = (v) => (v === null || v === undefined ? null : toSafeNumber(v));
const qty = (v) => (v === null || v === undefined ? null : Number(v));

function serializeOrderItem(row) {
  const r = plain(row);
  return {
    id: num(r.id),
    lineNo: r.lineNo,
    productId: num(r.productId),
    productPriceId: num(r.productPriceId),
    productName: r.productName,
    unit: r.unit,
    taxType: r.taxType,
    quantity: qty(r.quantity),
    unitPrice: num(r.unitPrice),
    supplyAmount: num(r.supplyAmount),
    vatAmount: num(r.vatAmount),
    lineTotal: num(r.lineTotal),
  };
}

function serializeOrder(row) {
  const r = plain(row);
  return {
    id: num(r.id),
    orderNo: r.orderNo,
    customerId: num(r.customerId),
    ...(r.customer ? { customer: { id: num(r.customer.id), name: r.customer.name } } : {}),
    orderDate: r.orderDate,
    deliveryDueDate: r.deliveryDueDate,
    status: r.status,
    deliveryAddress: r.deliveryAddress,
    deliveryAddressDetail: r.deliveryAddressDetail,
    totalSupplyAmount: num(r.totalSupplyAmount),
    totalVatAmount: num(r.totalVatAmount),
    totalAmount: num(r.totalAmount),
    memo: r.memo,
    productionStartedAt: r.productionStartedAt,
    deliveredAt: r.deliveredAt,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.items ? { items: [...r.items].sort((a, b) => a.lineNo - b.lineNo).map(serializeOrderItem) } : {}),
  };
}

function serializeCustomer(row) {
  const r = plain(row);
  return {
    id: num(r.id),
    name: r.name,
    businessNo: r.businessNo,
    representativeName: r.representativeName,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactEmail: r.contactEmail,
    defaultDeliveryAddress: r.defaultDeliveryAddress,
    defaultDeliveryAddressDetail: r.defaultDeliveryAddressDetail,
    defaultDeliveryZipcode: r.defaultDeliveryZipcode,
    paymentTermsDays: r.paymentTermsDays,
    creditLimit: num(r.creditLimit),
    isActive: r.isActive,
    memo: r.memo,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function serializePrice(row) {
  const r = plain(row);
  return {
    id: num(r.id),
    customerId: num(r.customerId),
    productId: num(r.productId),
    ...(r.product ? { productName: r.product.name, unit: r.product.unit, taxType: r.product.taxType } : {}),
    unitPrice: num(r.unitPrice),
    validFrom: r.validFrom,
    validTo: r.validTo,
    isActive: r.isActive,
    memo: r.memo,
  };
}

function serializeReceivable(r) {
  return {
    customerId: num(r.customer_id ?? r.customerId),
    totalOrderAmount: num(r.total_order_amount ?? r.totalOrderAmount),
    totalPaidAmount: num(r.total_paid_amount ?? r.totalPaidAmount),
    balance: num(r.balance),
    lastDeliveredAt: r.last_delivered_at ?? r.lastDeliveredAt ?? null,
    lastSettledDate: r.last_settled_date ?? r.lastSettledDate ?? null,
  };
}

function serializePayment(row) {
  const r = plain(row);
  return {
    id: num(r.id),
    customerId: num(r.customerId),
    amount: num(r.amount),
    paidDate: r.paidDate,
    method: r.method,
    reference: r.reference,
    memo: r.memo,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

module.exports = {
  num,
  qty,
  serializeOrder,
  serializeOrderItem,
  serializeCustomer,
  serializePrice,
  serializeReceivable,
  serializePayment,
};
