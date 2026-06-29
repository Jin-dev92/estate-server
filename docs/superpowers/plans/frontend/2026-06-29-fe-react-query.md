# FE React Query 선택적 도입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 클라이언트 뮤테이션의 useState 보일러플레이트를 useMutation으로 없애고, 알림 도메인의 클라 상태를 react-query 캐시로 일원화한다.

**Architecture:** QueryClientProvider를 root layout에 1회 마운트. 명령형 버튼 4종을 useMutation으로 전환. 알림은 layout이 서버에서 받은 unread/list를 `initialData`로 시드하고, 소켓 수신·읽음 뮤테이션이 `setQueryData`/`invalidateQueries`로 캐시를 갱신하는 단일 경로로 재편. 서버 컴포넌트 읽기는 SSR 유지.

**Tech Stack:** Next.js 16 App Router · React 19 · @tanstack/react-query v5 · Vitest + Testing Library.

**스펙:** `docs/superpowers/specs/frontend/2026-06-29-fe-react-query-design.md`

## Global Constraints

- `.ts`/`.tsx`만. `"use client"`는 상호작용 컴포넌트에만. 서버 컴포넌트 읽기(`lib/api`)는 native fetch 유지.
- 매직 스트링 금지: 경로 `PAGE_ROUTES`/`API_ROUTES`(`lib/constants.ts`), 문구 `MESSAGES`(`lib/messages.ts`), 쿼리키는 `lib/query/keys.ts` 팩토리.
- `enum` 금지(as const), `as any` 금지, index signature 금지. `useEffect` deps 원시값만.
- 토큰을 클라이언트에서 직접 다루지 않는다. 클라 mutation/query는 same-origin `/api/*` Route Handler 경유. 소켓 토큰 prop만 예외(기존 유지, `NEXT_PUBLIC_` 노출 금지).
- 테스트: Vitest. RTL 테스트는 `QueryClientProvider` 래퍼 필요. 실행 `pnpm test`, 빌드 `pnpm build`, 린트 `pnpm lint`.
- 커밋 형식: `type: 내용`(feature/refactor/test/chore). 패키지 매니저 **pnpm**.

**Before you start:** estate-web `feature/fe-react-query` 브랜치(origin/main 기준). BE 변경 없음.

---

### Task 1: react-query 인프라 (Provider + 쿼리키 + 테스트 유틸)

**Files:**
- Modify: `package.json` (deps: `@tanstack/react-query`)
- Create: `app/providers.tsx`
- Modify: `app/layout.tsx`
- Create: `lib/query/keys.ts`
- Create: `lib/query/keys.test.ts`
- Create: `test/query-wrapper.tsx` (RTL 헬퍼)

**Interfaces:**
- Produces: `<Providers>{children}</Providers>` (client) — QueryClientProvider 래퍼
- Produces: `qk = { notifications: { list(): ["notifications","list"], unreadCount(): ["notifications","unread-count"] } }`
- Produces: `renderWithClient(ui)` — 테스트에서 새 QueryClient로 감싸 render

- [ ] **Step 1: 의존성 설치**

Run: `pnpm add @tanstack/react-query`
Expected: `package.json` dependencies에 `@tanstack/react-query` 추가, `pnpm-lock.yaml` 갱신.

- [ ] **Step 2: 쿼리키 팩토리 실패 테스트** — `lib/query/keys.test.ts`

```ts
import { qk } from "@/lib/query/keys";

it("notifications 쿼리키 팩토리", () => {
  expect(qk.notifications.list()).toEqual(["notifications", "list"]);
  expect(qk.notifications.unreadCount()).toEqual(["notifications", "unread-count"]);
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm test -- keys`
Expected: FAIL (`@/lib/query/keys` 모듈 없음)

- [ ] **Step 4: 쿼리키 팩토리 구현** — `lib/query/keys.ts`

```ts
// 쿼리키 단일 출처(매직 문자열 금지). as const로 키 튜플 타입 고정.
export const qk = {
  notifications: {
    list: () => ["notifications", "list"] as const,
    unreadCount: () => ["notifications", "unread-count"] as const,
  },
} as const;
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm test -- keys`
Expected: PASS (1 test)

