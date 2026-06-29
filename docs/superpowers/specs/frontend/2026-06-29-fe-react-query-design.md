# FE Refactor: TanStack React Query 선택적 도입 설계

- 작성일: 2026-06-29
- 대상 레포: `estate-web`(FE 단독 — BE 변경 없음)
- 참조
  - 알림 센터: `docs/superpowers/specs/frontend/2026-06-23-fe-m5-notification-design.md`
  - 채팅(토큰 prop 소켓): `docs/superpowers/specs/frontend/2026-06-23-fe-m4-chat-design.md`

## 1. 목표 / 동기

클라이언트 뮤테이션의 `useState(loading)`·`useState(error)` **보일러플레이트를 제거**하고, 알림 도메인의 클라이언트 상태를 **react-query 캐시로 일원화**한다.

- [ ] `@tanstack/react-query` 인프라(QueryClientProvider + 쿼리키 팩토리)
- [ ] 명령형 버튼 4종을 `useMutation`으로 전환(수기 loading/error 제거)
- [ ] 알림 목록/미읽음을 `useQuery` 캐시로 관리, 소켓 수신분은 `setQueryData`로 병합
- [ ] 읽음(단건/전체) 뮤테이션이 캐시를 invalidate/갱신 → `router.refresh()`·수기 `decrement/reset/readIds` 제거
- [ ] build·lint·test 통과

## 2. 설계 원칙 — "필요한 부분만"

react-query는 두 가치를 각각 값이 나오는 곳에만 적용한다. 무차별 전환하지 않는다.

| react-query 기능 | 적용처 | 비적용(유지) |
|---|---|---|
| `useMutation`(loading/error) | 명령형 버튼(아래 §4) | RHF 폼(이미 `isSubmitting`) |
| `useQuery` + 캐시 + invalidate | 알림 도메인(§5) | 대시보드·게시판·건물·채팅 **서버 읽기(SSR 유지)** |

**Next.js 권장 준수:** Server Component의 읽기는 native `fetch` 기반 `lib/api/*`를 그대로 둔다(서버 캐시 통합·SSR·토큰 서버 보관). react-query는 **클라이언트 레이어에만** 들어간다.

## 3. 인프라

- 의존성: `@tanstack/react-query`(+ dev에서 `@tanstack/react-query-devtools` 선택).
- `app/providers.tsx`(client): `QueryClientProvider`로 children을 감싼다. `QueryClient`는 모듈 1회 생성(`new QueryClient({ defaultOptions: { queries: { staleTime, refetchOnWindowFocus: false } } })`) — 구체 옵션은 구현 계획에서 확정.
- `app/layout.tsx`(root Server Component): `<body>` 안에서 `<Providers>`로 children을 감싼다(전역 1회). 토큰을 client에 직접 넘기지 않는다(아래 §5 토큰 주의).
- `lib/query/keys.ts`: 쿼리키 팩토리(매직 문자열 금지).
  - `qk.notifications.list()` → `["notifications","list"]`
  - `qk.notifications.unreadCount()` → `["notifications","unread-count"]`

## 4. `useMutation` 전환 (보일러플레이트 제거)

대상 = **순수 명령형 버튼/액션**. 각 뮤테이션 함수는 `mutationFn`만 담은 재사용 훅(`lib/query/mutations/`)으로 분리하고, 컴포넌트는 `mutate()`·`isPending`·`error`만 사용한다. 호출 대상(Next Route Handler `/api/*`)과 카피(`MESSAGES`)는 그대로.

| 컴포넌트 | 현재 | 전환 후 |
|---|---|---|
| `mark-all-read-button` | `useState(loading)`+`useState(error)` | `useMutation` → `isPending`/`error`, 성공 시 알림 캐시 invalidate(§5) |
| `start-chat-button` | `useState(loading)`+`useState(error)` | `useMutation` → 성공 시 `router.push(chatRoom)` |
| `invite-code-card` | `useState(loading)`+`useState(error)`(+code/expiresInSec 결과 상태) | loading/error는 `useMutation`, **결과 표시 상태(code·expiresInSec·copied)는 로컬 유지** |
| `logout-button` | 상태 없음 | `useMutation`으로 일관화(`isPending`로 더블클릭 방지) — 선택 |

> RHF 폼(`profile/password/post/comment/building/unit-form`, signup, login)은 **변경하지 않는다**(이미 `isSubmitting`+`setError("root")`로 깔끔, react-query와 상태 이원화 회피).

## 5. 알림 도메인 캐시 재편 (가장 큰 변경)

현재 알림 클라 상태는 세 곳에 흩어져 있다: provider의 `unread`·`liveItems`, list의 `readIds`, 그리고 mutation 후 `router.refresh()`. 이를 **react-query 캐시 단일 출처**로 모은다.

