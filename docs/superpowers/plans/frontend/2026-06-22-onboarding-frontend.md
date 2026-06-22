# 온보딩 프론트엔드(estate-web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** estate-web에 온보딩 화면(로그인·역할선택·건물주가입·입주자 초대 통합가입·공유링크)을 구현한다. 토큰은 httpOnly 쿠키로 저장하고, 자격증명은 Next Route Handler가 백엔드로 프록시한다.

**Architecture:** App Router. 자격증명/토큰은 브라우저가 만지지 않는다 — Next Route Handler(`/api/session/*`)가 백엔드 `/auth/*`를 호출하고 accessToken을 **httpOnly 쿠키**로 set한다. 보호 API는 서버 컴포넌트/route handler가 쿠키 토큰을 백엔드로 프록시한다. 입주자 초대 가입은 기존 백엔드 API 3개(signup→login→redeem)를 서버에서 순차 호출한다.

**Tech Stack:** Next.js 16(App Router) · React 19 · TypeScript · Tailwind v4(디자인 토큰은 `app/globals.css`에 이미 존재) · Vitest + React Testing Library(로직/컴포넌트 단위) · Pretendard.

**작업 위치:** `estate-server/web`(= estate-web 서브모듈, 브랜치 `main`). **커밋·push는 web/ 안(estate-web 레포)에서** 한다. 작업 후 부모(estate-server)의 서브모듈 포인터 갱신은 별도.

**전제(백엔드 플랜 선행):** `2026-06-22-onboarding-backend.md`가 구현돼 ① `/auth/signup`이 `role` 수용 ② `GET /invite-codes/:code/preview` 존재. 백엔드 base URL은 env `BACKEND_URL`.

**근거 스펙:** `docs/superpowers/specs/2026-06-22-onboarding-design.md`.

---

## 파일 구조 (estate-web 기준, 모두 web/ 내부)

```
lib/
  env.ts            # BACKEND_URL 등 서버 환경변수 접근(검증)
  api.ts            # 백엔드 호출 래퍼 + 에러 매핑(서버 전용)
  session.ts        # 쿠키 read/write 헬퍼(httpOnly), getSession()
  validation.ts     # 이메일/비번/코드 인라인 검증(순수 함수)
app/api/session/route.ts          # POST 로그인(쿠키 set) / DELETE 로그아웃
app/api/session/signup/route.ts   # POST 건물주/입주자 가입(서버 오케스트레이션)
components/ui/
  button.tsx        # 디자인 시스템 Button 프리미티브
  field.tsx         # 라벨+인풋+에러 Field 프리미티브
app/login/page.tsx
app/signup/page.tsx               # 역할 선택(2 카드)
app/signup/owner/page.tsx
app/signup/tenant/page.tsx        # 다단계: 코드→폼→처리→완료
app/invite/page.tsx               # ?code= → tenant 가입에 프리필
app/dashboard/page.tsx            # 로그인 후 진입(역할별 최소 placeholder)
middleware.ts                     # 인증 가드(보호/공개 경로 리다이렉트)
```

> 명령어: `npm run dev`(개발), `npm test`(Vitest, Task 1에서 설정), `npm run build`(빌드), `npm run lint`.

---

## Task 1: 테스트 셋업 (Vitest + RTL) + env

**Files:**
- Create: `web/vitest.config.ts`, `web/vitest.setup.ts`, `web/lib/env.ts`, `web/lib/validation.ts`
- Test: `web/lib/validation.test.ts`
- Modify: `web/package.json` (scripts/deps)

- [ ] **Step 1: 의존성 설치**

```bash
cd web
npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
```

- [ ] **Step 2: vitest 설정 작성**

`web/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./vitest.setup.ts"], globals: true },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
```
`web/vitest.setup.ts`:
```typescript
import "@testing-library/jest-dom/vitest";
```
`web/package.json`의 scripts에 추가: `"test": "vitest run"`.

- [ ] **Step 3: 검증 유틸 — 실패 테스트 먼저**

`web/lib/validation.test.ts`:
```typescript
import { isEmail, isPassword, isInviteCode } from "@/lib/validation";

describe("validation", () => {
  it("이메일 형식", () => {
    expect(isEmail("a@b.com")).toBe(true);
    expect(isEmail("nope")).toBe(false);
  });
  it("비밀번호 8자 이상", () => {
    expect(isPassword("pw123456")).toBe(true);
    expect(isPassword("short")).toBe(false);
  });
  it("초대코드 비어있지 않음", () => {
    expect(isInviteCode("A1B2C3D4")).toBe(true);
    expect(isInviteCode("")).toBe(false);
  });
});
```
Run: `npm test` → FAIL(모듈 없음).