- [ ] **Step 6: Providers 작성** — `app/providers.tsx`

```tsx
"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: React.ReactNode }) {
  // 클라이언트당 1회 생성(렌더마다 새로 만들지 않도록 useState 초기화 함수 사용).
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 7: root layout에 Providers 마운트** — `app/layout.tsx`

`import "./globals.css";` 아래에 `import { Providers } from "./providers";` 추가하고, `<body ...>` 자식을 `<Providers>`로 감싼다:
```tsx
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
```

- [ ] **Step 8: 테스트 래퍼 헬퍼** — `test/query-wrapper.tsx`

```tsx
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

// 테스트마다 격리된 QueryClient(retry off)로 컴포넌트를 감싸 render.
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}
```

- [ ] **Step 9: 빌드·lint·test 확인**

Run: `pnpm test -- keys && pnpm build && pnpm lint`
Expected: keys 1 PASS, 빌드 성공(전 라우트 정상), lint 클린.

- [ ] **Step 10: 커밋**

```bash
git add package.json pnpm-lock.yaml app/providers.tsx app/layout.tsx lib/query/keys.ts lib/query/keys.test.ts test/query-wrapper.tsx
git commit -m "feature: react-query 인프라(Provider·쿼리키·테스트 래퍼) 추가"
```

---

### Task 2: 독립 명령형 버튼 useMutation 전환 (start-chat · logout)

알림 캐시와 무관한 버튼 2종을 먼저 전환해 useMutation 패턴을 확립한다.

**Files:**
- Create: `lib/query/mutations/chat.ts`
- Modify: `components/chat/start-chat-button.tsx`
- Modify: `components/chat/start-chat-button.test.tsx`
- Modify: `components/settings/logout-button.tsx`
- Modify: `components/settings/logout-button.test.tsx`

**Interfaces:**
- Consumes: `renderWithClient`(Task 1), `API_ROUTES`/`PAGE_ROUTES`/`MESSAGES`.
- Produces: `useEnsureRoom()` → `useMutation` returning `{ mutate, isPending, error }`, mutationFn POST `/api/chat/rooms`.

- [ ] **Step 1: ensure-room 뮤테이션 훅** — `lib/query/mutations/chat.ts`

```ts
"use client";

import { useMutation } from "@tanstack/react-query";
import { API_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

type EnsureRoomInput = { buildingId: string; tenantId: string };
type EnsureRoomResult = { id: string };

// POST /api/chat/rooms 프록시. 실패 시 서버 메시지(없으면 기본 카피)로 throw.
async function ensureRoom(input: EnsureRoomInput): Promise<EnsureRoomResult> {
  const res = await fetch(API_ROUTES.chatRooms, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.message ?? MESSAGES.chat.startFailed);
  }
  return res.json();
}

export function useEnsureRoom() {
  return useMutation({ mutationFn: ensureRoom });
}
```

- [ ] **Step 2: start-chat-button 전환** — `components/chat/start-chat-button.tsx` 전체 교체

```tsx
"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PAGE_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";
import { useEnsureRoom } from "@/lib/query/mutations/chat";