### 5.1 데이터 흐름
- **초기 시드**: `app/(app)/notifications/page.tsx`(Server)가 `backendNotifications(token,50)`로 가져온 목록을 client `NotificationList`에 prop으로 전달 → `useQuery({ queryKey: qk.notifications.list(), initialData })`로 캐시에 시드(추가 네트워크 없음).
- **소켓 수신**: provider가 `notification` 이벤트 수신 시 **`queryClient.setQueryData(list, prepend)`** + unreadCount 캐시 +1. (현재 `liveItems` state 병합 로직을 캐시 쓰기로 대체.)
- **단건 읽음**: `NotificationList` 항목 클릭 → `useMutation`(PATCH `/api/notifications/:id/read`) → 성공 시 해당 항목 `readAt` 캐시 패치 + unreadCount 캐시 -1 → `notificationHref`로 이동. 현재의 수기 `readIds`·`decrement()` 제거.
- **전체 읽음**: `mark-all-read-button` 뮤테이션 성공 → list 캐시의 미읽음 일괄 read 처리 + unreadCount 0 → `invalidateQueries` 또는 `setQueryData`. 현재 `reset()`+`router.refresh()` 제거.
- **미읽음 배지(NotificationBell)**: provider context의 `unread` 대신 `useQuery(qk.notifications.unreadCount(), { initialData })` 파생값 사용.

### 5.2 NotificationProvider 역할 축소
- 기존: 소켓 연결 + `unread`/`liveItems` state + `decrement`/`reset` context.
- 변경 후: **소켓 연결만 담당**하고 수신 이벤트를 `queryClient.setQueryData`로 캐시에 반영. context는 제거하거나(소비처가 캐시 훅으로 이동) 소켓 lifecycle만 남긴다. `token` prop은 소켓 핸드셰이크용으로 계속 server→client prop 전달(M4/M5와 동일, JWT를 `NEXT_PUBLIC_`에 노출하지 않음).
- unreadCount 초기값은 layout이 서버에서 `backendUnreadCount`로 받아 `initialData`로 주입.

### 5.3 소스 일원화 원칙
소켓 푸시와 react-query 캐시 두 소스가 만나므로, **캐시 쓰기 경로를 `setQueryData` 하나로** 통일한다(소켓 핸들러·뮤테이션 성공 콜백 모두 캐시를 통해서만 상태를 바꾼다). 컴포넌트는 캐시를 읽기만 한다.

## 6. 토큰 / 보안

- 읽기용 토큰은 여전히 **서버(Server Component·Route Handler)에서만** 사용. 클라이언트 `useQuery`/`useMutation`은 **same-origin `/api/*` Route Handler**를 호출하므로 토큰을 직접 다루지 않는다.
- 단, 알림 목록 초기 시드는 서버에서 가져와 `initialData`로 넘기므로 클라가 토큰으로 백엔드를 직접 부르지 않는다. (소켓 토큰 prop은 기존과 동일.)
- 알림 목록을 클라에서 refetch해야 하면 **`GET /api/notifications` Route Handler를 신설**해 그를 통한다(직접 백엔드 호출·토큰 노출 금지). refetch가 필요 없으면 `initialData` + `setQueryData`만으로 충분(구현 계획에서 결정).

## 7. 에러 처리

- 뮤테이션 에러: `mutation.error`(ApiError 메시지)로 버튼 하단/폼 상단 표시. 기존 카피(`MESSAGES.*`) 유지.
- 쿼리 에러: 알림 목록 쿼리 실패 시 빈 상태/안내(기존 EmptyState).
- 소켓 실패: 배지·목록은 마지막 캐시 유지(앱 흐름 안 막음, M5와 동일).

## 8. 테스트

- 기존 RTL 테스트(`mark-all-read-button.test`, `logout-button.test`, `start-chat-button.test`)를 **`QueryClientProvider` 래퍼**로 감싸 갱신. 동작 단언은 유지(성공 시 이동/카피, 실패 시 에러 노출).
- `lib/query/keys.ts` 쿼리키 팩토리 단위 테스트.
- 소켓·Provider 부수효과는 단위 테스트 제외(수동 검증).
- 전 페이지 build·lint·test 통과.

## 9. 범위 밖 (YAGNI)

- 서버 컴포넌트 읽기의 react-query 이전(대시보드·게시판·건물·채팅) — SSR 유지.
- RHF 폼의 제출 상태 react-query화.
- **zustand**(순수 클라 UI 전역상태가 생기면 별도 도입) · **Auth.js**(별도 스펙·고위험, 단독 진행) — 이번 범위에서 제외.
- 알림 무한스크롤/페이지네이션, optimistic rollback 고도화(단건 읽음의 최소 낙관 갱신만).
- **Suspense / `useSuspenseQuery`** 제외 — 알림 목록은 `initialData`로 시드돼 suspend가 발동하지 않고(에러는 Error Boundary로 던져져 오히려 보일러플레이트 증가), 라우트 로딩은 Next `loading.tsx`가 담당. 추후 서버 읽기를 클라 read로 이전(§9)할 때 재검토.

## 10. 알려진 제약 / 트레이드오프

- QueryClient 인프라가 추가되지만, 알림 캐시 일원화 + 뮤테이션 보일러플레이트 제거로 정당화.
- 알림은 "소켓 푸시 + react-query 캐시" 두 소스 → `setQueryData` 단일 쓰기 경로로 일관성 확보(§5.3).
- 서버/클라 데이터 레이어 이원화는 의도된 설계(서버=fetch+SSR, 클라=react-query). 두 영역이 같은 데이터를 만지는 곳은 알림뿐이며, 초기 시드(`initialData`)로 연결한다.
- BE 변경 없음. 단, 알림 목록 클라 refetch가 필요하면 `GET /api/notifications` Route Handler 신설(§6) — 구현 계획에서 필요 여부 확정.
