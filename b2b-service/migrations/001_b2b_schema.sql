-- =============================================================================
-- 001. 납품/B2B 스키마
-- -----------------------------------------------------------------------------
-- 금액 규칙
--   * 모든 금액은 원(KRW) 단위 정수 BIGINT. 부동소수 오차를 원천 차단한다.
--   * 수량은 NUMERIC(12,3) (kg 등 소수 셋째 자리까지).
--   * 공급가액 = round(수량 × 단가), 부가세 = floor(공급가액 × 10%) (원 미만 절사),
--     면세 품목은 부가세 0. 계산은 애플리케이션(src/lib/money.js)에서 수행하고
--     DB CHECK 제약으로 합계 정합성을 한 번 더 검증한다.
--
-- 멀티테넌시
--   * 모든 루트 테이블에 tenant_id(가맹 본사/사업자 단위)를 두고, 모든 쿼리는
--     tenant_id 조건을 포함한다.
-- =============================================================================

-- 거래처별 단가 기간 중복을 DB 레벨에서 막기 위한 EXCLUDE 제약에 필요.
-- (AWS RDS / Cloud SQL / Supabase 모두 btree_gist 지원)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- 1. B2B_Customers : 거래처
-- -----------------------------------------------------------------------------
CREATE TABLE b2b_customers (
  id                               BIGSERIAL PRIMARY KEY,
  tenant_id                        BIGINT       NOT NULL,
  name                             VARCHAR(100) NOT NULL,                 -- 거래처명(상호)
  business_no                      CHAR(10)     NOT NULL,                 -- 사업자등록번호 (숫자 10자리, 하이픈 제거)
  representative_name              VARCHAR(50),                           -- 대표자명
  contact_name                     VARCHAR(50),                           -- 담당자명
  contact_phone                    VARCHAR(20),                           -- 담당자 연락처
  contact_email                    VARCHAR(255),                          -- 세금계산서 수신 메일
  default_delivery_address         VARCHAR(255),                          -- 기본 납품 배송지
  default_delivery_address_detail  VARCHAR(255),
  default_delivery_zipcode         VARCHAR(10),
  payment_terms_days               INTEGER      NOT NULL DEFAULT 30,      -- 결제 조건: 출고일 + N일 이내 입금
  credit_limit                     BIGINT,                                -- 여신(외상) 한도. NULL = 무제한
  is_active                        BOOLEAN      NOT NULL DEFAULT TRUE,
  memo                             TEXT,
  created_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_b2b_customers_business_no UNIQUE (tenant_id, business_no),
  CONSTRAINT ck_b2b_customers_business_no CHECK (business_no ~ '^[0-9]{10}$'),
  CONSTRAINT ck_b2b_customers_terms       CHECK (payment_terms_days BETWEEN 0 AND 365),
  CONSTRAINT ck_b2b_customers_credit      CHECK (credit_limit IS NULL OR credit_limit >= 0)
);

CREATE INDEX idx_b2b_customers_tenant_name ON b2b_customers (tenant_id, name);

