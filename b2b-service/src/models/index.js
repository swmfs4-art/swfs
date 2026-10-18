'use strict';
/**
 * Sequelize 모델 정의 + 연관관계.
 *
 * 스키마의 원본(Source of Truth)은 migrations/*.sql 이다. 여기의 모델은 애플리케이션이
 * 읽고 쓰기 위한 매핑이며, sequelize.sync() 로 테이블을 만들지 않는다
 * (EXCLUDE 제약, GENERATED 컬럼, 부분 인덱스 등은 SQL 로만 표현 가능).
 *
 * Product / Inventory 는 ATC-F&B 에 이미 있는 테이블이다. 컬럼명이 다르면
 * 각 attribute 의 `field` 만 바꿔서 매핑한다.
 */
const { DataTypes } = require('sequelize');

const ORDER_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED', // 접수
  IN_PRODUCTION: 'IN_PRODUCTION', // 생산중
  DELIVERED: 'DELIVERED', // 출고완료
  CANCELLED: 'CANCELLED', // 취소
});

const TAX_TYPE = Object.freeze({ TAXABLE: 'TAXABLE', EXEMPT: 'EXEMPT' });

const PAYMENT_METHODS = Object.freeze(['BANK_TRANSFER', 'CASH', 'CARD', 'OFFSET', 'OTHER']);

const id = () => ({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true });
const tenantId = () => ({ type: DataTypes.BIGINT, allowNull: false });
const money = (extra = {}) => ({ type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, ...extra });

