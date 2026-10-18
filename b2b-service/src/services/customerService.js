'use strict';
/**
 * 거래처 / 거래처별 맞춤 단가 관리.
 * 주문 등록 시 자동 단가 매핑의 기준 데이터를 만드는 서비스.
 */
const { Op } = require('sequelize');
const { notFound, unprocessable } = require('../lib/errors');
const { withTransaction } = require('../lib/transaction');
const v = require('../lib/validate');
const { serializeCustomer, serializePrice } = require('../lib/serializers');

/**
 * 사업자등록번호 체크섬 검증 (국세청 공식 알고리즘)
 * 가중치 1,3,7,1,3,7,1,3,5 → 합계 + floor(9번째 자리 × 5 / 10) → 10 - (합 % 10) 의 끝자리 = 검증번호
 */
function isValidBusinessNo(digits) {
  if (!/^\d{10}$/.test(digits)) return false;
  const d = digits.split('').map(Number);
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = weights.reduce((acc, w, i) => acc + d[i] * w, 0);
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}

function parseBusinessNo(value) {
  const raw = v.requiredString(value, 'businessNo', 20);
  const digits = raw.replace(/-/g, '');
  if (!isValidBusinessNo(digits)) {
    throw unprocessable('INVALID_BUSINESS_NO', '유효하지 않은 사업자등록번호입니다.', { field: 'businessNo', value });
  }
  return digits;
}

