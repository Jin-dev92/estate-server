# FE-M1 대시보드 홈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로그인 후 진입하는 `/dashboard`를 **역할 인지(OWNER/TENANT) 홈**으로 구현한다. 현재 placeholder를 대체하고, 실제 백엔드 데이터(내 계약/건물·알림 피드·채팅)를 서버에서 안전하게 불러와 보여준다.

**Architecture:** App Router **서버 컴포넌트**가 httpOnly 쿠키 토큰(`getToken`)을 읽어 백엔드를 Bearer로 호출한다(토큰은 브라우저에 노출 안 됨). `/auth/me`로 role을 받아 TENANT/OWNER 뷰로 분기하고, 공통 섹션(알림 피드·채팅 요약)을 함께 렌더한다. 디자인 토큰(`app/globals.css`)·프리미티브를 사용한다.

**Tech Stack:** Next.js 16(App Router, Server Components) · React 19 · TypeScript · Tailwind v4 · Vitest+RTL(프리미티브 단위 테스트).

**근거:** 디자인 시스템 `docs/superpowers/specs/2026-06-22-design-system-design.md`, 페이지 인벤토리(온보딩 스펙 §3), API는 README §7. 온보딩 PR에서 만든 `lib/{constants,messages,session,api}.ts`·`components/ui/{button,field}.tsx`를 재사용/확장한다.

## 스코프 (YAGNI)
- **포함**: 역할별 1차 카드(TENANT=내 계약 / OWNER=내 건물), 알림 미읽음 배지 + 최근 소식 피드(`GET /notifications`), 채팅 요약(`GET /chat/rooms`), 빠른 액션 링크, 빈/에러 상태.
- **제외**: 임대료/결제(스펙 8.2 범위 밖), 매너온도(API 근거 없음), 실시간 WS 구독(알림/채팅 소켓은 FE-M5/M4에서). 대시보드는 진입 시 1회 서버 페치로 충분.

## 선행(선택, 권장) — 백엔드 보강
`GET /me/leases`는 현재 `{id, unitId, status}`만 반환해 **건물/호실 이름이 없다**. tenant 홈에서 "○○ 102동 1503호" 같은 표시를 하려면 백엔드에서 lease에 `buildingName`/`unitName`을 포함해주는 보강이 필요하다(별도 백엔드 플랜). **이 FE 플랜은 이름이 없을 때도 degrade**(호실 식별자/상태만 표시)하도록 설계하며, 보강 시 이름을 채운다.

---

## 파일 구조 (estate-web `web/` 내부)

```
lib/
  api.ts            # (확장) 인증 서버 페치 헬퍼: me/leases/buildings/notifications/chatRooms
  dashboard.ts      # (신규) 서버 데이터 로더: 토큰→role별 집계 페치
components/ui/
  card.tsx          # Card/Surface
  chip.tsx          # 상태 Chip(success/neutral/warning)
  stat.tsx          # StatValue(display 숫자)
  list-row.tsx      # 아이콘+제목/설명+메타 (피드 공용)
  empty-state.tsx   # 빈 화면
  app-shell.tsx     # 상단 앱바(로고·알림 배지·아바타)
components/dashboard/
  recent-activity.tsx  # 최근 소식(notifications)
  chat-summary.tsx     # 채팅 요약(chat rooms)
  tenant-home.tsx      # TENANT 뷰
  owner-home.tsx       # OWNER 뷰
app/dashboard/page.tsx  # (대체) 서버 컴포넌트 진입점
```

> 명령어: `npm test`(Vitest), `npm run build`, `npm run lint`. 작업 위치 `estate-server/web`(estate-web 레포), 브랜치 `feat/dashboard-home`.

---

## Task 1: 인증 서버 페치 헬퍼 (lib/api.ts 확장)

**Files:** Modify `web/lib/api.ts` · Test `web/lib/api.test.ts`

- [ ] **Step 1: 실패 테스트(인증 헬퍼 에러 매핑)**

`web/lib/api.test.ts`에 추가:
```typescript
import { backendMe } from "@/lib/api";
it("401이면 ApiError 던짐(인증 만료)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  await expect(backendMe("badtoken")).rejects.toMatchObject({ status: 401 });
});
```
Run: `npm test -- api` → FAIL.

- [ ] **Step 2: 구현 — 인증 GET 헬퍼들**

