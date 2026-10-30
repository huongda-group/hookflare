# Bỏ input SETUP_TOKEN — design ngắn

Ngày: 2026-10-30. Cách A đã chọn.

## Intent / why
Giữ trang `/setup` tạo admin đầu tiên, nhưng bỏ hẳn ô + check `SETUP_TOKEN` cho gọn khi tự host private. Trước đây token chống người lạ chiếm admin trước; nay chấp nhận first-come-first-wins.

## Goals
- `POST /api/admin/v1/auth/setup` chỉ cần `username/password (+turnstile_token)`, không cần `setup_token`.
- UI `SetupPage` không còn ô Setup token, không còn message `wrangler secret put SETUP_TOKEN`.
- Không còn tham chiếu `SETUP_TOKEN` trong code/docs/test/env mẫu.

## Non-goals
- Không bỏ trang `/setup`, không bỏ `setup_required` / `setup_closed` (vẫn chỉ cho tạo 1 lần).
- Không thêm bảo vệ thay thế (IP allowlist, cờ DISABLE_SETUP) — thuộc cách B.
- Không đổi login/session/rate-limit/Turnstile.

## Anti-goals
- Bỏ token mà vẫn để endpoint mở cho tạo nhiều admin = thất bại. Phải giữ nguyên `setup_closed` atomic.

## Constraints
- Schema `setupRequest` là `strictObject` nên phải xóa field đồng bộ shared + gateway + dashboard, nếu không 400.
- Spec cũ §6.3 nhắc token trước schema; xóa là đổi spec — cập nhật `docs/login.md`, `docs/runbook.md`, `README.md`, `CLAUDE.md` nếu còn nhắc.
- Test hiện assert 401 sai token + 503 thiếu token — phải xóa/sửa.

## Approaches đã xét
- A (chọn): bỏ hẳn. Đơn giản nhất, đúng ý private service. Trade-off: ai mở URL trước khi bạn setup thì chiếm admin.
- B (loại): bỏ input nhưng giữ chốt khác (localhost-only / ALLOW_SETUP). An toàn hơn khi URL public, nhưng thêm config, trái ý gọn.

## Cách làm đã chốt (cho builder)
Backend `apps/gateway/src/admin/routes/auth.ts`: xóa block `expected/provided/timingSafeEqual` + `setup_token_missing`; `setupRequest.safeParse` còn lại username/password.
Shared `packages/shared/src/admin.ts`: xóa `setup_token` khỏi `setupRequest`.
Frontend: `SetupPage.tsx` xóa `setup_token` khỏi form/default/FIELD_IDS/UI/help/503-branch/guide còn token; `lib/queries/auth.ts` xóa field khỏi `SetupBody`; `SetupPage.test.tsx` sửa `fill()`, xóa 2 test token/503, sửa test off-notice + heading chứa token.
Env/test: `src/env.ts` xóa `SETUP_TOKEN`, `test/helpers/env.ts` xóa default, `auth.test.ts` xóa 3 test token/503, `playwright.config.ts` bỏ `--var SETUP_TOKEN`, `.dev.vars.example` xóa dòng.
Docs: `docs/login.md:7`, `docs/runbook.md:33,38,173`, `README.md:81,86,127,130,205,211,256`, `CHANGELOG/CLAUDE` nếu nhắc.

## Còn để cho builder quyết
- Text help mới ở SetupPage thay dòng token (giữ link guide hay bỏ).
- Có xóa `timingSafeEqual` import nếu không còn dùng chỗ khác hay không (check unused).