function initModels(sequelize) {
  // ---------------------------------------------------------------------------
  // 기존 테이블: 품목 마스터
  // ---------------------------------------------------------------------------
  const Product = sequelize.define(
    'Product',
    {
      id: id(),
      tenantId: tenantId(),
      sku: { type: DataTypes.STRING(50) },
      name: { type: DataTypes.STRING(200), allowNull: false },
      unit: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'EA' },
      productType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'FINISHED' },
      taxType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: TAX_TYPE.TAXABLE },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'products' }
  );

  // ---------------------------------------------------------------------------
  // 기존 테이블: 재고 (원재료/완제품 공용, tenant+product 당 1행)
  // ---------------------------------------------------------------------------
  const Inventory = sequelize.define(
    'Inventory',
    {
      id: id(),
      tenantId: tenantId(),
      productId: { type: DataTypes.BIGINT, allowNull: false },
      quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: '0' },
    },
    { tableName: 'inventories', createdAt: false }
  );

  // ---------------------------------------------------------------------------
  // 1. 거래처
  // ---------------------------------------------------------------------------
  const B2BCustomer = sequelize.define(
    'B2BCustomer',
    {
      id: id(),
      tenantId: tenantId(),
      name: { type: DataTypes.STRING(100), allowNull: false, validate: { notEmpty: true } },
      businessNo: { type: DataTypes.CHAR(10), allowNull: false, validate: { is: /^[0-9]{10}$/ } },
      representativeName: { type: DataTypes.STRING(50) },
      contactName: { type: DataTypes.STRING(50) },
      contactPhone: { type: DataTypes.STRING(20) },
      contactEmail: { type: DataTypes.STRING(255), validate: { isEmail: true } },
      defaultDeliveryAddress: { type: DataTypes.STRING(255) },
      defaultDeliveryAddressDetail: { type: DataTypes.STRING(255) },
      defaultDeliveryZipcode: { type: DataTypes.STRING(10) },
      paymentTermsDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
      creditLimit: { type: DataTypes.BIGINT },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      memo: { type: DataTypes.TEXT },
    },
    { tableName: 'b2b_customers' }
  );

  // ---------------------------------------------------------------------------
  // 2. 거래처별 맞춤 단가
  // ---------------------------------------------------------------------------
  const B2BProductPrice = sequelize.define(
    'B2BProductPrice',
    {
      id: id(),
      tenantId: tenantId(),
      customerId: { type: DataTypes.BIGINT, allowNull: false },
      productId: { type: DataTypes.BIGINT, allowNull: false },
      unitPrice: { type: DataTypes.BIGINT, allowNull: false },
      validFrom: { type: DataTypes.DATEONLY, allowNull: false },
      validTo: { type: DataTypes.DATEONLY },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      memo: { type: DataTypes.TEXT },
    },
    { tableName: 'b2b_product_prices' }
  );

  // ---------------------------------------------------------------------------
  // 3. 납품 주문 / 예약
  // ---------------------------------------------------------------------------
  const B2BOrder = sequelize.define(
    'B2BOrder',
    {
      id: id(),
      tenantId: tenantId(),
      orderNo: { type: DataTypes.STRING(30), allowNull: false },
      customerId: { type: DataTypes.BIGINT, allowNull: false },
      orderDate: { type: DataTypes.DATEONLY, allowNull: false },
      deliveryDueDate: { type: DataTypes.DATEONLY, allowNull: false },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: ORDER_STATUS.RECEIVED,
        validate: { isIn: [Object.values(ORDER_STATUS)] },
      },
      deliveryAddress: { type: DataTypes.STRING(255), allowNull: false },
      deliveryAddressDetail: { type: DataTypes.STRING(255) },
      totalSupplyAmount: money(),
      totalVatAmount: money(),
      totalAmount: money(),
      idempotencyKey: { type: DataTypes.STRING(100) },
      memo: { type: DataTypes.TEXT },
      productionStartedAt: { type: DataTypes.DATE },
      deliveredAt: { type: DataTypes.DATE },
      cancelledAt: { type: DataTypes.DATE },
      cancelReason: { type: DataTypes.TEXT },
      createdBy: { type: DataTypes.STRING(64) },
    },
    { tableName: 'b2b_orders' }
  );

  // ---------------------------------------------------------------------------
  // 4. 주문 상세
  // ---------------------------------------------------------------------------
  const B2BOrderItem = sequelize.define(
    'B2BOrderItem',
    {
      id: id(),
      orderId: { type: DataTypes.BIGINT, allowNull: false },
      lineNo: { type: DataTypes.SMALLINT, allowNull: false },
      productId: { type: DataTypes.BIGINT, allowNull: false },
      productPriceId: { type: DataTypes.BIGINT },
      productName: { type: DataTypes.STRING(200), allowNull: false },
      unit: { type: DataTypes.STRING(20), allowNull: false },
      taxType: { type: DataTypes.STRING(10), allowNull: false },
      quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
      unitPrice: money(),
      supplyAmount: money(),
      vatAmount: money(),
      lineTotal: money(),
    },
    { tableName: 'b2b_order_items', updatedAt: false }
  );

  const B2BOrderStatusHistory = sequelize.define(
    'B2BOrderStatusHistory',
    {
      id: id(),
      orderId: { type: DataTypes.BIGINT, allowNull: false },
      fromStatus: { type: DataTypes.STRING(20) },
      toStatus: { type: DataTypes.STRING(20), allowNull: false },
      reason: { type: DataTypes.TEXT },
      changedBy: { type: DataTypes.STRING(64) },
      changedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: 'b2b_order_status_history', timestamps: false }
  );

  // ---------------------------------------------------------------------------
  // 5. 미수금 원장 (거래처당 1행). balance 는 DB GENERATED 컬럼 → 읽기 전용.
  //    쓰기는 services 의 원자적 UPSERT(raw SQL)로만 수행한다.
  // ---------------------------------------------------------------------------
  const AccountsReceivable = sequelize.define(
    'AccountsReceivable',
    {
      id: id(),
      tenantId: tenantId(),
      customerId: { type: DataTypes.BIGINT, allowNull: false, unique: true },
      totalOrderAmount: money(),
      totalPaidAmount: money(),
      balance: { type: DataTypes.BIGINT }, // GENERATED ALWAYS (total_order_amount - total_paid_amount)
      lastDeliveredAt: { type: DataTypes.DATE },
      lastSettledDate: { type: DataTypes.DATEONLY },
    },
    { tableName: 'accounts_receivable' }
  );

  const B2BPayment = sequelize.define(
    'B2BPayment',
    {
      id: id(),
      tenantId: tenantId(),
      customerId: { type: DataTypes.BIGINT, allowNull: false },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      paidDate: { type: DataTypes.DATEONLY, allowNull: false },
      method: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [PAYMENT_METHODS] } },
      reference: { type: DataTypes.STRING(100) },
      memo: { type: DataTypes.TEXT },
      idempotencyKey: { type: DataTypes.STRING(100) },
      createdBy: { type: DataTypes.STRING(64) },
    },
    { tableName: 'b2b_payments', updatedAt: false }
  );

  const InventoryMovement = sequelize.define(
    'InventoryMovement',
    {
      id: id(),
      tenantId: tenantId(),
      inventoryId: { type: DataTypes.BIGINT, allowNull: false },
      productId: { type: DataTypes.BIGINT, allowNull: false },
      movementType: { type: DataTypes.STRING(30), allowNull: false },
      quantityChange: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      quantityAfter: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
      refType: { type: DataTypes.STRING(30), allowNull: false },
      refId: { type: DataTypes.BIGINT, allowNull: false },
      createdBy: { type: DataTypes.STRING(64) },
    },
    { tableName: 'inventory_movements', updatedAt: false }
  );

  // ---------------------------------------------------------------------------
  // 연관관계
  // ---------------------------------------------------------------------------
  B2BCustomer.hasMany(B2BProductPrice, { foreignKey: 'customerId', as: 'prices' });
  B2BProductPrice.belongsTo(B2BCustomer, { foreignKey: 'customerId', as: 'customer' });
  B2BProductPrice.belongsTo(Product, { foreignKey: 'productId', as: 'product' });

  B2BCustomer.hasMany(B2BOrder, { foreignKey: 'customerId', as: 'orders' });
  B2BOrder.belongsTo(B2BCustomer, { foreignKey: 'customerId', as: 'customer' });

  B2BOrder.hasMany(B2BOrderItem, { foreignKey: 'orderId', as: 'items' });
  B2BOrderItem.belongsTo(B2BOrder, { foreignKey: 'orderId', as: 'order' });
  B2BOrderItem.belongsTo(Product, { foreignKey: 'productId', as: 'product' });

  B2BOrder.hasMany(B2BOrderStatusHistory, { foreignKey: 'orderId', as: 'statusHistory' });

  B2BCustomer.hasOne(AccountsReceivable, { foreignKey: 'customerId', as: 'receivable' });
  AccountsReceivable.belongsTo(B2BCustomer, { foreignKey: 'customerId', as: 'customer' });

  B2BCustomer.hasMany(B2BPayment, { foreignKey: 'customerId', as: 'payments' });

  Product.hasOne(Inventory, { foreignKey: 'productId', as: 'inventory' });
  Inventory.belongsTo(Product, { foreignKey: 'productId', as: 'product' });

  return {
    Product,
    Inventory,
    B2BCustomer,
    B2BProductPrice,
    B2BOrder,
    B2BOrderItem,
    B2BOrderStatusHistory,
    AccountsReceivable,
    B2BPayment,
    InventoryMovement,
  };
}

module.exports = { initModels, ORDER_STATUS, TAX_TYPE, PAYMENT_METHODS };