`web/lib/api.ts`에 추가(기존 `call`/`ApiError` 재사용; Authorization 부착). 응답 타입은 README §7 기준 최소 정의이며, **정확한 필드는 서버 `/docs-json`(Swagger)으로 확인해 맞춘다**:
```typescript
import { MESSAGES } from "./messages";

function authGet<T>(path: string, token: string) {
  return call<T>(path, { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    { 401: MESSAGES.auth.invalidCredentials });
}

export type Me = { id: string; email: string; role: "OWNER" | "TENANT" | "ADMIN" };
export type Lease = { id: string; unitId: string; status: "ACTIVE" | "ENDED" };
export type Building = { id: string; name: string; address: string };
export type Notification = { id: string; type: string; payload: Record<string, unknown>; readAt: string | null; createdAt?: string };
export type ChatRoom = { id: string; buildingId?: string };

export const backendMe = (t: string) => authGet<Me>("/auth/me", t);
export const backendMyLeases = (t: string) => authGet<Lease[]>("/me/leases", t);
export const backendMyBuildings = (t: string) => authGet<Building[]>("/buildings", t);
export const backendNotifications = (t: string, limit = 5) => authGet<Notification[]>(`/notifications?limit=${limit}`, t);
export const backendUnreadCount = (t: string) => authGet<{ count: number }>("/notifications/unread-count", t);
export const backendChatRooms = (t: string) => authGet<ChatRoom[]>("/chat/rooms", t);
```
> `/notifications/unread-count` 응답 키(`count` 등)와 `Notification`/`ChatRoom` 필드는 Swagger로 확인 후 타입을 정확히 맞춘다.

- [ ] **Step 3:** Run `npm test -- api` → PASS.
- [ ] **Step 4: 커밋**
```bash
git add lib/api.ts lib/api.test.ts
git commit -m "feat: 대시보드용 인증 서버 페치 헬퍼(me/leases/buildings/notifications/chat)"
```

---

## Task 2: UI 프리미티브 (Card · Chip · StatValue · ListRow · EmptyState)

**Files:** Create `web/components/ui/{card,chip,stat,list-row,empty-state}.tsx` · Test `web/components/ui/card.test.tsx`

- [ ] **Step 1: 실패 테스트(대표 1개)**
`web/components/ui/card.test.tsx`:
```typescript
import { render, screen } from "@testing-library/react";
import { Card } from "@/components/ui/card";
it("children을 surface 카드로 렌더", () => {
  render(<Card>내용</Card>);
  expect(screen.getByText("내용").closest("div")?.className).toContain("rounded-");
});
```
Run: `npm test -- card` → FAIL.