function createCustomerService({ sequelize, models, config }) {
  const { B2BCustomer, B2BProductPrice, Product } = models;

  async function createCustomer({ tenantId, body }) {
    v.requireBody(body);
    const email = v.optionalString(body.contactEmail, 'contactEmail', 255);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw v.fail('contactEmail', '이메일 형식이 아닙니다.');

    const customer = await B2BCustomer.create({
      tenantId,
      name: v.requiredString(body.name, 'name', 100),
      businessNo: parseBusinessNo(body.businessNo),
      representativeName: v.optionalString(body.representativeName, 'representativeName', 50),
      contactName: v.optionalString(body.contactName, 'contactName', 50),
      contactPhone: v.optionalString(body.contactPhone, 'contactPhone', 20),
      contactEmail: email,
      defaultDeliveryAddress: v.optionalString(body.defaultDeliveryAddress, 'defaultDeliveryAddress', 255),
      defaultDeliveryAddressDetail: v.optionalString(body.defaultDeliveryAddressDetail, 'defaultDeliveryAddressDetail', 255),
      defaultDeliveryZipcode: v.optionalString(body.defaultDeliveryZipcode, 'defaultDeliveryZipcode', 10),
      paymentTermsDays: v.parseIntInRange(body.paymentTermsDays, 'paymentTermsDays', { min: 0, max: 365, defaultValue: 30 }),
      creditLimit: v.parseWon(body.creditLimit, 'creditLimit', { required: false, allowNull: true }) ?? null,
      memo: v.optionalString(body.memo, 'memo', 2000),
    });
    // 사업자번호 중복(uq_b2b_customers_business_no)은 errorHandler 에서 409 로 변환된다.
    return serializeCustomer(customer);
  }

  async function listCustomers({ tenantId, query }) {
    const search = v.optionalString(query.search, 'search', 100);
    const limit = v.parseIntInRange(query.limit, 'limit', { min: 1, max: 200, defaultValue: 50 });
    const offset = v.parseIntInRange(query.offset, 'offset', { min: 0, max: 1_000_000, defaultValue: 0 });
    const where = { tenantId };
    if (search) {
      const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
      where[Op.or] = [{ name: { [Op.iLike]: `%${escaped}%` } }, { businessNo: { [Op.like]: `%${escaped.replace(/-/g, '')}%` } }];
    }
    const { rows, count } = await B2BCustomer.findAndCountAll({ where, order: [['name', 'ASC'], ['id', 'ASC']], limit, offset });
    return { items: rows.map(serializeCustomer), pagination: { limit, offset, total: count } };
  }

  /**
   * 거래처 단가 등록/변경.
   * validFrom 부터 새 단가를 적용한다. 현재 적용 중인(종료일 없는) 단가가 있으면
   * 그 단가의 종료일을 validFrom 하루 전으로 자동 마감하여 단가 이력을 보존한다.
   * 이미 발행된 주문은 주문 시점 단가가 스냅샷되어 있으므로 영향을 받지 않는다.
   */
  async function setPrice({ tenantId, customerId, body }) {
    v.requireBody(body);
    const productId = v.parseId(body.productId, 'productId');
    const unitPrice = v.parseWon(body.unitPrice, 'unitPrice', { min: 0 });
    const validFrom = v.parseDate(body.validFrom, 'validFrom', { defaultValue: v.todayInTimeZone(config.timeZone) });
    const validTo = v.parseDate(body.validTo, 'validTo');
    const memo = v.optionalString(body.memo, 'memo', 1000);
    if (validTo && validTo < validFrom) throw v.fail('validTo', 'validFrom 이후 날짜여야 합니다.');

    return withTransaction(sequelize, async (transaction) => {
      const customer = await B2BCustomer.findOne({ where: { id: customerId, tenantId }, lock: transaction.LOCK.NO_KEY_UPDATE, transaction });
      if (!customer) throw notFound('CUSTOMER_NOT_FOUND', '거래처를 찾을 수 없습니다.');
      const product = await Product.findOne({ where: { id: productId, tenantId }, transaction });
      if (!product) throw notFound('PRODUCT_NOT_FOUND', '품목을 찾을 수 없습니다.');

      const current = await B2BProductPrice.findAll({
        where: { tenantId, customerId, productId, isActive: true },
        order: [['validFrom', 'ASC']],
        lock: transaction.LOCK.NO_KEY_UPDATE,
        transaction,
      });

      // 같은 시작일 단가가 이미 있으면 해당 행을 수정
      const sameStart = current.find((p) => p.validFrom === validFrom);
      let price;
      if (sameStart) {
        price = await sameStart.update(
          { unitPrice, ...(body.validTo !== undefined ? { validTo } : {}), ...(memo !== null ? { memo } : {}) },
          { transaction }
        );
      } else {
        // validFrom 시점을 덮고 있는 기존 단가를 전날까지로 마감
        const covering = current.find((p) => p.validFrom < validFrom && (p.validTo === null || p.validTo >= validFrom));
        if (covering) await covering.update({ validTo: v.addDays(validFrom, -1) }, { transaction });
        // 이후 기간에 예약된 단가와 겹치면 EXCLUDE 제약(23P01) → 409 PERIOD_OVERLAP
        price = await B2BProductPrice.create(
          { tenantId, customerId, productId, unitPrice, validFrom, validTo, memo },
          { transaction }
        );
      }
      price.product = product;
      return serializePrice(price);
    });
  }

  async function listPrices({ tenantId, customerId, query }) {
    const asOf = v.parseDate(query.asOf, 'asOf', { defaultValue: v.todayInTimeZone(config.timeZone) });
    const customer = await B2BCustomer.findOne({ where: { id: customerId, tenantId }, attributes: ['id'] });
    if (!customer) throw notFound('CUSTOMER_NOT_FOUND', '거래처를 찾을 수 없습니다.');
    const prices = await B2BProductPrice.findAll({
      where: {
        tenantId,
        customerId,
        isActive: true,
        validFrom: { [Op.lte]: asOf },
        [Op.or]: [{ validTo: null }, { validTo: { [Op.gte]: asOf } }],
      },
      include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'unit', 'taxType'] }],
      order: [['productId', 'ASC']],
    });
    return { asOf, items: prices.map(serializePrice) };
  }

  return { createCustomer, listCustomers, setPrice, listPrices };
}

module.exports = { createCustomerService, isValidBusinessNo };