- [ ] **Step 4: 구현**

`web/lib/validation.ts`:
```typescript
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
export const isPassword = (v: string) => v.length >= 8;
export const isInviteCode = (v: string) => v.trim().length > 0;
```
`web/lib/env.ts`:
```typescript
// 서버 전용 환경변수. 클라이언트 노출 prefix 사용 금지(보안).
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
```

Run: `npm test` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add vitest.config.ts vitest.setup.ts package.json package-lock.json lib/validation.ts lib/validation.test.ts lib/env.ts
git commit -m "chore: Vitest+RTL 테스트 셋업 + 검증/env 유틸"
```

---

## Task 2: UI 프리미티브 (Button, Field)

**Files:**
- Create: `web/components/ui/button.tsx`, `web/components/ui/field.tsx`
- Test: `web/components/ui/button.test.tsx`

- [ ] **Step 1: 실패 테스트**

`web/components/ui/button.test.tsx`:
```typescript
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

it("variant=primary면 브랜드 배경 클래스", () => {
  render(<Button>로그인</Button>);
  const btn = screen.getByRole("button", { name: "로그인" });
  expect(btn.className).toContain("bg-brand-500");
});
```
Run: `npm test -- button` → FAIL.

- [ ] **Step 2: 구현**

`web/components/ui/button.tsx`:
```tsx
import { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const styles: Record<Variant, string> = {
  primary: "bg-brand-500 text-white hover:bg-brand-600",
  secondary: "bg-surface-2 text-text hover:brightness-95",
  ghost: "bg-transparent text-text hover:bg-surface-2",
  danger: "bg-danger text-white hover:brightness-95",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`h-[50px] w-full rounded-[14px] font-bold text-[15px] grid place-items-center transition active:scale-[.985] disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
```
`web/components/ui/field.tsx`:
```tsx
import { InputHTMLAttributes } from "react";

export function Field({
  label,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block text-left">
      <span className="mb-1.5 block text-[13px] font-medium text-text-2">{label}</span>
      <input
        className="h-[50px] w-full rounded-[14px] border border-border bg-surface px-4 text-[15px] text-text outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-50"
        {...props}
      />
      {error && <span className="mt-1 block text-[13px] text-danger">{error}</span>}
    </label>
  );
}
```
Run: `npm test -- button` → PASS.

- [ ] **Step 3: 커밋**
```bash
git add components/ui/button.tsx components/ui/field.tsx components/ui/button.test.tsx
git commit -m "feat: 디자인 시스템 Button/Field 프리미티브"
```

---

## Task 3: 백엔드 API 클라이언트 (서버 전용)

**Files:**
- Create: `web/lib/api.ts`
- Test: `web/lib/api.test.ts`

- [ ] **Step 1: 실패 테스트** — `fetch`를 모킹해 에러 매핑 검증

`web/lib/api.test.ts`:
```typescript
import { vi } from "vitest";
import { backendLogin, ApiError } from "@/lib/api";

it("401이면 ApiError('이메일 또는 비밀번호를 확인하세요')", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 401 })));
  await expect(backendLogin("a@b.com", "pw")).rejects.toMatchObject({
    status: 401,
    message: "이메일 또는 비밀번호를 확인하세요",
  });
});

it("성공이면 accessToken 반환", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "t" }), { status: 201 })));
  await expect(backendLogin("a@b.com", "pw")).resolves.toEqual({ accessToken: "t" });
});
```
Run: `npm test -- api` → FAIL.

- [ ] **Step 2: 구현**

`web/lib/api.ts`:
```typescript
import { BACKEND_URL } from "./env";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init: RequestInit, errorMap: Record<number, string>): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const msg = errorMap[res.status] ?? "요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요.";
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export type SignupRole = "OWNER" | "TENANT";

export const backendSignup = (email: string, name: string, password: string, role: SignupRole) =>
  call<{ id: string; email: string; role: string }>("/auth/signup",
    { method: "POST", body: JSON.stringify({ email, name, password, role }) },
    { 400: "입력값을 확인해주세요", 409: "이미 가입된 이메일입니다" });

export const backendLogin = (email: string, password: string) =>
  call<{ accessToken: string }>("/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    { 401: "이메일 또는 비밀번호를 확인하세요" });

export const backendPreviewInvite = (code: string) =>
  call<{ valid: boolean; buildingName?: string; unitName?: string }>(
    `/invite-codes/${encodeURIComponent(code)}/preview`, { method: "GET" }, {});

export const backendRedeemInvite = (token: string, code: string) =>
  call<{ id: string; unitId: string; status: string }>("/invite-codes/redeem",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) },
    { 404: "유효하지 않거나 만료된 초대코드입니다" });
```
Run: `npm test -- api` → PASS.

- [ ] **Step 3: 커밋**
```bash
git add lib/api.ts lib/api.test.ts
git commit -m "feat: 백엔드 API 클라이언트(에러 매핑, 서버 전용)"
```

---

## Task 4: 세션 — httpOnly 쿠키 Route Handler

**Files:**
- Create: `web/lib/session.ts`, `web/app/api/session/route.ts`
- Test: `web/lib/session.test.ts`

- [ ] **Step 1: 쿠키 헬퍼 — 실패 테스트**

`web/lib/session.test.ts` (쿠키 옵션 검증):
```typescript
import { sessionCookie } from "@/lib/session";

it("httpOnly+SameSite=lax 쿠키 옵션", () => {
  const c = sessionCookie("tok");
  expect(c.name).toBe("session");
  expect(c.value).toBe("tok");
  expect(c.options.httpOnly).toBe(true);
  expect(c.options.sameSite).toBe("lax");
});
```
Run: `npm test -- session` → FAIL.

- [ ] **Step 2: 구현**

`web/lib/session.ts`:
```typescript
import { cookies } from "next/headers";

const NAME = "session";

export function sessionCookie(token: string) {
  return {
    name: NAME,
    value: token,
    options: {
      httpOnly: true as const,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 60 * 60, // access token 수명에 맞춰 후속 조정
    },
  };
}

export async function setSession(token: string) {
  const c = sessionCookie(token);
  (await cookies()).set(c.name, c.value, c.options);
}
export async function clearSession() {
  (await cookies()).delete(NAME);
}
export async function getToken(): Promise<string | null> {
  return (await cookies()).get(NAME)?.value ?? null;
}
```
`web/app/api/session/route.ts` (로그인/로그아웃):
```typescript
import { NextRequest, NextResponse } from "next/server";
import { backendLogin, ApiError } from "@/lib/api";
import { setSession, clearSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    const { accessToken } = await backendLogin(email, password);
    await setSession(accessToken);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message ?? "로그인 실패" }, { status: err.status ?? 500 });
  }
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
```
Run: `npm test -- session` → PASS.

- [ ] **Step 3: 커밋**
```bash
git add lib/session.ts lib/session.test.ts app/api/session/route.ts
git commit -m "feat: httpOnly 세션 쿠키 + 로그인/로그아웃 Route Handler"
```

---

## Task 5: 가입 오케스트레이션 Route Handler

**Files:**
- Create: `web/app/api/session/signup/route.ts`

건물주: signup(OWNER)→login→쿠키. 입주자: signup(TENANT)→login→redeem(code)→쿠키.

- [ ] **Step 1: 구현 (route handler, 통합 흐름)**

`web/app/api/session/signup/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { backendSignup, backendLogin, backendRedeemInvite, ApiError } from "@/lib/api";
import { setSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { email, name, password, role, code } = await req.json();
    await backendSignup(email, name, password, role);          // 1) 가입
    const { accessToken } = await backendLogin(email, password); // 2) 자동 로그인(토큰 미발급 대응)
    if (role === "TENANT" && code) {
      await backendRedeemInvite(accessToken, code);            // 3) 입주(redeem)
    }
    await setSession(accessToken);                              // 4) httpOnly 쿠키
    return NextResponse.json({ ok: true, role });
  } catch (e) {
    const err = e as ApiError;
    // redeem 경합(404): 계정은 생성됐으므로 클라가 "코드 재입력"으로 보냄
    return NextResponse.json(
      { message: err.message ?? "가입 처리 실패", status: err.status },
      { status: err.status ?? 500 },
    );
  }
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 컴파일 성공.

- [ ] **Step 3: 커밋**
```bash
git add app/api/session/signup/route.ts
git commit -m "feat: 가입 오케스트레이션 Route Handler(건물주/입주자 통합)"
```

---

## Task 6: 미들웨어 인증 가드

**Files:**
- Create: `web/middleware.ts`

- [ ] **Step 1: 구현**

`web/middleware.ts` — 보호 경로는 세션 없으면 `/login`, 인증 상태로 `/login`·`/signup` 접근 시 `/dashboard`:
```typescript
import { NextRequest, NextResponse } from "next/server";

const AUTH_PAGES = ["/login", "/signup"];
const PROTECTED = ["/dashboard"];

export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get("session")?.value);
  const { pathname } = req.nextUrl;
  if (PROTECTED.some((p) => pathname.startsWith(p)) && !hasSession) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (AUTH_PAGES.some((p) => pathname.startsWith(p)) && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*", "/login", "/signup/:path*", "/signup"] };
```

- [ ] **Step 2: 빌드 확인** → `npm run build` PASS.
- [ ] **Step 3: 커밋**
```bash
git add middleware.ts
git commit -m "feat: 인증 가드 미들웨어(보호/공개 경로 리다이렉트)"
```

---

## Task 7: 로그인 화면

**Files:**
- Create: `web/app/login/page.tsx`

- [ ] **Step 1: 구현 (클라이언트 컴포넌트, /api/session 호출)**

`web/app/login/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { isEmail, isPassword } from "@/lib/validation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!isEmail(email) || !isPassword(password)) { setError("이메일/비밀번호를 확인하세요"); return; }
    setLoading(true);
    const res = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).message ?? "로그인 실패");
  }

  return (
    <main className="flex-1 grid place-items-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="mb-6 text-[24px] font-extrabold tracking-tight text-text">로그인</h1>
        <div className="flex flex-col gap-3">
          <Field label="이메일" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="비밀번호" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
        <div className="mt-6"><Button type="submit" disabled={loading}>{loading ? "확인 중…" : "로그인"}</Button></div>
        <p className="mt-5 text-center text-[14px] text-text-2">
          처음이신가요? <Link href="/signup" className="font-bold text-brand-600">회원가입</Link>
        </p>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: 빌드 확인** → `npm run build` PASS.
- [ ] **Step 3: 커밋**
```bash
git add app/login/page.tsx
git commit -m "feat: 로그인 화면"
```

---

## Task 8: 역할 선택 화면

**Files:**
- Create: `web/app/signup/page.tsx`

- [ ] **Step 1: 구현 (서버 컴포넌트, 2 선택 카드)**

`web/app/signup/page.tsx`:
```tsx
import Link from "next/link";

export default function SignupChoice() {
  return (
    <main className="flex-1 grid place-items-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-[24px] font-extrabold tracking-tight text-text">어떻게 시작할까요?</h1>
        <p className="mb-6 text-[15px] text-text-2">역할에 맞는 방식으로 가입하세요.</p>
        <div className="flex flex-col gap-3">
          <Link href="/signup/owner" className="rounded-[20px] border border-border bg-surface p-5 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5">
            <div className="text-[16px] font-bold text-text">건물주로 시작</div>
            <div className="mt-1 text-[14px] text-text-2">건물·호실을 등록하고 입주자를 초대해요</div>
          </Link>
          <Link href="/signup/tenant" className="rounded-[20px] border border-border bg-surface p-5 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5">
            <div className="text-[16px] font-bold text-text">입주자로 시작</div>
            <div className="mt-1 text-[14px] text-text-2">건물주에게 받은 초대코드가 필요해요</div>
          </Link>
        </div>
        <p className="mt-5 text-center text-[14px] text-text-2">
          이미 계정이 있나요? <Link href="/login" className="font-bold text-brand-600">로그인</Link>
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: 빌드 확인 → 커밋**
```bash
git add app/signup/page.tsx
git commit -m "feat: 회원가입 역할 선택 화면"
```

---

## Task 9: 건물주 가입 화면

**Files:**
- Create: `web/app/signup/owner/page.tsx`

- [ ] **Step 1: 구현 (클라이언트, /api/session/signup role=OWNER)**

`web/app/signup/owner/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { isEmail, isPassword } from "@/lib/validation";

export default function OwnerSignup() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name || !isEmail(form.email) || !isPassword(form.password)) {
      setError("입력값을 확인해주세요(비밀번호 8자 이상)"); return;
    }
    setLoading(true);
    const res = await fetch("/api/session/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, role: "OWNER" }),
    });
    setLoading(false);
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).message ?? "가입 실패");
  }

  return (
    <main className="flex-1 grid place-items-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="mb-6 text-[24px] font-extrabold tracking-tight text-text">건물주 회원가입</h1>
        <div className="flex flex-col gap-3">
          <Field label="이름" value={form.name} onChange={set("name")} />
          <Field label="이메일" type="email" value={form.email} onChange={set("email")} />
          <Field label="비밀번호" type="password" value={form.password} onChange={set("password")} />
        </div>
        {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
        <div className="mt-6"><Button type="submit" disabled={loading}>{loading ? "가입 중…" : "가입하고 시작하기"}</Button></div>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: 빌드 확인 → 커밋**
```bash
git add app/signup/owner/page.tsx
git commit -m "feat: 건물주 가입 화면"
```

---

## Task 10: 입주자 초대 통합 가입 (다단계)

**Files:**
- Create: `web/app/signup/tenant/page.tsx`

코드 입력→preview(미인증)→폼→/api/session/signup(role=TENANT, code 포함)→완료.

- [ ] **Step 1: 구현 (클라이언트, 단계 상태머신)**

`web/app/signup/tenant/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { isEmail, isPassword, isInviteCode } from "@/lib/validation";

export default function TenantSignup() {
  const router = useRouter();
  const prefill = useSearchParams().get("code") ?? "";
  const [step, setStep] = useState<"code" | "form" | "done">("code");
  const [code, setCode] = useState(prefill);
  const [unit, setUnit] = useState<{ buildingName?: string; unitName?: string }>({});
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function checkCode(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!isInviteCode(code)) { setError("초대코드를 입력하세요"); return; }
    setLoading(true);
    // 미인증 미리보기는 클라가 직접 백엔드 대신 자기 라우트로? → 단순화: 백엔드 직접(GET, 공개)
    const res = await fetch(`/api/invite-preview?code=${encodeURIComponent(code)}`);
    setLoading(false);
    const data = await res.json();
    if (data.valid) { setUnit(data); setStep("form"); }
    else setError("유효하지 않거나 만료된 초대코드입니다");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!form.name || !isEmail(form.email) || !isPassword(form.password)) {
      setError("입력값을 확인해주세요(비밀번호 8자 이상)"); return;
    }
    setLoading(true);
    const res = await fetch("/api/session/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, role: "TENANT", code }),
    });
    setLoading(false);
    if (res.ok) setStep("done");
    else {
      const d = await res.json();
      // redeem 경합(404): 코드 재입력으로
      if (d.status === 404) { setError("코드가 막 만료/사용되었어요. 다시 입력해주세요."); setStep("code"); }
      else setError(d.message ?? "가입 실패");
    }
  }

  return (
    <main className="flex-1 grid place-items-center px-6">
      <div className="w-full max-w-sm">
        {step === "code" && (
          <form onSubmit={checkCode}>
            <h1 className="mb-6 text-[24px] font-extrabold tracking-tight text-text">초대코드 입력</h1>
            <Field label="초대코드" value={code} onChange={(e) => setCode(e.target.value)} placeholder="예: A1B2C3D4" />
            {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
            <div className="mt-6"><Button type="submit" disabled={loading}>{loading ? "확인 중…" : "다음"}</Button></div>
          </form>
        )}
        {step === "form" && (
          <form onSubmit={submit}>
            <h1 className="mb-1 text-[24px] font-extrabold tracking-tight text-text">계정 만들기</h1>
            <p className="mb-6 text-[15px] text-text-2">
              <b className="text-text">{unit.buildingName} {unit.unitName}</b> 입주
            </p>
            <div className="flex flex-col gap-3">
              <Field label="이름" value={form.name} onChange={set("name")} />
              <Field label="이메일" type="email" value={form.email} onChange={set("email")} />
              <Field label="비밀번호" type="password" value={form.password} onChange={set("password")} />
            </div>
            {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
            <div className="mt-6"><Button type="submit" disabled={loading}>{loading ? "처리 중…" : "가입하고 입주하기"}</Button></div>
          </form>
        )}
        {step === "done" && (
          <div className="text-center">
            <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-brand-50 text-brand-600">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <h1 className="text-[22px] font-extrabold text-text">{unit.buildingName} {unit.unitName} 입주 완료!</h1>
            <p className="mt-2 text-[15px] text-text-2">이제 공지·채팅으로 소통할 수 있어요.</p>
            <div className="mt-8"><Button onClick={() => router.push("/dashboard")}>홈으로</Button></div>
          </div>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: 미리보기 프록시 Route Handler 추가**

`web/app/api/invite-preview/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { backendPreviewInvite } from "@/lib/api";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  try {
    return NextResponse.json(await backendPreviewInvite(code));
  } catch {
    return NextResponse.json({ valid: false });
  }
}
```

- [ ] **Step 3: 빌드 확인 → 커밋**
```bash
git add app/signup/tenant/page.tsx app/api/invite-preview/route.ts
git commit -m "feat: 입주자 초대 통합 가입(코드 미리보기→가입→입주→완료)"
```

---

## Task 11: 공유 링크 + 대시보드 placeholder

**Files:**
- Create: `web/app/invite/page.tsx`, `web/app/dashboard/page.tsx`

- [ ] **Step 1: 공유 링크 — code 프리필 후 입주자 가입으로**

`web/app/invite/page.tsx`:
```tsx
import { redirect } from "next/navigation";

export default async function Invite({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  redirect(`/signup/tenant${code ? `?code=${encodeURIComponent(code)}` : ""}`);
}
```

- [ ] **Step 2: 대시보드 placeholder (역할은 /auth/me로 후속 분기, 지금은 진입 확인용)**

`web/app/dashboard/page.tsx`:
```tsx
export default function Dashboard() {
  return (
    <main className="flex-1 grid place-items-center px-6">
      <div className="text-center">
        <h1 className="text-[24px] font-extrabold tracking-tight text-text">터전 홈</h1>
        <p className="mt-2 text-[15px] text-text-2">온보딩 완료. 대시보드는 다음 영역에서 구현됩니다.</p>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: 빌드 확인 → 커밋**
```bash
git add app/invite/page.tsx app/dashboard/page.tsx
git commit -m "feat: 공유 링크 진입 + 대시보드 placeholder"
```

---

## Task 12: 마무리 — 검증 + 수동 플로우

- [ ] **Step 1: 린트 + 단위 테스트 + 빌드**
```bash
cd web && npm run lint && npm test && npm run build
```
Expected: 모두 통과.

- [ ] **Step 2: 수동 플로우 검증(백엔드·인프라 기동 필요)**

백엔드(estate-server) + docker-compose(Postgres/Redis/Kafka)를 띄우고 `BACKEND_URL` 설정 후 `npm run dev`:
- `/signup/owner` 가입 → `/dashboard` 도달(쿠키 발급, 미인증 시 `/login` 가드 동작)
- OWNER로 건물/호실/초대코드 발급(현재는 API/Swagger로) → 그 코드로 `/signup/tenant` → "○○호 입주" 미리보기 → 가입 → "입주 완료"
- 잘못된 코드 → 진행 차단
- `document.cookie`에 `session` 미노출(httpOnly) 확인

- [ ] **Step 3: 서브모듈 포인터 갱신(부모)**

web/ push 후 estate-server에서:
```bash
cd .. && git add web && git commit -m "[infra]chore: web 서브모듈 포인터 갱신(온보딩 FE)"
```

---

## 성공 기준 (스펙 §7 대응)

- 건물주 가입 → `/dashboard` 도달, 세션 쿠키(httpOnly) 발급 (Task 4,5,9)
- 입주자: 유효 코드 미리보기 → 가입 → "입주 완료" (Task 10)
- 잘못된 코드: 미리보기에서 진행 차단 / redeem 경합 시 코드 재입력 (Task 10)
- 토큰은 httpOnly 쿠키에만 — JS(`document.cookie`)로 접근 불가 (Task 4)
- 공유 링크 `?code=`로 코드 프리필 (Task 11)

## 비고
- 디자인 토큰(`bg-brand-500`, `text-text-2` 등)은 `app/globals.css`에 이미 정의됨(스캐폴드 시 주입). 이 플랜은 그 위에서 화면만 구현.
- 컴포넌트 단위 테스트는 핵심 로직(validation·api·session·Button) 위주. 화면 플로우는 수동/후속 Playwright e2e로.
