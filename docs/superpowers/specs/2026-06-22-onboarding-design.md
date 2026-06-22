# 온보딩(인증·초대 입주) 설계 스펙

> 작성일: 2026-06-22 · 상태: 설계 확정 (구현 미착수)
> 영역: estate-server 프론트엔드 첫 번째 구현 영역 — 인증/회원가입/초대코드 입주.
> 근거: 제품 스펙 [건물주 플랫폼 설계](./2026-06-11-building-owner-platform-design.md) · [디자인 시스템 v0](./2026-06-22-design-system-design.md) · 위키 `[[ui-ux-reference]]`.
> 전제 스택: FE = Next.js(별도 레포 `estate-web`, estate-server에 git 서브모듈), Tailwind v4 + CSS 변수.

---

## 0. 목적 & 범위

건물주(OWNER)와 입주자(TENANT)가 서비스에 진입하는 흐름을 설계한다. 핵심은 **역할 분기 가입**과 **초대코드 기반 입주**다.

- **포함**: 로그인, 역할 선택, 건물주 가입, 입주자 초대 가입(통합 플로우), 공유 링크 진입.
- **제외(YAGNI / 제품 스펙 준수)**: OAuth 소셜 로그인(F1, 추후), 비밀번호 재설정 이메일(후속), 그룹/멀티 디바이스 세션 관리(후속). ADMIN은 자가 가입 대상이 아니다.

---

## 1. 현행 백엔드 사실 (설계 근거)

코드 확인 결과(온보딩에 영향):

- `POST /auth/signup` `{email, name, password(≥8)}` → 유저 생성. **role 입력 없음, `User.create`가 기본 `TENANT` 부여.** 응답은 user만(**토큰 미발급**).
- `POST /auth/login` `{email, password}` → `{accessToken}`.
- `GET /auth/me` (JWT) → `{id, email, role}`.
- `POST /invite-codes/redeem` (JWT) `{code}` → Lease 생성(`tenantId = 현재 유저`). 코드 store는 만료 TTL + **단일 사용(원자적 GETDEL)**, 만료·사용됨·없음은 모두 실패(404).
- `POST /units/:unitId/invite-codes` (OWNER) → 코드 발급. `POST /buildings` 등은 `@Roles(OWNER)`.

**도출된 두 가지 문제와 해결(2절·3절):**
1. 가입이 무조건 TENANT라 **OWNER가 될 경로가 없음** → 가입에 역할 선택 추가(백엔드 변경 2.1).
2. redeem은 JWT 필요 + 코드를 소비함 → 가입 전 코드 확인 불가 → **미인증 미리보기 엔드포인트 추가**(백엔드 변경 2.2).

---

## 2. 백엔드 변경 (이 설계가 요구하는 최소 변경)

### 2.1 가입 시 역할 선택 (필수)
- `SignUpDto`에 `role?: 'OWNER' | 'TENANT'` 추가. 미지정 시 기본 `TENANT`.
- **보안(전역 CLAUDE.md RBAC): 화이트리스트 검증으로 `OWNER`/`TENANT`만 허용. `ADMIN` 자가 부여 차단.** `class-validator`의 `@IsIn(['OWNER','TENANT'])` + 도메인에서도 방어.
- `SignUpUseCase.execute`가 role을 받아 `User.create({..., role})`로 전달(엔티티는 이미 `role?` 지원).
- 응답에 `role` 포함(이미 포함됨).

### 2.2 미인증 초대코드 미리보기 (권장 채택 — 확정)
- 신규 `GET /invite-codes/:code/preview` (인증 불필요) → `{ valid: boolean, buildingName?: string, unitName?: string }`.
- **코드를 소비하지 않는다**(GETDEL이 아니라 GET). store에 `peek(code)` 메서드 추가(만료/없음이면 `valid:false`).
- 목적: 가입 전 "○○호 입주가 맞는지" 확인 → 가입했는데 코드가 만료된 **고아 계정** 방지. UX 신뢰 신호.
- 보안: 코드 자체가 비밀이므로 미리보기는 건물/호실 **이름만** 노출(주소·소유자 등 민감정보 제외). rate limit(ipMax) 적용.

> 이 두 변경은 온보딩 구현 플랜의 백엔드 작업으로 포함한다(FE보다 먼저).

---

## 3. 화면 맵 (5개)

| # | 경로 | 역할 | 내용 |
|---|---|---|---|
| 1 | `/login` | 공통 | 브랜드 + 이메일/비번 폼 + "처음이신가요? → 회원가입" |
| 2 | `/signup` | 공통 | "어떻게 시작할까요?" 큰 선택 카드 2개(건물주 / 입주자) |
| 3 | `/signup/owner` | OWNER | 이름·이메일·비번 → 가입 → 자동 로그인 → OWNER 대시보드(빈 상태) |
| 4 | `/signup/tenant` | TENANT | 4단계: 코드 입력 → 계정 폼 → 자동 처리 → 입주 완료 |
| 5 | `/invite?code=XXX` | TENANT | OWNER 공유 링크 진입 → 코드 프리필 후 #4로 |

- 디자인: 디자인 시스템 v0 적용. 토스식 미니멀·One-Thing-Per-Screen·큰 CTA·`Field`/`Button` 프리미티브. 온보딩은 위험 액션 없음(확인 다이얼로그 불요).

---

## 4. 플로우 ↔ API 매핑

