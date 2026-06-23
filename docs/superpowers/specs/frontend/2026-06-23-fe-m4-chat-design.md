# FE-M4: 1:1 채팅 (WebSocket 실시간) 설계

- 작성일: 2026-06-23
- 대상 레포: `estate-web`(FE, 주) + `estate-server`(BE, 방 목록 응답 보강)
- 선행/참조 스펙
  - BE 채팅 도메인: `docs/superpowers/specs/2026-06-14-m4-chat-design.md`
  - 디자인 시스템: `docs/superpowers/specs/frontend/2026-06-22-design-system-design.md`
  - 온보딩(세션·역할): `docs/superpowers/specs/2026-06-22-onboarding-design.md`

## 1. 목표 / 성공 기준

건물주(OWNER)와 입주자(TENANT)가 1:1로 실시간 대화한다.

- [ ] `/chat` — 내가 참가한 방 목록(최근 메시지 미리보기 + 최근순 정렬)
- [ ] `/chat/[roomId]` — 메시지 히스토리 + socket.io 실시간 송수신
- [ ] 대화 시작(ensure): TENANT는 건물주에게, OWNER는 게시판 글 작성자(입주자)에게
- [ ] 연결/인증/페치 실패에 대한 사용자 안내
- [ ] 순수 로직 Vitest 테스트 통과, `npm run build`/`lint` 통과

## 2. 백엔드 계약 (estate-server, 기구현)

REST (Bearer JWT):

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/chat/rooms` | ensure. body `{buildingId, tenantId}` → `{id, buildingId, ownerId, tenantId}` |
| `GET` | `/chat/rooms` | 내 방 목록 |
| `GET` | `/chat/rooms/:id/messages?limit=N` | 메시지 히스토리(**최신순**, 최대 `RECENT_LIMIT`) |

WebSocket (**socket.io**, 기본 네임스페이스, `cors:true`):

- 핸드셰이크 인증: `handshake.auth.token` = JWT (실패 시 서버가 `disconnect`)
- 송신 `join` `{roomId}` → 참가자 아니면 서버가 `error {code:"CHAT_NOT_ROOM_PARTICIPANT"}`
- 송신 `message` `{roomId, content}`
- 수신 `message` → `ChatMessagePayload`
- 수신 `error` → `{code}` 또는 `{message}`

메시지 payload:

```ts
type ChatMessagePayload = {
  roomId: string; messageId: string; senderId: string;
  content: string; createdAt: string; // ISO 8601
};
```

방 = (building, owner, tenant) 1쌍. ensure 권한: 호출자가 건물주이거나 `tenantId === 본인`일 때만, 그리고 tenant가 해당 건물 멤버일 때만.

## 3. 백엔드 변경 — 방 목록 응답 보강 (estate-server)

**문제**: `GET /chat/rooms`가 `{id, buildingId, ownerId, tenantId}`만 반환 → 목록에서 마지막 메시지·최근순 정렬 불가.

> 상대방 **표시명**은 의도적으로 다루지 않는다. 이 앱은 게시판 작성자(`authorId`)·`me` 등 어디서도 사용자 이름을 노출하지 않는 컨벤션이며, 채팅만 이름을 넣으면 일관성이 깨지고 BE에 user 조회가 추가로 필요하다. 방 라벨은 건물명 + 상대 역할로 표기한다.

**변경**:
- `ListRoomsUseCase`에 `MESSAGE_CACHE`(+ `MESSAGE_REPOSITORY` DB 폴백) 주입. 방마다 최근 1건을 캐시 우선·DB 폴백으로 조회해 `{ room, lastMessage: ChatMessagePayload | null }`로 조립. `lastMessage.createdAt` 내림차순 정렬(메시지 없는 방은 뒤로).
- `ChatController.myRooms` 매핑 확장:
  ```ts
  { id, buildingId, ownerId, tenantId,
    lastMessage: { content: string; createdAt: string } | null }
  ```
- 테스트: `list-rooms.use-case.spec.ts` — 마지막 메시지 조립 + 정렬 케이스 추가.

> N+1을 피하려고 캐시(Redis) 우선 경로를 쓴다. 방 수가 많아지면 후속으로 단일 쿼리(서브쿼리/조인) 최적화.

## 4. FE 아키텍처 (estate-web)

기존 패턴 준수:
- **읽기**(방 목록·히스토리): Server Component에서 `getToken()` → `lib/api/chat` 직접 호출
- **쓰기**(메시지): REST 아님 — socket.io `message` 이벤트
- **방 생성(ensure)**: 클라이언트 버튼 → Next Route Handler `POST /api/chat/rooms`(쿠키 토큰을 읽어 BE 프록시) → 반환 roomId로 이동. 기존 `/api/buildings/[id]/posts` 프록시 패턴과 동일.
- **실시간**: 클라이언트 컴포넌트가 socket.io로 BE에 직접 연결

### 토큰 노출 처리 (확정)

socket.io 핸드셰이크엔 JWT가 필요하나 세션은 httpOnly 쿠키. → **Server Component가 `getToken()`으로 읽어 클라이언트 채팅 컴포넌트에 `token` prop으로 전달**한다. 본인의 단기 access token(maxAge 1h)이며 이미 Bearer로 쓰이는 값이라 추가 엔드포인트보다 단순. (별도 `/api/chat/token` 엔드포인트는 만들지 않는다.)

### 데이터 흐름 — 대화 화면

1. `app/chat/[roomId]/page.tsx`(Server): `getToken()` → `backendRoomMessages` 히스토리(최신순) 페치 → **역순 정렬(오래된→최신)** → `me`·`token`·`roomId`·초기 메시지를 `<ChatConversation>`에 전달
2. `<ChatConversation>`(client): mount 시 socket 연결 → `join` → `message` 수신 시 하단에 append → 자동 스크롤
3. 전송: input → `message` emit. **낙관적 렌더 안 함** — 서버가 같은 방에 broadcast(발신자 포함)하므로 echo로 렌더 → messageId dedup 불필요. (낙관적 렌더는 후속)

## 5. 컴포넌트 / 파일

신규/수정 (estate-web):

| 파일 | 종류 | 내용 |
|---|---|---|
| `lib/api/chat.ts` | 수정 | 타입 `ChatRoom`(+`lastMessage`)·`ChatMessage`, `backendMyRooms`/`backendRoomMessages`/`backendEnsureRoom` |
| `lib/constants.ts` | 수정 | `API_ROUTES.chatRooms`, `PAGE_ROUTES.chatRoom(id)` |
| `lib/messages.ts` | 수정 | `MESSAGES.chat`(빈 상태·연결 에러·전송 placeholder 등) |
| `lib/chat/room-label.ts` | 신규 | 순수 함수: 방 → 라벨(건물명 + 상대 역할), 최근순 정렬·히스토리 역순 헬퍼 |
| `app/chat/page.tsx` | 신규(Server) | 역할 인지 방 목록. buildingId→건물명 매핑(OWNER `backendMyBuildings`, TENANT `backendMyLeases`) |
| `app/chat/[roomId]/page.tsx` | 신규(Server) | 히스토리 페치 + `<ChatConversation>` 마운트 |
| `components/chat/chat-conversation.tsx` | 신규(client) | socket.io 연결·join·수신 append·전송·스크롤·에러 배너 |
| `components/chat/start-chat-button.tsx` | 신규(client) | ensure 호출 버튼(TENANT/OWNER 공용, props로 buildingId·tenantId) |
| `app/api/chat/rooms/route.ts` | 신규(Route Handler) | `POST` ensure 프록시(쿠키 토큰) |
| 진입점 연결 | 수정 | TENANT: `/chat` 빈 상태 + 대시보드 `chat-summary`. OWNER: `app/board/[buildingId]/[postId]/page.tsx` 글 상세에 "작성자와 채팅"(본인 글 제외) |

의존성: `socket.io-client` 추가. 환경변수: `NEXT_PUBLIC_WS_URL`(기본 `http://localhost:3001`, 비밀 아님 — BE 공개 호스트).

