# FE-M2 건물·호실·초대코드 관리 (OWNER) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 또는 executing-plans. 체크박스(`- [ ]`) 사용.

**Goal:** OWNER가 건물을 만들고, 건물별 호실을 보고 추가하며, 호실에 초대코드를 발급해 공유하는 관리 화면을 구현한다.

**Architecture:** App Router. **읽기**(건물 목록·호실 목록)는 서버 컴포넌트가 httpOnly 쿠키 토큰으로 백엔드를 호출한다. **쓰기**(건물·호실 생성, 초대코드 발급)는 Next **Route Handler(`app/api/*`)** 가 토큰을 붙여 백엔드로 프록시한다(토큰 클라 미노출). 폼은 **react-hook-form + zod**. 라우트·상태는 상수(매직스트링 금지), API는 `lib/api` 도메인 모듈.

**Tech Stack:** Next.js 16(App Router, RSC) · React 19 · TS · Tailwind v4 · react-hook-form + zod · Vitest+RTL.

**전제(백엔드 선행):** `2026-06-22-list-units-backend.md`가 구현돼 `GET /buildings/:buildingId/units`가 있어야 호실 목록을 표시한다. 미구현이면 호실 목록 섹션은 빈 상태로 degrade.

**근거:** 디자인 시스템 v0, README §7 Property. 컨벤션: 매직스트링 금지(constants/messages), 폼 RHF+zod, API 도메인 분리(estate-web CLAUDE.md).

## 스코프 (YAGNI)
- 포함: 건물 목록·생성, 건물 상세(호실 목록)·호실 생성, 초대코드 발급+복사/공유 링크.
- 제외: 호실 점유(입주자) 현황·계약 종료(별도 백엔드 필요, 후속), 건물/호실 수정·삭제(백엔드 미지원).

---

## 파일 구조 (estate-web `web/` 내부)
```
lib/api/building.ts   # (확장) backendBuildingUnits(GET), backendCreateBuilding, type Unit
lib/api/invite.ts     # (확장) backendIssueInvite(POST units/:id/invite-codes)
lib/api/unit.ts       # (신규) backendCreateUnit  ← 도메인 분리 규칙
lib/constants.ts      # PAGE_ROUTES에 buildings/buildingDetail 추가
lib/schemas.ts        # buildingSchema, unitSchema (zod)
app/api/buildings/route.ts                     # POST 건물 생성(프록시)
app/api/buildings/[id]/units/route.ts          # POST 호실 생성(프록시)
app/api/units/[id]/invite-codes/route.ts       # POST 초대코드 발급(프록시)
app/(owner)/buildings/page.tsx                 # 건물 목록 + 생성
app/(owner)/buildings/[id]/page.tsx            # 건물 상세: 호실 목록 + 생성 + 초대코드
components/building/{building-form,unit-form,invite-code-card}.tsx
```
> 명령어: `npm test`·`npm run build`·`npm run lint`. 브랜치 `feat/building-management`.

---

## Task 1: 상수·스키마·API 헬퍼

**Files:** Modify `lib/constants.ts`, `lib/schemas.ts`, `lib/api/building.ts`, `lib/api/invite.ts`; Create `lib/api/unit.ts`

- [ ] **Step 1:** `lib/constants.ts` `PAGE_ROUTES`에 추가: `buildings: "/buildings"`(이미 있으면 유지), `buildingDetail: (id: string) => \`/buildings/${id}\``. (함수형 라우트 허용.)
- [ ] **Step 2:** `lib/schemas.ts`에 zod 스키마 추가(메시지는 `MESSAGES` 참조):
```typescript
export const buildingSchema = z.object({
  name: z.string().min(1, MESSAGES.form.invalidInput),
  address: z.string().min(1, MESSAGES.form.invalidInput),
});
export type BuildingInput = z.infer<typeof buildingSchema>;
export const unitSchema = z.object({
  name: z.string().min(1, MESSAGES.form.invalidInput),
  floor: z.coerce.number().int(),
});
export type UnitInput = z.infer<typeof unitSchema>;
```
- [ ] **Step 3:** API 헬퍼. `lib/api/building.ts`에 추가:
```typescript
import { call, authGet } from "./client";
export type Unit = { id: string; buildingId: string; name: string; floor: number };
export const backendBuildingUnits = (t: string, buildingId: string) =>
  authGet<Unit[]>(`/buildings/${buildingId}/units`, t);
export const backendCreateBuilding = (t: string, body: { name: string; address: string }) =>
  call<Building>("/buildings", { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify(body) }, {});
```
`lib/api/unit.ts`(신규):
```typescript
import { call } from "./client";
import type { Unit } from "./building";
export const backendCreateUnit = (t: string, buildingId: string, body: { name: string; floor: number }) =>
  call<Unit>(`/buildings/${buildingId}/units`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify(body) }, {});
```
`lib/api/invite.ts`에 추가:
```typescript
export const backendIssueInvite = (t: string, unitId: string) =>
  call<{ code: string; expiresInSec: number }>(`/units/${unitId}/invite-codes`,
    { method: "POST", headers: { Authorization: `Bearer ${t}` } }, {});
```
배럴 `lib/api/index.ts`에 `export * from "./unit";` 추가.
- [ ] **Step 4:** `npm run build` → 컴파일. **커밋** `feat: 건물관리 상수·zod 스키마·API 헬퍼`