export function StartChatButton({
  buildingId,
  tenantId,
  label,
}: {
  buildingId: string;
  tenantId: string;
  label: string;
}) {
  const router = useRouter();
  const { mutate, isPending, error } = useEnsureRoom();

  function start() {
    mutate(
      { buildingId, tenantId },
      { onSuccess: (room) => router.push(PAGE_ROUTES.chatRoom(room.id)) },
    );
  }

  return (
    <div className="mt-4">
      <Button onClick={start} disabled={isPending}>
        {isPending ? MESSAGES.chat.starting : label}
      </Button>
      {error && <p className="mt-2 text-[13px] text-danger">{error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 3: start-chat-button 테스트 갱신** — `components/chat/start-chat-button.test.tsx`

`render(...)`를 `renderWithClient(...)`로 바꾸고 import 추가. 기존 단언(성공 시 `/chat/r9` push, 실패 시 에러 메시지 노출)은 유지. 교체 전체:
```tsx
import { vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithClient } from "@/test/query-wrapper";
import { StartChatButton } from "@/components/chat/start-chat-button";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  push.mockReset();
});

it("성공 시 생성된 방으로 이동한다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "r9" }), { status: 201 })));
  renderWithClient(<StartChatButton buildingId="b1" tenantId="t1" label="문의하기" />);
  fireEvent.click(screen.getByText("문의하기"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/r9"));
});

it("실패 시 에러 메시지를 표시한다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "권한 없음" }), { status: 403 })));
  renderWithClient(<StartChatButton buildingId="b1" tenantId="t1" label="문의하기" />);
  fireEvent.click(screen.getByText("문의하기"));
  await waitFor(() => expect(screen.getByText("권한 없음")).toBeInTheDocument());
  expect(push).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: logout-button 전환** — `components/settings/logout-button.tsx` 전체 교체

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { API_ROUTES, PAGE_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export function LogoutButton() {
  const router = useRouter();
  const { mutate, isPending } = useMutation({
    mutationFn: () => fetch(API_ROUTES.session, { method: "DELETE" }),
    onSuccess: () => {
      router.push(PAGE_ROUTES.login);
      router.refresh();
    },
  });

  return (
    <Button variant="secondary" onClick={() => mutate()} disabled={isPending}>
      {MESSAGES.settings.logout}
    </Button>
  );
}
```

- [ ] **Step 5: logout-button 테스트 갱신** — `components/settings/logout-button.test.tsx`

`render`를 `renderWithClient`로 교체(import 추가). 기존 단언(DELETE 호출 + `/login` push) 유지:
```tsx
import { vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithClient } from "@/test/query-wrapper";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { LogoutButton } from "@/components/settings/logout-button";

afterEach(() => { vi.unstubAllGlobals(); push.mockReset(); });

it("DELETE /api/session 후 로그인으로 이동", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  renderWithClient(<LogoutButton />);
  fireEvent.click(screen.getByText("로그아웃"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
});
```

- [ ] **Step 6: 테스트·빌드·lint**

Run: `pnpm test -- start-chat-button logout-button && pnpm build && pnpm lint`
Expected: 3 PASS, 빌드 성공, lint 클린.

- [ ] **Step 7: 커밋**

```bash
git add lib/query/mutations/chat.ts components/chat/start-chat-button.tsx components/chat/start-chat-button.test.tsx components/settings/logout-button.tsx components/settings/logout-button.test.tsx
git commit -m "refactor: start-chat·logout 버튼을 useMutation으로 전환(useState 제거)"
```

---

### Task 3: invite-code-card useMutation 전환

결과 표시 상태(code·expiresInSec·copied)는 로컬 유지하고 loading/error만 mutation으로 옮긴다.

**Files:**
- Create: `lib/query/mutations/invite.ts`
- Modify: `components/building/invite-code-card.tsx`

**Interfaces:**
- Produces: `useIssueInviteCode(unitId)` → `useMutation` returning `{ mutateAsync, isPending, error }`, mutationFn POST `/api/units/:id/invite-codes` → `{ code, expiresInSec }`.

- [ ] **Step 1: 초대코드 발급 뮤테이션 훅** — `lib/query/mutations/invite.ts`

```ts
"use client";

import { useMutation } from "@tanstack/react-query";
import { API_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

type IssueResult = { code: string; expiresInSec: number };

export function useIssueInviteCode(unitId: string) {
  return useMutation({
    mutationFn: async (): Promise<IssueResult> => {
      const res = await fetch(API_ROUTES.unitInviteCodes(unitId), { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? MESSAGES.invite.issueFailed);
      }
      return res.json();
    },
  });
}
```

- [ ] **Step 2: invite-code-card 전환** — `components/building/invite-code-card.tsx` 전체 교체

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/messages";
import { useIssueInviteCode } from "@/lib/query/mutations/invite";

export function InviteCodeCard({ unitId }: { unitId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresInSec, setExpiresInSec] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const { mutate, isPending, error } = useIssueInviteCode(unitId);

  function issue() {
    mutate(undefined, {
      onSuccess: (data) => {
        setCode(data.code);
        setExpiresInSec(data.expiresInSec);
      },
    });
  }

  async function copyCode() {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const shareLink =
    typeof window !== "undefined" && code
      ? `${window.location.origin}/invite?code=${encodeURIComponent(code)}`
      : null;

  async function copyLink() {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      {!code ? (
        <Button variant="secondary" onClick={issue} disabled={isPending}>
          {isPending ? "발급 중…" : "초대코드 발급"}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="rounded-[12px] bg-surface-2 px-4 py-3 text-center font-mono text-[18px] font-bold tracking-widest text-text">
            {code}
          </div>
          {expiresInSec !== null && (
            <p className="text-center text-[12px] text-text-3">
              {Math.floor(expiresInSec / 60)}분 후 만료
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={copyCode} className="flex-1">
              {copied ? "복사됨!" : "코드 복사"}
            </Button>
            <Button variant="ghost" onClick={copyLink} className="flex-1">
              링크 복사
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-center text-[13px] text-danger">{error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 3: 빌드·lint·test**

Run: `pnpm build && pnpm lint && pnpm test`
Expected: 빌드 성공, lint 클린, 전체 테스트 PASS(이 컴포넌트는 기존 단위 테스트 없음).

- [ ] **Step 4: 커밋**

```bash
git add lib/query/mutations/invite.ts components/building/invite-code-card.tsx
git commit -m "refactor: invite-code-card loading/error를 useMutation으로 전환"
```

---

### Task 4: 알림 캐시 일원화 (provider · list · mark-all · bell)

알림 클라 상태를 react-query 캐시 단일 출처로 모은다. layout이 서버에서 받은 list/unread를 `initialData`로 시드, 소켓·읽음 뮤테이션이 `setQueryData`/`invalidate`로 갱신.

**Files:**
- Create: `lib/query/notifications.ts` (시드 훅 + 캐시 헬퍼)
- Modify: `app/(app)/layout.tsx` (서버 list/unread를 provider에 prop으로)
- Modify: `components/notifications/notification-provider.tsx` (소켓→setQueryData, context 축소)
- Modify: `app/(app)/notifications/page.tsx` (initial prop 유지·전달)
- Modify: `components/notifications/notification-list.tsx` (useQuery 캐시 + 단건읽음 useMutation)
- Modify: `components/notifications/mark-all-read-button.tsx` (useMutation + invalidate)
- Modify: `components/ui/notification-bell.tsx` (unreadCount useQuery 파생)
- Modify: `components/notifications/mark-all-read-button.test.tsx`

**Interfaces:**
- Consumes: `qk`(Task 1), `Notification`(`@/lib/api`), `renderWithClient`.
- Produces: `useNotificationsQuery(initial)` → `useQuery({ queryKey: qk.notifications.list(), initialData })`.
- Produces: `useUnreadCountQuery(initial)` → `useQuery({ queryKey: qk.notifications.unreadCount(), initialData })`.
- Produces: provider가 `token`·`initialList`·`initialUnread`를 받아 캐시 시드 + 소켓 연결.

> **설계 메모(구현자 필독):** 클라이언트는 알림 목록을 백엔드에서 직접 refetch하지 않는다(토큰 노출 금지). 캐시는 `initialData`로 시드되고 이후 소켓 `setQueryData`·뮤테이션 갱신으로만 변한다 → list/unread 쿼리에 `queryFn`을 두지 않고 `staleTime: Infinity`로 둔다(refetch 비활성). 스펙 §6의 "GET /api/notifications 신설"은 이 방식에서 **불필요** → 만들지 않는다.

- [ ] **Step 1: 알림 쿼리 시드 훅** — `lib/query/notifications.ts`

```ts
"use client";

import { useQuery } from "@tanstack/react-query";
import type { Notification } from "@/lib/api";
import { qk } from "@/lib/query/keys";

// 캐시는 서버가 준 initialData로만 시드되고, 소켓·뮤테이션이 setQueryData로 갱신한다.
// queryFn 없음 + staleTime Infinity → 클라가 백엔드를 직접 refetch하지 않는다(토큰 비노출).
export function useNotificationsQuery(initial: Notification[]) {
  return useQuery({
    queryKey: qk.notifications.list(),
    queryFn: () => Promise.resolve(initial),
    initialData: initial,
    staleTime: Infinity,
  });
}

export function useUnreadCountQuery(initial: number) {
  return useQuery({
    queryKey: qk.notifications.unreadCount(),
    queryFn: () => Promise.resolve(initial),
    initialData: initial,
    staleTime: Infinity,
  });
}
```

- [ ] **Step 2: provider 재편** — `components/notifications/notification-provider.tsx` 전체 교체

```tsx
"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import type { Notification } from "@/lib/api";
import { WS_URL } from "@/lib/chat/ws";
import { qk } from "@/lib/query/keys";

// 소켓 수신 알림을 react-query 캐시(list/unreadCount)에 직접 쓴다. 별도 context state 없음.
export function NotificationProvider({
  token,
  children,
}: {
  token: string;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(`${WS_URL}/notifications`, {
      auth: { token },
      transports: ["websocket"],
    });
    socketRef.current = socket;
    socket.on("notification", (n: Notification) => {
      queryClient.setQueryData<Notification[]>(qk.notifications.list(), (prev = []) =>
        prev.some((x) => x.id === n.id) ? prev : [n, ...prev],
      );
      queryClient.setQueryData<number>(qk.notifications.unreadCount(), (c = 0) => c + 1);
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, queryClient]);

  return <>{children}</>;
}
```

- [ ] **Step 3: (app) layout — 서버 list/unread를 캐시 시드용으로 전달** — `app/(app)/layout.tsx`

`backendNotifications`를 import에 추가하고, unread와 함께 목록도 서버에서 받아 provider에 prop으로 넘긴다. provider는 이제 `initialUnread` 대신 캐시를 직접 시드하므로, **목록 시드는 notifications page에서** 하고 layout은 unread 배지 시드만 담당하도록 분리한다(아래 §메모). 변경:

import 추가:
```tsx
import { backendNotifications, backendMe, backendUnreadCount } from "@/lib/api";
```
provider 마운트를 `token`만 넘기도록 바꾸고, unread 배지 시드를 위해 `NotificationBell`에 `initialUnread`를 내려준다:
```tsx
  let initialUnread = 0;
  try {
    initialUnread = (await backendUnreadCount(token)).count;
  } catch {
    initialUnread = 0;
  }
  // ...
    <NotificationProvider token={token}>
      ...
            <NotificationBell initialUnread={initialUnread} />
      ...
    </NotificationProvider>
```
(목록 `initialData`는 notifications page가 담당 — layout은 목록을 안 받는다. `backendNotifications` import는 page에서만 쓰면 layout에서 빼도 됨 → 실제 적용 시 layout에는 추가하지 말고 page만 사용.)

> 구현 메모: 위 import 줄은 page용이다. **layout.tsx는 `backendUnreadCount`만** 쓰면 되므로 기존 import 유지하고 `backendNotifications`는 추가하지 않는다. provider props에서 `initialUnread` 제거.

- [ ] **Step 4: notifications page — 목록 initialData 시드** — `app/(app)/notifications/page.tsx`

서버에서 받은 `items`를 `NotificationList`에 그대로 prop(`initial`)으로 전달(현행 유지). `NotificationList`가 이를 `initialData`로 캐시 시드한다. 변경 없음(현재도 `initial={items}` 전달) — 단 `MarkAllReadButton`은 props 그대로.

- [ ] **Step 5: bell — unreadCount 쿼리 파생** — `components/ui/notification-bell.tsx` 전체 교체

```tsx
"use client";

import Link from "next/link";
import { PAGE_ROUTES } from "@/lib/constants";
import { useUnreadCountQuery } from "@/lib/query/notifications";

export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const { data: unread = 0 } = useUnreadCountQuery(initialUnread);
  return (
    <Link
      href={PAGE_ROUTES.notifications}
      className="relative grid h-10 w-10 place-items-center rounded-xl text-text-2 hover:bg-surface-2"
      aria-label="알림"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 20a2 2 0 004 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-warm px-1 text-[10px] font-bold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
```

- [ ] **Step 6: notification-list — useQuery 캐시 + 단건읽음 useMutation** — `components/notifications/notification-list.tsx` 전체 교체

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@/lib/api";
import { API_ROUTES } from "@/lib/constants";
import { qk } from "@/lib/query/keys";
import { notificationHref } from "@/lib/notifications/notification-link";
import { useNotificationsQuery } from "@/lib/query/notifications";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES } from "@/lib/messages";

export function NotificationList({ initial }: { initial: Notification[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: items = [] } = useNotificationsQuery(initial);

  const markOne = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(API_ROUTES.notificationRead(id), { method: "PATCH" });
      if (!res.ok) throw new Error(MESSAGES.notification.markFailed);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<Notification[]>(qk.notifications.list(), (prev = []) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
      );
      queryClient.setQueryData<number>(qk.notifications.unreadCount(), (c = 0) => Math.max(0, c - 1));
    },
  });

  function open(n: Notification) {
    if (!n.readAt) markOne.mutate(n.id);
    router.push(notificationHref(n));
  }

  if (items.length === 0) return <EmptyState text={MESSAGES.notification.empty} />;

  return (
    <Card className="p-0">
      <div className="divide-y divide-border px-4">
        {items.map((n) => {
          const unread = !n.readAt;
          return (
            <button key={n.id} onClick={() => open(n)} className="flex w-full items-start gap-3 py-3.5 text-left hover:bg-surface-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-text">{n.title}</span>
                  {unread && <span className="h-1.5 w-1.5 rounded-full bg-warm" />}
                </div>
                {n.body && <div className="mt-0.5 truncate text-[13px] text-text-2">{n.body}</div>}
              </div>
              <span className="shrink-0 text-[12px] text-text-3">{new Date(n.createdAt).toLocaleDateString("ko-KR")}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
```

- [ ] **Step 7: mark-all-read-button — useMutation + 캐시 갱신** — `components/notifications/mark-all-read-button.tsx` 전체 교체

```tsx
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@/lib/api";
import { API_ROUTES } from "@/lib/constants";
import { qk } from "@/lib/query/keys";
import { MESSAGES } from "@/lib/messages";

export function MarkAllReadButton() {
  const queryClient = useQueryClient();
  const { mutate, isPending, error } = useMutation({
    mutationFn: async () => {
      const res = await fetch(API_ROUTES.notificationsRead, { method: "PATCH" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? MESSAGES.notification.markFailed);
      }
    },
    onSuccess: () => {
      const now = new Date().toISOString();
      queryClient.setQueryData<Notification[]>(qk.notifications.list(), (prev = []) =>
        prev.map((n) => (n.readAt ? n : { ...n, readAt: now })),
      );
      queryClient.setQueryData<number>(qk.notifications.unreadCount(), 0);
    },
  });

  return (
    <div className="text-right">
      <button onClick={() => mutate()} disabled={isPending} className="text-[13px] font-semibold text-brand-600 disabled:opacity-50">
        {MESSAGES.notification.markAll}
      </button>
      {error && <p className="mt-1 text-[13px] text-danger">{error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 8: mark-all-read-button 테스트 갱신** — `components/notifications/mark-all-read-button.test.tsx`

provider mock 제거(이제 useNotifications 안 씀), `renderWithClient` 사용. 성공 시 카운트 캐시가 0이 되는지 또는 버튼 동작을 검증:
```tsx
import { vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithClient } from "@/test/query-wrapper";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";

afterEach(() => vi.unstubAllGlobals());

it("성공 시 호출되고 에러 없음", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  renderWithClient(<MarkAllReadButton />);
  fireEvent.click(screen.getByText("모두 읽음"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
});

it("실패 시 에러 메시지 표시", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "처리하지 못했어요. 잠시 후 다시 시도해주세요." }), { status: 500 })));
  renderWithClient(<MarkAllReadButton />);
  fireEvent.click(screen.getByText("모두 읽음"));
  await waitFor(() => expect(screen.getByText("처리하지 못했어요. 잠시 후 다시 시도해주세요.")).toBeInTheDocument());
});
```

- [ ] **Step 9: useNotifications 잔여 참조 제거 확인**

Run: `grep -rn "useNotifications\|liveItems\|initialUnread={" components app | grep -v "\.test\."`
Expected: provider의 옛 context(`useNotifications`)·`liveItems` 참조가 남아있지 않음(bell은 `useUnreadCountQuery`, list는 `useNotificationsQuery` 사용). 남아있으면 정리.

- [ ] **Step 10: 전체 테스트·빌드·lint**

Run: `pnpm test && pnpm build && pnpm lint`
Expected: 전체 PASS, 빌드 성공(`/notifications` 등 라우트 정상), lint 클린.

- [ ] **Step 11: 수동 검증** (BE 실행 중)

1. 로그인 → 헤더 벨 배지가 서버 unread로 표시.
2. 다른 세션에서 알림 트리거 → 소켓 수신으로 벨 배지 +1, `/notifications` 목록 상단에 prepend.
3. 알림 클릭 → 단건 읽음(점 사라짐) + 배지 -1 + 딥링크 이동.
4. "모두 읽음" → 목록 미읽음 점 모두 사라지고 배지 0.

- [ ] **Step 12: 커밋**

```bash
git add lib/query/notifications.ts "app/(app)/layout.tsx" "app/(app)/notifications/page.tsx" components/notifications/notification-provider.tsx components/notifications/notification-list.tsx components/notifications/mark-all-read-button.tsx components/notifications/mark-all-read-button.test.tsx components/ui/notification-bell.tsx
git commit -m "feature: 알림 클라 상태를 react-query 캐시로 일원화(소켓→setQueryData·읽음 invalidate)"
```

---

## 마무리 (계획 외 후속)

- PR(estate-web `feature/fe-react-query`) 1건. 본문에 스펙·플랜 경로 첨부.
- 머지 후 web 서브모듈 포인터 갱신(estate-server).

## Self-Review 결과

- **스펙 커버리지:** §3 인프라→Task 1 / §4 useMutation(4버튼)→Task 2(start-chat·logout)·3(invite)·4(mark-all) / §5 알림 캐시 재편→Task 4 / §6 토큰(직접 refetch 안 함)→Task 4 메모(GET 핸들러 불필요로 확정) / §8 테스트→각 Task. 모두 매핑.
- **GET /api/notifications 신설 여부 확정:** initialData+setQueryData만으로 충분 → 신설 안 함(Task 4 메모). 스펙 §6/§10의 "필요 시 신설"을 "불필요"로 결론.
- **플레이스홀더:** 없음(모든 step에 코드/명령).
- **타입 일관성:** `qk.notifications.list()/unreadCount()`(Task 1) → Task 4 전체 사용 일치. `useNotificationsQuery`/`useUnreadCountQuery`(Task 4 Step 1) → list/bell 사용 일치. `useEnsureRoom`(Task 2)·`useIssueInviteCode`(Task 3) 시그니처 일관. `renderWithClient`(Task 1) → Task 2·4 테스트 사용. provider props: `token`만(initialUnread/initialList 제거) — bell이 `initialUnread`를 layout에서 직접 받음(Task 4 Step 3·5 일치).
- **주의(구현자):** Task 4 Step 3의 layout 변경은 "provider props에서 initialUnread 제거 + bell에 initialUnread 전달"이 핵심. notification-provider가 `useQueryClient`를 쓰므로 반드시 root Providers(Task 1) 하위에서 렌더된다(= (app) layout은 root layout 하위라 OK).