### 4.1 로그인
```
POST /auth/login {email,password}
  → 성공: accessToken을 httpOnly 쿠키로 저장(5절) → GET /auth/me 로 role 확인
  → role별 대시보드 라우팅(OWNER/TENANT/ADMIN)
  → 실패 401: "이메일 또는 비밀번호를 확인하세요"
```

### 4.2 건물주 가입
```
POST /auth/signup {email,name,password, role:"OWNER"}
  → (토큰 미발급) POST /auth/login 자동 호출 → 쿠키 저장
  → OWNER 대시보드(빈 상태: "첫 건물을 등록하세요" CTA → 건물 관리 영역)
  → 실패 409: "이미 가입된 이메일입니다"
```

### 4.3 입주자 초대 가입 (통합 플로우)
```
① 코드 입력 화면
   GET /invite-codes/:code/preview
     valid=true  → "래미안 102동 1503호 입주" 확인 카드 표시 → 다음
     valid=false → "유효하지 않거나 만료된 초대코드입니다" (진행 차단)
② 계정 폼(이름·이메일·비번)
   POST /auth/signup {…, role:"TENANT"}
③ 자동 처리(로딩)
   POST /auth/login → 쿠키 저장
   POST /invite-codes/redeem {code}  → Lease 생성
④ 성공 연출
   "래미안 102동 1503호 입주 완료!" (토스식 성공 화면) → TENANT 대시보드
```
- **경합 주의**: ①의 preview와 ③의 redeem 사이에 코드가 만료/소비될 수 있다(단일 사용). redeem 404면 ④ 대신 "코드가 막 만료/사용되었어요" 안내 + 재시도 경로. 계정은 이미 생성됐으므로 로그인 상태에서 "초대코드 다시 입력"으로 보낸다(고아 계정 최소화).

### 4.4 공유 링크
- OWNER가 코드 발급 시 FE가 `https://<estate-web>/invite?code=XXX` 링크를 만들어 복사/공유. 입주자가 열면 4.3의 ①에 코드 프리필. (FE 전용, 백엔드 무변경)

---

## 5. 토큰 저장 (httpOnly 쿠키 — 확정)

- login 응답의 `accessToken`을 **httpOnly + Secure + SameSite=Lax 쿠키**로 저장. localStorage 금지(XSS 노출 방지, 전역 CLAUDE.md 보안 원칙).
- Next.js 구현: 브라우저가 직접 토큰을 만지지 않도록 **Route Handler(`app/api/session/route.ts`) 경유** — FE가 자기 서버(Next)에 자격증명을 보내면 Next가 백엔드 login을 호출하고 받은 토큰을 httpOnly 쿠키로 set. 이후 API 호출은 Next Route Handler/서버 컴포넌트가 쿠키의 토큰을 백엔드로 프록시.
- 로그아웃 = 쿠키 삭제. 만료(401) 시 로그인으로 리다이렉트.
- 비고: 백엔드는 현재 access token만 발급(refresh 미구현). 리프레시 토큰은 후속 과제로 분리(YAGNI).

---

## 6. 공통 처리

- **에러 메시지**: 409→"이미 가입된 이메일", 401(login)→"이메일/비밀번호 확인", preview/redeem 실패→"유효하지 않거나 만료된 초대코드". 백엔드 `ErrorResponseDto` 포맷 사용.
- **검증(FE)**: 이메일 형식, 비밀번호 ≥8(백엔드와 동일), 코드 비어있지 않음. 제출 전 인라인 검증 + 제출 후 서버 에러 표시.
- **Rate limit**: signup/login은 백엔드 `ipMax:10` 적용됨. preview에도 동일 적용 추가. FE는 실패 누적 시 "잠시 후 다시 시도" 안내.
- **접근 가드**: 이미 로그인 상태로 `/login`·`/signup` 진입 시 대시보드로 리다이렉트. 미인증으로 보호 페이지 진입 시 `/login`.
- **로딩/낙관**: ③ 자동 처리 구간은 단계 진행 표시(스켈레톤/스피너), 토스식 매끄러운 전환.

---

## 7. 성공 기준 (검증)

- 건물주: 가입 → 자동 로그인 → OWNER 대시보드 도달, `GET /auth/me` role=OWNER.
- 입주자: 유효 코드 → 가입 → 입주 완료, `GET /me/leases`에 ACTIVE Lease 1건.
- 잘못된 코드: preview에서 진행 차단. 만료 경합 시 안내 + 재입력 경로.
- 보안: `role:"ADMIN"`으로 가입 시도 → 거부(400). 토큰은 httpOnly 쿠키에만 존재(localStorage·JS 접근 불가).

---

## 8. 구현 순서 (다음 플랜에서 상세화)

1. **백엔드**: SignUpDto role 추가(+ADMIN 차단) → 초대코드 preview 엔드포인트(+store.peek) → 테스트.
2. **FE 기반**: estate-web 스캐폴드(Next.js + Tailwind v4 토큰), httpOnly 세션 Route Handler, API 클라이언트.
3. **FE 화면**: 로그인 → 역할 선택 → 건물주 가입 → 입주자 통합 가입 → 공유 링크.

---

## 참고
- 제품 도메인/역할/초대 모델: `2026-06-11-building-owner-platform-design.md`
- 디자인 토큰/컴포넌트: `2026-06-22-design-system-design.md`
- 모방 패턴: 위키 `notes/design/ui-ux-reference.md`