---

## Task 2: 쓰기 Route Handler 3종

**Files:** Create `app/api/buildings/route.ts`, `app/api/buildings/[id]/units/route.ts`, `app/api/units/[id]/invite-codes/route.ts`

- [ ] **Step 1:** 공통 패턴(토큰 읽어 백엔드 프록시, 에러는 status+message로). 예 — `app/api/buildings/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/session";
import { backendCreateBuilding, ApiError } from "@/lib/api";

export async function POST(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ message: "인증 필요" }, { status: 401 });
  try {
    const body = await req.json();
    const created = await backendCreateBuilding(token, body);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```
units·invite-codes 핸들러도 동일 패턴(`params`는 Next 16에서 `await`). units: body `{name,floor}` → `backendCreateUnit(token, id, body)`. invite-codes: `backendIssueInvite(token, id)`.
- [ ] **Step 2:** `npm run build` → 확인. **커밋** `feat: 건물/호실/초대코드 쓰기 Route Handler`

---

## Task 3: 건물 목록 + 생성 화면

**Files:** Create `app/(owner)/buildings/page.tsx`, `components/building/building-form.tsx`

- [ ] **Step 1:** 서버 컴포넌트 목록 — `app/(owner)/buildings/page.tsx`: `getToken()`→없으면 redirect(PAGE_ROUTES.login); `backendMyBuildings(token)`로 목록 → `Card`+`ListRow`로 렌더(각 행 `Link href={PAGE_ROUTES.buildingDetail(b.id)}`). 빈 상태 `EmptyState`. 상단에 `<BuildingForm/>`.
- [ ] **Step 2:** `components/building/building-form.tsx`(클라이언트, RHF+zod):
```tsx
"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { buildingSchema, type BuildingInput } from "@/lib/schemas";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export function BuildingForm() {
  const router = useRouter();
  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } =
    useForm<BuildingInput>({ resolver: zodResolver(buildingSchema) });
  async function onValid(v: BuildingInput) {
    const res = await fetch("/api/buildings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    if (res.ok) router.refresh();
    else setError("root", { message: (await res.json()).message ?? "생성 실패" });
  }
  return (
    <form onSubmit={handleSubmit(onValid)} className="mb-4 flex flex-col gap-2">
      <Field label="건물 이름" {...register("name")} error={errors.name?.message} />
      <Field label="주소" {...register("address")} error={errors.address?.message} />
      {errors.root && <p className="text-[13px] text-danger">{errors.root.message}</p>}
      <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "생성 중…" : "건물 추가"}</Button>
    </form>
  );
}
```
- [ ] **Step 3:** `npm run build` → 확인. **커밋** `feat: 건물 목록 + 생성 화면`

---

## Task 4: 건물 상세 — 호실 목록·생성 + 초대코드

**Files:** Create `app/(owner)/buildings/[id]/page.tsx`, `components/building/{unit-form,invite-code-card}.tsx`

- [ ] **Step 1:** 서버 컴포넌트 상세 — `app/(owner)/buildings/[id]/page.tsx`: `params` await로 id, `getToken()` 가드, `backendBuildingUnits(token, id)`로 호실 목록(백엔드 미구현 시 빈 배열 degrade) → `Card`+호실 행(각 행에 `<InviteCodeCard unitId={u.id}/>` 또는 "초대코드 발급" 버튼). 상단 `<UnitForm buildingId={id}/>`.
- [ ] **Step 2:** `unit-form.tsx`(RHF+zod, `unitSchema`) — `/api/buildings/${buildingId}/units`로 POST, 성공 시 `router.refresh()`. (BuildingForm과 동일 패턴.)
- [ ] **Step 3:** `invite-code-card.tsx`(클라이언트) — 버튼 클릭 → `/api/units/${unitId}/invite-codes` POST → 받은 `code`를 표시 + **복사 버튼**(navigator.clipboard) + **공유 링크**(`${location.origin}/invite?code=${code}`, 온보딩 FE-M0의 진입점). 만료(`expiresInSec`) 안내.
- [ ] **Step 4:** `npm run build` → 확인. **커밋** `feat: 건물 상세 호실 목록/생성 + 초대코드 발급·공유`

---

## Task 5: 마무리
- [ ] `cd web && npm run lint && npm test && npm run build` 통과.
- [ ] (수동, 백엔드+docker) OWNER 로그인 → 건물 생성 → 상세에서 호실 생성 → 초대코드 발급/복사 → 그 코드로 입주자 가입(FE-M0) 연결 확인.
- [ ] push + PR(estate-web). 머지 후 부모 서브모듈 포인터 갱신.
- [ ] 대시보드 OWNER 빠른액션 `건물 관리`(PAGE_ROUTES.buildings)가 이 화면으로 연결되는지 확인.

## 성공 기준
- OWNER가 건물 생성→목록 확인, 건물 상세에서 호실 생성→목록 확인, 호실에 초대코드 발급→복사/공유 링크.
- 쓰기는 Route Handler 경유(토큰 클라 미노출), 폼은 RHF+zod, 라우트/상태 리터럴 없음(상수), API는 도메인 모듈.
- GET units 미구현 시 호실 목록만 빈 상태로 degrade(건물 생성·목록은 동작).