-- -----------------------------------------------------------------------------
-- 2. B2B_Product_Prices : 거래처별 맞춤 단가 (품목 마스터와 N:1)
--    같은 제품이라도 거래처마다 다른 단가를 두고, 적용 기간(valid_from ~ valid_to)
--    으로 단가 이력을 관리한다. 활성 단가끼리 기간이 겹치지 않도록 EXCLUDE 제약.
-- -----------------------------------------------------------------------------
CREATE TABLE b2b_product_prices (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT      NOT NULL,
  customer_id  BIGINT      NOT NULL REFERENCES b2b_customers (id) ON DELETE CASCADE,
  product_id   BIGINT      NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  unit_price   BIGINT      NOT NULL,                     -- 납품 단가(공급가, VAT 별도, 원)
  valid_from   DATE        NOT NULL DEFAULT CURRENT_DATE,
  valid_to     DATE,                                     -- NULL = 종료일 없음
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_b2b_prices_unit_price CHECK (unit_price >= 0),
  CONSTRAINT ck_b2b_prices_period     CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT ex_b2b_prices_no_overlap EXCLUDE USING gist (
    customer_id WITH =,
    product_id  WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (is_active)
);

-- 주문 등록 시 단가 조회: (거래처, 품목들, 기준일) → 최신 유효 단가
CREATE INDEX idx_b2b_prices_lookup
  ON b2b_product_prices (customer_id, product_id, valid_from DESC)
  WHERE is_active;

-- -----------------------------------------------------------------------------
-- 3. B2B_Orders : 납품 주문 / 예약 생산
--    상태: RECEIVED(접수) → IN_PRODUCTION(생산중) → DELIVERED(출고완료)
--          RECEIVED / IN_PRODUCTION → CANCELLED(취소)
-- -----------------------------------------------------------------------------
CREATE SEQUENCE b2b_order_no_seq;

CREATE TABLE b2b_orders (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                BIGINT       NOT NULL,
  order_no                 VARCHAR(30)  NOT NULL,         -- 예: B2B-20261018-000123
  customer_id              BIGINT       NOT NULL REFERENCES b2b_customers (id) ON DELETE RESTRICT,
  order_date               DATE         NOT NULL,         -- 주문일
  delivery_due_date        DATE         NOT NULL,         -- 출고 예정일
  status                   VARCHAR(20)  NOT NULL DEFAULT 'RECEIVED',
  delivery_address         VARCHAR(255) NOT NULL,         -- 주문 시점 배송지 스냅샷
  delivery_address_detail  VARCHAR(255),
  total_supply_amount      BIGINT       NOT NULL DEFAULT 0,  -- 공급가액 합계
  total_vat_amount         BIGINT       NOT NULL DEFAULT 0,  -- 부가세 합계
  total_amount             BIGINT       NOT NULL DEFAULT 0,  -- 합계(공급가액 + 부가세)
  idempotency_key          VARCHAR(100),                     -- 중복 등록 방지 키 (Idempotency-Key 헤더)
  memo                     TEXT,
  production_started_at    TIMESTAMPTZ,
  delivered_at             TIMESTAMPTZ,                      -- 출고 완료 시각 (매출/미수금 인식 시점)
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  created_by               VARCHAR(64),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_b2b_orders_order_no    UNIQUE (tenant_id, order_no),
  CONSTRAINT uq_b2b_orders_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ck_b2b_orders_status      CHECK (status IN ('RECEIVED', 'IN_PRODUCTION', 'DELIVERED', 'CANCELLED')),
  CONSTRAINT ck_b2b_orders_due_date    CHECK (delivery_due_date >= order_date),
  CONSTRAINT ck_b2b_orders_amounts     CHECK (
    total_supply_amount >= 0 AND total_vat_amount >= 0
    AND total_amount = total_supply_amount + total_vat_amount
  ),
  CONSTRAINT ck_b2b_orders_delivered   CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL),
  CONSTRAINT ck_b2b_orders_cancelled   CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);

-- 생산/출고 계획 화면: 상태별 출고 예정일 순
CREATE INDEX idx_b2b_orders_schedule ON b2b_orders (tenant_id, status, delivery_due_date);
-- 거래처별 주문 이력
CREATE INDEX idx_b2b_orders_customer ON b2b_orders (customer_id, order_date DESC);
-- 미수금 에이징(FIFO 충당) 계산용
CREATE INDEX idx_b2b_orders_delivered ON b2b_orders (customer_id, delivered_at, id)
  WHERE status = 'DELIVERED';

-- -----------------------------------------------------------------------------
-- 4. B2B_Order_Items : 주문 상세
--    단가/품목명/과세유형은 주문 시점 값을 스냅샷으로 저장한다(이후 단가표가
--    바뀌어도 과거 주문 금액은 변하지 않음).
-- -----------------------------------------------------------------------------
CREATE TABLE b2b_order_items (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT        NOT NULL REFERENCES b2b_orders (id) ON DELETE CASCADE,
  line_no           SMALLINT      NOT NULL,
  product_id        BIGINT        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  product_price_id  BIGINT        REFERENCES b2b_product_prices (id) ON DELETE SET NULL,  -- 적용된 단가표 행
  product_name      VARCHAR(200)  NOT NULL,
  unit              VARCHAR(20)   NOT NULL,
  tax_type          VARCHAR(10)   NOT NULL,
  quantity          NUMERIC(12,3) NOT NULL,
  unit_price        BIGINT        NOT NULL,     -- 적용된 납품 단가
  supply_amount     BIGINT        NOT NULL,     -- 공급가액
  vat_amount        BIGINT        NOT NULL,     -- 부가세
  line_total        BIGINT        NOT NULL,     -- 공급가액 + 부가세
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_b2b_order_items_line UNIQUE (order_id, line_no),
  CONSTRAINT ck_b2b_order_items_tax  CHECK (tax_type IN ('TAXABLE', 'EXEMPT')),
  CONSTRAINT ck_b2b_order_items_qty  CHECK (quantity > 0),
  CONSTRAINT ck_b2b_order_items_amt  CHECK (
    unit_price >= 0 AND supply_amount >= 0 AND vat_amount >= 0
    AND line_total = supply_amount + vat_amount
    AND (tax_type = 'TAXABLE' OR vat_amount = 0)
  )
);