## 6. 진입점 (대화 시작)

- **TENANT**: `/chat` 빈 상태·대시보드 → "건물주에게 문의" → `ensure(buildingId=활성 리스의 buildingId, tenantId=me.id)` → roomId로 이동
- **OWNER**: 게시판 글 상세 → "작성자와 채팅"(작성자가 본인이 아닐 때만 노출) → `ensure(buildingId, tenantId=post.authorId)` → roomId로 이동. BE가 멤버십 검증.

## 7. 에러 처리

| 상황 | 처리 |
|---|---|
| 토큰 없음/만료 | 로그인 리다이렉트(기존 패턴) |
| 히스토리/목록 페치 실패 | 빈 배열 + 안내 문구(`MESSAGES.chat`) |
| socket 연결 실패·`disconnect` | 상단 배너 + 재연결 안내, 입력 비활성 |
| socket `error` 수신 | 코드별 메시지(참가자 아님 등) |
| ensure 403/404 | 버튼에서 에러 메시지 표시 |

## 8. 테스트 (Vitest 필수)

순수 로직만 단위 테스트(socket 부수효과 제외):
- `lib/chat/room-label.ts`: 라벨 생성(역할별), 최근순 정렬(메시지 없는 방 뒤로), 히스토리 역순
- `lib/api/chat.ts`: 함수가 올바른 path/headers/body로 호출하는지(fetch mock)
- (BE) `list-rooms.use-case.spec.ts`: lastMessage 조립 + 정렬

## 9. 범위 밖 (YAGNI)

- 상대방 표시명/아바타(앱 전체 이름 미노출 컨벤션)
- 낙관적 전송 렌더, 읽음 표시, 타이핑 인디케이터
- 메시지 페이지네이션(무한 스크롤) — 초기 `RECENT_LIMIT`만
- 자동 번역(후속 F2)

## 10. 알려진 제약 (해결됨/잔여)

- (해결) 마지막 메시지·최근순: BE 방 목록 응답 보강(§3)
- (잔여) 상대 표시명: 앱 전체 컨벤션상 미표기. 추후 user 표시명 도입 시 채팅·게시판 동시 적용
- (잔여) OWNER가 같은 건물 입주자 여러 명과 방을 가지면 라벨이 동일하게 보일 수 있음 — 마지막 메시지 미리보기로 일부 구분
