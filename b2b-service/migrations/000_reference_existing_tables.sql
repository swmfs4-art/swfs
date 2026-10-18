-- =============================================================================
-- 000. 기존 테이블 참조용 스키마 (품목 마스터 / 재고)
-- -----------------------------------------------------------------------------
-- B2B 모듈은 ATC-F&B에 이미 있는 "품목 마스터(products)"와 "재고(inventories)"
-- 테이블을 참조한다. 운영 DB에 이미 존재하면 IF NOT EXISTS 덕분에 아무 일도
-- 일어나지 않는다. 컬럼명이 다르면 src/models/product.js, src/models/inventory.js
-- 의 field 매핑만 맞춰 주면 된다.
--
-- B2B 로직이 기대하는 최소 컬럼:
--   products.tax_type   : 'TAXABLE'(과세, 부가세 10%) | 'EXEMPT'(면세: 농·축·수산물 원물 등)
--   inventories         : (tenant_id, product_id) 당 1행, quantity NUMERIC
-- =============================================================================

CREATE TABLE IF NOT EXISTS products (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT       NOT NULL,
  sku           VARCHAR(50),
  name          VARCHAR(200) NOT NULL,
  unit          VARCHAR(20)  NOT NULL DEFAULT 'EA',
  product_type  VARCHAR(20)  NOT NULL DEFAULT 'FINISHED'
                CHECK (product_type IN ('RAW', 'SEMI', 'FINISHED')),
  tax_type      VARCHAR(10)  NOT NULL DEFAULT 'TAXABLE'
                CHECK (tax_type IN ('TAXABLE', 'EXEMPT')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products (tenant_id);

CREATE TABLE IF NOT EXISTS inventories (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT        NOT NULL,
  product_id  BIGINT        NOT NULL REFERENCES products (id),
  quantity    NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventories_tenant_product UNIQUE (tenant_id, product_id)
);