- [ ] **Step 2: 구현(디자인 토큰 사용)**
`card.tsx`:
```tsx
export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[20px] border border-border bg-surface p-5 shadow-[var(--shadow-card)] ${className}`}>{children}</div>;
}
```
`chip.tsx`:
```tsx
type Tone = "success" | "neutral" | "warning";
const tones: Record<Tone, string> = {
  success: "bg-brand-50 text-brand-600",
  neutral: "bg-surface-2 text-text-2",
  warning: "bg-[var(--warning-bg)] text-warning",
};
export function Chip({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-bold ${tones[tone]}`}>{children}</span>;
}
```
`stat.tsx`:
```tsx
export function StatValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[13px] text-text-2">{label}</div>
      <div className="mt-0.5 text-[28px] font-extrabold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}
```
`list-row.tsx`:
```tsx
export function ListRow({ title, desc, meta }: { title: string; desc?: string; meta?: string }) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-text">{title}</div>
        {desc && <div className="mt-0.5 truncate text-[13px] text-text-2">{desc}</div>}
      </div>
      {meta && <span className="shrink-0 text-[12px] text-text-3">{meta}</span>}
    </div>
  );
}
```
`empty-state.tsx`:
```tsx
export function EmptyState({ text }: { text: string }) {
  return <div className="py-10 text-center text-[14px] text-text-3">{text}</div>;
}
```
Run: `npm test -- card` → PASS.

- [ ] **Step 3: 커밋**
```bash
git add components/ui/card.tsx components/ui/chip.tsx components/ui/stat.tsx components/ui/list-row.tsx components/ui/empty-state.tsx components/ui/card.test.tsx
git commit -m "feat: 대시보드 UI 프리미티브(Card/Chip/StatValue/ListRow/EmptyState)"
```

---

## Task 3: AppShell (상단 앱바)

**Files:** Create `web/components/ui/app-shell.tsx`

- [ ] **Step 1: 구현(로고·알림 배지·아바타)**
`app-shell.tsx`:
```tsx
import Link from "next/link";

export function AppShell({ unread, userInitial, children }: { unread: number; userInitial: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-border bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 px-5 py-3.5">
          <Link href="/dashboard" className="flex items-center gap-2 font-extrabold text-[18px]">
            <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-brand-500 text-white">터</span>터전
          </Link>
          <div className="flex-1" />
          <Link href="/notifications" className="relative grid h-10 w-10 place-items-center rounded-xl text-text-2 hover:bg-surface-2" aria-label="알림">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M10 20a2 2 0 004 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warm" />}
          </Link>
          <div className="grid h-9 w-9 place-items-center rounded-full bg-brand-500 text-[14px] font-bold text-white">{userInitial}</div>
        </div>
      </header>
      <main className="mx-auto max-w-[760px] px-5 pb-16 pt-6">{children}</main>
    </div>
  );
}
```
> `bg-warm` 유틸이 토큰 매핑(`--color-warm`)으로 존재함(온보딩 시 globals.css에 매핑). 없으면 `bg-[var(--accent-warm)]`로 대체.

- [ ] **Step 2:** `npm run build` → 컴파일 확인. **커밋**
```bash
git add components/ui/app-shell.tsx
git commit -m "feat: AppShell 상단 앱바(로고·알림 배지·아바타)"
```

---

## Task 4: 서버 데이터 로더 (lib/dashboard.ts)

**Files:** Create `web/lib/dashboard.ts`

- [ ] **Step 1: 구현 — role별 병렬 페치 + 안전 degrade**
`lib/dashboard.ts`:
```typescript
import "server-only";
import { backendMe, backendMyLeases, backendMyBuildings, backendNotifications, backendUnreadCount, backendChatRooms, type Me, type Lease, type Building, type Notification, type ChatRoom } from "./api";

export type DashboardData = {
  me: Me;
  unread: number;
  notifications: Notification[];
  chatRooms: ChatRoom[];
  leases: Lease[];      // TENANT
  buildings: Building[]; // OWNER
};

/** 일부 페치가 실패해도 홈 전체가 깨지지 않도록 개별 try/catch로 degrade */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

export async function loadDashboard(token: string): Promise<DashboardData> {
  const me = await backendMe(token); // 실패(401)면 호출부가 /login으로 보냄
  const [unreadRes, notifications, chatRooms, leases, buildings] = await Promise.all([
    safe(backendUnreadCount(token), { count: 0 }),
    safe(backendNotifications(token, 5), [] as Notification[]),
    safe(backendChatRooms(token), [] as ChatRoom[]),
    me.role === "TENANT" ? safe(backendMyLeases(token), [] as Lease[]) : Promise.resolve([] as Lease[]),
    me.role === "OWNER" ? safe(backendMyBuildings(token), [] as Building[]) : Promise.resolve([] as Building[]),
  ]);
  return { me, unread: unreadRes.count, notifications, chatRooms, leases, buildings };
}
```

- [ ] **Step 2:** `npm run build` → 확인. **커밋**
```bash
git add lib/dashboard.ts
git commit -m "feat: 대시보드 서버 데이터 로더(role별 집계 + degrade)"
```

---

## Task 5: 공통 섹션 — 최근 소식 · 채팅 요약

**Files:** Create `web/components/dashboard/{recent-activity,chat-summary}.tsx`

- [ ] **Step 1: 구현**
`recent-activity.tsx` (notifications 피드):
```tsx
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { EmptyState } from "@/components/ui/empty-state";
import type { Notification } from "@/lib/api";

const LABEL: Record<string, string> = {
  MessageSent: "새 메시지", PostCreated: "새 게시글", CommentCreated: "새 댓글", TenantJoined: "새 입주",
};
export function RecentActivity({ items }: { items: Notification[] }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 px-0.5 text-[16px] font-bold">최근 소식</h2>
      <Card className="p-0">
        {items.length === 0 ? <EmptyState text="아직 새 소식이 없어요." /> :
          <div className="divide-y divide-border px-4">
            {items.map((n) => (
              <ListRow key={n.id} title={LABEL[n.type] ?? n.type}
                desc={typeof n.payload?.preview === "string" ? n.payload.preview : undefined}
                meta={n.readAt ? undefined : "NEW"} />
            ))}
          </div>}
      </Card>
    </section>
  );
}
```
`chat-summary.tsx`:
```tsx
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import Link from "next/link";
import type { ChatRoom } from "@/lib/api";

export function ChatSummary({ rooms }: { rooms: ChatRoom[] }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between px-0.5">
        <h2 className="text-[16px] font-bold">채팅</h2>
        <Link href="/chat" className="text-[13px] text-text-3">모두 보기</Link>
      </div>
      <Card>
        {rooms.length === 0 ? <EmptyState text="진행 중인 대화가 없어요." />
          : <div className="text-[14px] text-text">진행 중인 대화 {rooms.length}개</div>}
      </Card>
    </section>
  );
}
```
> `payload.preview`는 백엔드 알림 payload 구조에 의존 — Swagger/실데이터로 키를 확인해 맞춘다(없으면 desc 생략).

- [ ] **Step 2:** `npm run build` → 확인. **커밋**
```bash
git add components/dashboard/recent-activity.tsx components/dashboard/chat-summary.tsx
git commit -m "feat: 대시보드 공통 섹션(최근 소식·채팅 요약)"
```

---

## Task 6: TENANT 뷰

**Files:** Create `web/components/dashboard/tenant-home.tsx` · Test `web/components/dashboard/tenant-home.test.tsx`

- [ ] **Step 1: 실패 테스트(mock 데이터 렌더)**
```tsx
import { render, screen } from "@testing-library/react";
import { TenantHome } from "@/components/dashboard/tenant-home";
it("ACTIVE 계약이 있으면 '입주 중' 노출", () => {
  render(<TenantHome leases={[{ id: "l1", unitId: "u1", status: "ACTIVE" }]} notifications={[]} chatRooms={[]} />);
  expect(screen.getByText(/입주 중/)).toBeInTheDocument();
});
```
Run → FAIL.

- [ ] **Step 2: 구현**
```tsx
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { RecentActivity } from "./recent-activity";
import { ChatSummary } from "./chat-summary";
import Link from "next/link";
import type { Lease, Notification, ChatRoom } from "@/lib/api";

export function TenantHome({ leases, notifications, chatRooms }: { leases: Lease[]; notifications: Notification[]; chatRooms: ChatRoom[] }) {
  const active = leases.filter((l) => l.status === "ACTIVE");
  return (
    <>
      <h1 className="mb-4 text-[22px] font-extrabold tracking-tight">내 계약</h1>
      <Card>
        {active.length === 0 ? <EmptyState text="활성화된 입주 계약이 없어요. 초대코드로 입주해보세요." /> :
          active.map((l) => (
            <div key={l.id} className="flex items-center justify-between">
              {/* 이름 보강 전: 호실 식별자 표시(선행 보강 시 buildingName/unitName으로 교체) */}
              <div className="text-[15px] font-semibold">호실 {l.unitId.slice(0, 8)}</div>
              <Chip tone="success">입주 중</Chip>
            </div>
          ))}
      </Card>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link href="/board" className="rounded-[14px] bg-surface-2 py-3 text-center text-[14px] font-semibold">공지·게시판</Link>
        <Link href="/chat" className="rounded-[14px] bg-surface-2 py-3 text-center text-[14px] font-semibold">1:1 채팅</Link>
      </div>
      <RecentActivity items={notifications} />
      <ChatSummary rooms={chatRooms} />
    </>
  );
}
```
Run → PASS. **커밋**
```bash
git add components/dashboard/tenant-home.tsx components/dashboard/tenant-home.test.tsx
git commit -m "feat: TENANT 대시보드 뷰(내 계약 + 빠른액션 + 소식/채팅)"
```

---

## Task 7: OWNER 뷰

**Files:** Create `web/components/dashboard/owner-home.tsx` · Test `web/components/dashboard/owner-home.test.tsx`

- [ ] **Step 1: 실패 테스트**
```tsx
import { render, screen } from "@testing-library/react";
import { OwnerHome } from "@/components/dashboard/owner-home";
it("건물 수를 StatValue로 노출", () => {
  render(<OwnerHome buildings={[{ id: "b1", name: "래미안", address: "서울" }]} notifications={[]} chatRooms={[]} />);
  expect(screen.getByText("1")).toBeInTheDocument();
});
```
Run → FAIL.

- [ ] **Step 2: 구현**
```tsx
import { Card } from "@/components/ui/card";
import { StatValue } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { RecentActivity } from "./recent-activity";
import { ChatSummary } from "./chat-summary";
import Link from "next/link";
import type { Building, Notification, ChatRoom } from "@/lib/api";

export function OwnerHome({ buildings, notifications, chatRooms }: { buildings: Building[]; notifications: Notification[]; chatRooms: ChatRoom[] }) {
  return (
    <>
      <h1 className="mb-4 text-[22px] font-extrabold tracking-tight">내 건물</h1>
      <Card><StatValue label="보유 건물" value={buildings.length} /></Card>
      <Card className="mt-3 p-0">
        {buildings.length === 0 ? <EmptyState text="등록된 건물이 없어요. 첫 건물을 등록하세요." /> :
          <div className="divide-y divide-border px-4">
            {buildings.map((b) => <ListRow key={b.id} title={b.name} desc={b.address} />)}
          </div>}
      </Card>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Link href="/buildings" className="rounded-[14px] bg-surface-2 py-3 text-center text-[13px] font-semibold">건물 관리</Link>
        <Link href="/invite-codes" className="rounded-[14px] bg-surface-2 py-3 text-center text-[13px] font-semibold">초대코드</Link>
        <Link href="/board" className="rounded-[14px] bg-surface-2 py-3 text-center text-[13px] font-semibold">게시판</Link>
      </div>
      <RecentActivity items={notifications} />
      <ChatSummary rooms={chatRooms} />
    </>
  );
}
```
Run → PASS. **커밋**
```bash
git add components/dashboard/owner-home.tsx components/dashboard/owner-home.test.tsx
git commit -m "feat: OWNER 대시보드 뷰(건물 현황 + 빠른액션 + 소식/채팅)"
```

---

## Task 8: 대시보드 페이지(서버 컴포넌트) — placeholder 대체

**Files:** Modify `web/app/dashboard/page.tsx`

- [ ] **Step 1: 구현**
```tsx
import { redirect } from "next/navigation";
import { getToken } from "@/lib/session";
import { loadDashboard } from "@/lib/dashboard";
import { AppShell } from "@/components/ui/app-shell";
import { TenantHome } from "@/components/dashboard/tenant-home";
import { OwnerHome } from "@/components/dashboard/owner-home";

export default async function DashboardPage() {
  const token = await getToken();
  if (!token) redirect("/login");

  let data;
  try {
    data = await loadDashboard(token);
  } catch {
    // me 실패 = 토큰 무효/만료
    redirect("/login");
  }

  const initial = data.me.email.charAt(0).toUpperCase();
  return (
    <AppShell unread={data.unread} userInitial={initial}>
      {data.me.role === "TENANT" ? (
        <TenantHome leases={data.leases} notifications={data.notifications} chatRooms={data.chatRooms} />
      ) : (
        <OwnerHome buildings={data.buildings} notifications={data.notifications} chatRooms={data.chatRooms} />
      )}
    </AppShell>
  );
}
```
> ADMIN은 현재 OWNER 뷰로 폴백(else 분기). FE-M1 범위에서 별도 ADMIN 홈은 만들지 않는다.

- [ ] **Step 2:** `npm run build` → 확인. **커밋**
```bash
git add app/dashboard/page.tsx
git commit -m "feat: /dashboard 역할 인지 홈(서버 페치) — placeholder 대체"
```

---

## Task 9: 마무리 — 검증

- [ ] **Step 1:** `cd web && npm run lint && npm test && npm run build` — 모두 통과.
- [ ] **Step 2(수동, 백엔드+docker 필요):** 로그인 후 `/dashboard` 진입 →
  - TENANT 계정: 내 계약(있으면 입주 중), 최근 소식, 채팅 요약 표시
  - OWNER 계정: 건물 수/목록, 빠른 액션, 소식/채팅 표시
  - 토큰 무효 시 `/login` 리다이렉트, `document.cookie`에 토큰 미노출
- [ ] **Step 3:** push + PR(estate-web). 머지 후 부모 서브모듈 포인터 갱신.

---

## 성공 기준
- `/dashboard`가 role(`/auth/me`)에 따라 TENANT/OWNER 뷰로 분기 렌더.
- 데이터는 **서버에서** httpOnly 토큰으로 페치(클라이언트에 토큰/Authorization 노출 없음).
- 일부 엔드포인트 실패(빈 데이터/권한)에도 홈 전체가 깨지지 않고 빈 상태로 degrade.
- 알림 미읽음 배지 + 최근 소식 피드(`/notifications`) + 채팅 요약 표시.

## 후속(별도 플랜)
- 백엔드: `/me/leases`에 building/unit 이름 포함(tenant 홈 이름 표시).
- FE-M2~: 건물·호실·초대코드 관리, 게시판, 채팅(WS), 알림 센터(실시간).
