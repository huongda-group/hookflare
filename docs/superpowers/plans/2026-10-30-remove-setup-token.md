# Remove SETUP_TOKEN Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Giữ trang `/setup` tạo admin đầu tiên nhưng bỏ hẳn ô và check `SETUP_TOKEN`.

**Architecture:** Xóa field khỏi shared Zod schema trước, sau đó xóa block check token ở gateway `POST /setup`, rồi xóa UI + `SetupBody`, cuối cùng dọn test/env/docs. Không đổi `setup_required`/`setup_closed` atomic.

**Tech Stack:** TypeScript, Hono + drizzle-orm + D1 (gateway), Zod v4 `strictObject` (`@hookflare/shared`), React + react-hook-form + TanStack Query (dashboard), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-remove-setup-token-design.md`

## Global Constraints

- `POST /setup` vẫn chỉ tạo được 1 lần: giữ `setupStatements` conditional + `409 setup_closed`, giữ thứ tự limiter → body → Turnstile → schema → upsert.
- `setupRequest` vẫn là `z.strictObject`; client cũ gửi `setup_token` phải rớt `400 invalid_request`.
- Không đổi login/session/rate-limit/Turnstile/same-origin.
- Không thêm env mới, không thêm bảo vệ thay thế (cách B đã loại).
- Chạy `biome check` sạch cho file chạm tới.

## Review Focus

- Client cũ vẫn gửi `setup_token` → mong đợi `400 invalid_request` (strict), không phải 201 — test ở Task 2.
- Hai `POST /setup` đồng thời → một 201 một 409, không tạo 2 session — test ở Task 2.
- DB đã có password → `GET /state setup_required:false`, `POST /setup` → 409 — test ở Task 2.
- Body quá lớn / JSON vỡ trên `/setup` → 400 + limiter vẫn đếm — giữ nguyên, test ở Task 4.
- Turnstile misconfigured trên setup → vẫn 500 `internal_error` — giữ nguyên, test ở Task 4.

---

### Task 1: Shared schema bỏ `setup_token`

**Files:**
- Modify: `packages/shared/src/admin.ts:332-337`
- Test: `packages/shared/src/*.test.ts` (nếu có — kiểm tra, không tạo mới nếu không có file setup test)

**Interfaces:**
- Consumes: không có
- Produces: `setupRequest = z.strictObject({ username, password, turnstile_token? })` — không còn `setup_token`; các task sau import nguyên tên này.

- [ ] **Step 1: Xóa `setup_token` khỏi `setupRequest` trong `packages/shared/src/admin.ts`**

Xóa dòng `setup_token: z.string().min(1).max(256),` giữ lại `username, password, turnstile_token`.

- [ ] **Step 2: Typecheck shared**

Run: `pnpm --filter @hookflare/shared run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/admin.ts
git commit -m "feat: drop setup_token from setupRequest"
```

### Task 2: Gateway `POST /setup` bỏ check token

**Files:**
- Modify: `apps/gateway/src/admin/routes/auth.ts:1,20,81-86,215-248`
- Modify: `apps/gateway/src/env.ts:1-8`
- Modify: `apps/gateway/test/helpers/env.ts:15-25`
- Modify: `apps/gateway/test/admin/routes/auth.test.ts:26-263`
- Test: `apps/gateway/test/admin/routes/auth.test.ts`

**Interfaces:**
- Consumes: `setupRequest` mới từ Task 1 (không có `setup_token`)
- Produces: `POST /setup` chấp nhận `{username,password,turnstile_token?}`; lỗi `setup_token_missing` (503) và nhánh `401 invalid_credentials` do token biến mất; `AppEnv` không còn `SETUP_TOKEN`.

- [ ] **Step 1: Viết lại test setup — xóa 3 test token, thêm test strict**

Trong `apps/gateway/test/admin/routes/auth.test.ts` xóa `it("rejects a wrong setup token...")`, `it("rejects a missing setup token...")`, `it("returns 503 when SETUP_TOKEN is unset...")`. Xóa `SETUP_TOKEN` const và mọi `setup_token:` trong body. Thêm:
```ts
it("rejects a stale setup_token with 400", async () => {
  const deps = testDeps();
  const res = await request(deps, "POST", "/auth/setup", {
    body: { username: "admin", password: PASSWORD, setup_token: "stale" },
  });
  expect(res.status).toBe(400);
});
```
Sửa các body còn lại thành `{ username, password }`. Bỏ `testEnv({ env: testEnv({ SETUP_TOKEN: undefined }) })` → `testDeps()` thường.

- [ ] **Step 2: Chạy test để thấy đỏ (schema/backend chưa khớp)**

Run: `pnpm --filter gateway run test -- test/admin/routes/auth.test.ts`
Expected: FAIL (các body cũ không còn hợp lệ / thiếu check).

- [ ] **Step 3: Implement `POST /setup` không token trong `apps/gateway/src/admin/routes/auth.ts`**

Xóa block dòng 229-241 (`expected/provided/timingSafeEqual` + 503 + 401 token). Giữ nguyên: `isSameOrigin` → `underLimit` → `readBody` → `guardTurnstile(..., stringField(raw,"turnstile_token"))` → `setupRequest.safeParse` → `password===username` → batch. Xóa `timingSafeEqual` khỏi import `../auth/secrets` nếu không còn dùng (giữ `randomToken, sha256Hex`); xóa helper `stringField` chỉ khi không còn caller (login không dùng nó — kiểm tra trước khi xóa).

- [ ] **Step 4: Dọn `AppEnv` và `testEnv`**

`apps/gateway/src/env.ts`: `SecretsEnv & { TURNSTILE_SECRET_KEY?: string }` (bỏ `SETUP_TOKEN?: string`), sửa comment. `apps/gateway/test/helpers/env.ts`: xóa dòng `SETUP_TOKEN: "test-setup-token",`.

- [ ] **Step 5: Chạy test gateway**

Run: `pnpm --filter gateway run test -- test/admin/routes/auth.test.ts`
Expected: PASS. Sau đó `pnpm --filter gateway run typecheck`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/admin/routes/auth.ts apps/gateway/src/env.ts apps/gateway/test/helpers/env.ts apps/gateway/test/admin/routes/auth.test.ts
git commit -m "feat: setup without SETUP_TOKEN"
```

### Task 3: Dashboard bỏ ô Setup token

**Files:**
- Modify: `apps/dashboard/src/lib/queries/auth.ts:18-23`
- Modify: `apps/dashboard/src/pages/SetupPage.tsx:22-107`
- Test: `apps/dashboard/src/pages/SetupPage.test.tsx`

**Interfaces:**
- Consumes: `setupRequest` mới (Task 1), `POST /setup` mới (Task 2)
- Produces: `SetupBody { username,password,turnstile_token? }`; `SetupPage` không còn input/help/503-token.

- [ ] **Step 1: Sửa test UI — bỏ token khỏi `fill()`, xóa 2 test token**

Trong `SetupPage.test.tsx`: `fill()` bỏ dòng `Setup token`; xóa `it("masks the setup token...")` và `it("points at the SETUP_TOKEN command...503")`; sửa `it("never trims the password...")` bỏ dòng type Setup token; sửa `it("uses the exact headings...")` bỏ assert `getByLabelText("Setup token")`; sửa `it("shows a neutral off notice...")` bỏ assert `setup token is still required` (giữ `bot protection is off`).

- [ ] **Step 2: Chạy test để thấy đỏ**

Run: `pnpm --filter dashboard run test -- src/pages/SetupPage.test.tsx`
Expected: FAIL (form vẫn đòi `setup_token`).

- [ ] **Step 3: Implement `SetupBody` + `SetupPage` trong `lib/queries/auth.ts`, `pages/SetupPage.tsx`**

`SetupBody` xóa `setup_token: string`. `SetupPage.tsx`: `setupForm` giữ nguyên từ `setupRequest` (tự hết `setup_token`); `FIELD_IDS` xóa `setup_token`; `defaultValues` xóa `setup_token`; `setup({...})` chỉ gửi username/password/turnstile; xóa cả `<div border-t>` chứa `PasswordField id="setup-token"` + help `SETUP_TOKEN`/`.dev.vars`/guide; xóa nhánh `503 setup_token_missing` (giữ 409→login, 429). Xóa `SETUP_GUIDE_URL` nếu không còn dùng. Help mới: giữ nguyên username/password help, không thêm copy mới.

- [ ] **Step 4: Chạy test + typecheck dashboard**

Run: `pnpm --filter dashboard run test -- src/pages/SetupPage.test.tsx`
Expected: PASS. Run: `pnpm --filter dashboard run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/queries/auth.ts apps/dashboard/src/pages/SetupPage.tsx apps/dashboard/src/pages/SetupPage.test.tsx
git commit -m "feat: remove setup token input"
```

### Task 4: E2E, playwright, test còn lại

**Files:**
- Modify: `apps/dashboard/playwright.config.ts:19`
- Modify: `apps/gateway/test/admin/routes/auth.test.ts` (phần Turnstile/limiter còn `setup_token` sót — quét lại)
- Test: toàn bộ `pnpm --filter gateway run test`, `pnpm --filter dashboard run test`

**Interfaces:**
- Consumes: Task 2 + 3 xong
- Produces: e2e boot không cần `SETUP_TOKEN`; không còn `setup_token`/`SETUP_TOKEN` trong `apps/*/test`, `apps/dashboard/playwright*`.

- [ ] **Step 1: Quét sót**

Run: `rg -n "SETUP_TOKEN|setup_token" apps packages --glob '!node_modules'`
Expected: chỉ còn docs + `.dev.vars.example` + wrangler secret docs (xử lý ở Task 5), không còn trong `*.ts/*.tsx` nguồn và test.

- [ ] **Step 2: Sửa `playwright.config.ts` bỏ `--var SETUP_TOKEN:e2e-setup-token`**

Giữ lại các `--var` Turnstile + `SECRETS_KEY` + `--persist-to`.

- [ ] **Step 3: Chạy full test 2 app**

Run: `pnpm --filter gateway run test`
Expected: PASS. Run: `pnpm --filter dashboard run test`
Expected: PASS (e2e `pnpm --filter dashboard run e2e` chỉ chạy khi cần, không bắt buộc ở đây — ghi rõ nếu skip do thiếu browser).

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/playwright.config.ts apps/gateway/test/admin/routes/auth.test.ts
git commit -m "chore: drop SETUP_TOKEN from tests and e2e"
```

### Task 5: Env mẫu + docs + kiểm tra cuối

**Files:**
- Modify: `apps/gateway/.dev.vars.example:7`
- Modify: `docs/login.md:7`, `docs/runbook.md:33,38,173`, `README.md:81,86,127,130,205,211,256`, `CLAUDE.md:11` (nếu còn dòng M7 nhắc SETUP_TOKEN), `CHANGELOG.md:35,45,49` (ghi entry mới, không sửa lịch sử cũ — chỉ thêm Unreleased note)
- Modify: `apps/gateway/wrangler.jsonc` + `wrangler.staging.jsonc` nếu có `SETUP_TOKEN` trong `vars` (kiểm tra, không có thì bỏ qua)

**Interfaces:**
- Consumes: Task 1-4
- Produces: docs mới mô tả setup không token + cảnh báo first-come; không còn hướng dẫn `wrangler secret put SETUP_TOKEN`.

- [ ] **Step 1: Sửa `.dev.vars.example` + wrangler configs**

Xóa dòng `SETUP_TOKEN="dev-setup-token"`. Nếu wrangler jsonc có `SETUP_TOKEN` trong vars thì xóa.

- [ ] **Step 2: Sửa docs**

`docs/login.md`: `Setup requires ...` → `Setup needs no token; first POST creates admin, then closed`. `docs/runbook.md`: xóa `wrangler secret put SETUP_TOKEN`, thay bằng “mở Worker URL và tạo admin ngay trước khi public URL; setup xong là đóng”; xóa đoạn recovery dùng token, thay bằng “không còn recovery qua token — backup D1 / reset password qua DB”. `README.md`: sửa các đoạn onboarding + local dev + bảng secret tương tự. `CLAUDE.md`: sửa dòng M7 bỏ `protected by SETUP_TOKEN`.

- [ ] **Step 3: Kiểm tra cuối**

Run: `rg -n "SETUP_TOKEN|setup_token" . --glob '!node_modules' --glob '!.wrangler' --glob '!CHANGELOG.md'`
Expected: 0 kết quả (CHANGELOG cũ được miễn). Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/.dev.vars.example docs README.md CLAUDE.md apps/gateway/wrangler.jsonc
git commit -m "docs: setup no longer uses SETUP_TOKEN"
```