CREATE INDEX idx_b2b_order_items_order   ON b2b_order_items (order_id);
CREATE INDEX idx_b2b_order_items_product ON b2b_order_items (product_id);

-- -----------------------------------------------------------------------------
-- 주문 상태 변경 이력 (감사 로그)
-- -----------------------------------------------------------------------------
CREATE TABLE b2b_order_status_history (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT      NOT NULL REFERENCES b2b_orders (id) ON DELETE CASCADE,
  from_status  VARCHAR(20),
  to_status    VARCHAR(20) NOT NULL,
  reason       TEXT,
  changed_by   VARCHAR(64),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_b2b_order_status_history_order ON b2b_order_status_history (order_id, changed_at);

-- -----------------------------------------------------------------------------
-- 5. Accounts_Receivable : 거래처별 미수금 원장 (거래처당 1행)
--    total_order_amount : 출고완료된 주문 금액 누계 (외상 매출 누계)
--    total_paid_amount  : 실제 입금액 누계
--    balance            : 미수금 잔액 = 누계 - 입금 (GENERATED → 항상 정합)
--                         음수면 선수금(과입금) 상태
-- -----------------------------------------------------------------------------
CREATE TABLE accounts_receivable (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT      NOT NULL,
  customer_id         BIGINT      NOT NULL REFERENCES b2b_customers (id) ON DELETE RESTRICT,
  total_order_amount  BIGINT      NOT NULL DEFAULT 0,
  total_paid_amount   BIGINT      NOT NULL DEFAULT 0,
  balance             BIGINT      GENERATED ALWAYS AS (total_order_amount - total_paid_amount) STORED,
  last_delivered_at   TIMESTAMPTZ,                 -- 마지막 외상 발생(출고) 시각
  last_settled_date   DATE,                        -- 최종 정산(입금)일
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_accounts_receivable_customer UNIQUE (customer_id),
  CONSTRAINT ck_accounts_receivable_amounts  CHECK (total_order_amount >= 0 AND total_paid_amount >= 0)
);

CREATE INDEX idx_accounts_receivable_tenant_balance ON accounts_receivable (tenant_id, balance DESC);

-- -----------------------------------------------------------------------------
-- 입금 내역 (미수금 원장의 total_paid_amount 근거 데이터)
-- -----------------------------------------------------------------------------
CREATE TABLE b2b_payments (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT       NOT NULL,
  customer_id      BIGINT       NOT NULL REFERENCES b2b_customers (id) ON DELETE RESTRICT,
  amount           BIGINT       NOT NULL,
  paid_date        DATE         NOT NULL,                -- 입금일
  method           VARCHAR(20)  NOT NULL DEFAULT 'BANK_TRANSFER',
  reference        VARCHAR(100),                         -- 입금자명 / 거래번호
  memo             TEXT,
  idempotency_key  VARCHAR(100),
  created_by       VARCHAR(64),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT ck_b2b_payments_amount      CHECK (amount > 0),
  CONSTRAINT ck_b2b_payments_method      CHECK (method IN ('BANK_TRANSFER', 'CASH', 'CARD', 'OFFSET', 'OTHER')),
  CONSTRAINT uq_b2b_payments_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_b2b_payments_customer ON b2b_payments (customer_id, paid_date DESC);

-- -----------------------------------------------------------------------------
-- 재고 수불 이력: 출고로 인한 재고 차감 기록
--   (ref_type, ref_id, product_id, movement_type) UNIQUE → 동일 주문의 이중 차감을
--   DB 레벨에서 한 번 더 차단한다.
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_movements (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT        NOT NULL,
  inventory_id     BIGINT        NOT NULL REFERENCES inventories (id) ON DELETE RESTRICT,
  product_id       BIGINT        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  movement_type    VARCHAR(30)   NOT NULL,      -- B2B_DELIVERY 등
  quantity_change  NUMERIC(14,3) NOT NULL,      -- 출고는 음수
  quantity_after   NUMERIC(14,3) NOT NULL,
  ref_type         VARCHAR(30)   NOT NULL,      -- B2B_ORDER
  ref_id           BIGINT        NOT NULL,
  created_by       VARCHAR(64),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_inventory_movements_ref UNIQUE (ref_type, ref_id, product_id, movement_type)
);

CREATE INDEX idx_inventory_movements_product ON inventory_movements (tenant_id, product_id, created_at DESC);
