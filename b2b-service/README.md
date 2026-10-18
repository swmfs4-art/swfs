# ATC-F&B 납품/B2B 모듈

거래처별 맞춤 단가, 납품 주문(예약 생산) → 출고, 출고 시 재고 자동 차감, 미수금(외상) 관리.
Express + PostgreSQL + Sequelize v6.

## 구조

```
migrations/
  000_reference_existing_tables.sql   기존 품목 마스터(products) / 재고(inventories) 참조 스키마 (IF NOT EXISTS)
  001_b2b_schema.sql                  B2B 스키마 (스키마의 원본)
scripts/migrate.js                    SQL 마이그레이션 러너
src/
  models/index.js                     Sequelize 모델 + 연관관계
  services/orderService.js            주문 등록 / 상태 변경 / 재고 차감
  services/receivableService.js       미수금 원장 / 입금 / 미수금 현황 집계 쿼리
  services/customerService.js         거래처 / 거래처별 단가
  routes/b2b.js                       Express 라우터
  lib/                                에러 처리, 검증, 금액 계산, 트랜잭션 재시도, 직렬화
tests/b2b.test.js                     실제 PostgreSQL 대상 통합 테스트
```

## 테이블

| 요구사항 | 테이블 | 비고 |
|---|---|---|
| B2B_Customers | `b2b_customers` | 사업자번호 체크섬 검증, 결제조건(일), 여신 한도 |
| B2B_Product_Prices | `b2b_product_prices` | 거래처 × 품목 × 적용기간. 활성 단가끼리 기간 중복은 `EXCLUDE` 제약으로 막음 |
| B2B_Orders | `b2b_orders` | `RECEIVED`(접수) / `IN_PRODUCTION`(생산중) / `DELIVERED`(출고완료) / `CANCELLED`(취소) |
| B2B_Order_Items | `b2b_order_items` | 적용 단가, 공급가액, 부가세, 품목명·과세유형을 주문 시점 값으로 저장 |
| Accounts_Receivable | `accounts_receivable` | 거래처당 1행. `balance`는 `GENERATED` 컬럼(누계 − 입금) |
| (보조) | `b2b_payments` | 입금 내역 |
| (보조) | `inventory_movements` | 재고 수불 이력. UNIQUE 제약으로 이중 차감 방지 |
| (보조) | `b2b_order_status_history` | 상태 변경 감사 로그 |

금액은 모두 원 단위 정수(`BIGINT`)로 저장하고 BigInt로 계산합니다.
공급가액 = round(수량 × 단가), 부가세 = floor(공급가액 × 10%)이고, 면세 품목의 부가세는 0입니다.

## API (`/api/b2b`)

| Method | Path | 설명 |
|---|---|---|
| POST | `/orders` | 주문 등록. 거래처 단가표에서 단가를 자동으로 매핑하고 금액·여신 한도를 계산·검사. `Idempotency-Key` 헤더 지원 |
| PATCH | `/orders/:id/status` | 상태 변경. `DELIVERED`가 되면 재고 차감, 수불 기록, 미수금 누적을 한 트랜잭션으로 처리 |
| GET | `/receivables` | 거래처별 누적 외상값, 입금액, 미수금 잔액, 연체 구간(FIFO), 전체 합계 |
| GET | `/orders/:id` | 주문 조회 |
| POST | `/receivables/:customerId/payments` | 입금 등록 |
| POST/GET | `/customers` | 거래처 등록/목록 |
| POST/GET | `/customers/:id/prices` | 거래처 단가 등록(기존 단가 자동 마감)/조회 |

에러 응답 형식: `{ "error": { "code", "message", "details?", "requestId" } }`

| status | 주요 code |
|---|---|
| 400 | `INVALID_JSON`, `INVALID_BODY`, `INVALID_IDEMPOTENCY_KEY` |
| 401 | `UNAUTHENTICATED` |
| 404 | `CUSTOMER_NOT_FOUND`, `ORDER_NOT_FOUND` |
| 409 | `INSUFFICIENT_STOCK`, `INVALID_STATUS_TRANSITION`, `CREDIT_LIMIT_EXCEEDED`, `OVERPAYMENT`, `DUPLICATE_RESOURCE`, `PERIOD_OVERLAP` |
| 422 | `VALIDATION_FAILED`, `PRICE_NOT_SET`, `PRODUCT_NOT_FOUND`, `UNIT_PRICE_NOT_ALLOWED`, `DUPLICATE_ORDER_ITEM`, `INVALID_QUANTITY` |
| 503 | `CONCURRENT_UPDATE`, `DATABASE_UNAVAILABLE` (`Retry-After` 포함) |

## 기존 앱에 붙이기

```js
const { createSequelize, initModels, createB2BRouter } = require('./b2b-service/src');
const sequelize = createSequelize(process.env.DATABASE_URL);
const models = initModels(sequelize);
// authMiddleware 가 req.auth = { tenantId, userId } (또는 req.user) 를 채워야 함
app.use('/api/b2b', authMiddleware, createB2BRouter({ sequelize, models }));
```

컨텍스트 구조가 다르면 `createB2BRouter({ getContext: (req) => ({ tenantId, userId }) })`로 바꿔 끼우면 됩니다.

## 실행 / 테스트

```bash
npm install
DATABASE_URL=postgres://user:pass@host:5432/db npm run migrate
DATABASE_URL=... npm start                     # B2B_DEV_HEADER_AUTH=1 이면 X-Tenant-Id 헤더로 개발 테스트
TEST_DATABASE_URL=postgres://.../atc_b2b_test npm test   # 주의: 대상 DB의 public 스키마를 초기화함
```

## 운영 반영 전 확인할 것

- `products` / `inventories`가 이미 있다면 컬럼명을 `src/models/index.js`의 Product/Inventory 매핑과 맞추세요.
  특히 `products.tax_type`(과세/면세)이 필요하고, 재고는 (tenant, 품목)당 1행을 전제로 합니다. 창고가 여러 곳이면 출고 창고 컬럼을 추가해야 합니다.
- `btree_gist` 확장을 쓸 수 있어야 합니다. RDS, Cloud SQL, Supabase는 지원합니다.
- 출고완료 이후 취소는 막혀 있습니다. 반품(재고 복원 + 미수금 차감)은 별도 기능으로 만들어야 합니다.
- 완제품 출고 시 레시피(BOM)에 따라 원재료를 차감하는 로직은 포함하지 않았습니다. 출고된 품목 자체의 재고만 차감합니다.
- 권한(누가 출고 확정·입금을 등록할 수 있는지)은 상위 인증/권한 미들웨어에서 처리하세요.
