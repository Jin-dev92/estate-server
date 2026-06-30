# 카카오 OAuth 로그인 설계 (F1 소셜 로그인)

- 작성일: 2026-06-30
- 대상 레포: `estate-server`(BE: OAuth 교환·Account·JWT, 주) + `estate-web`(FE: 버튼·콜백·역할선택)
- 참조
  - 온보딩(세션·역할·쿠키): `docs/superpowers/specs/2026-06-22-onboarding-design.md`
  - 프로필/비번(auth 도메인): `docs/superpowers/specs/frontend/2026-06-24-fe-m6-settings-design.md`

## 1. 목표 / 성공 기준

카카오 계정으로 로그인/가입한다. 백엔드가 OAuth를 처리하고 **기존과 동일한 우리 JWT**를 발급해 FE httpOnly 쿠키에 담는다(현 인증 구조 유지).

- [ ] 로그인 페이지 "카카오로 로그인" → 카카오 인증 → 우리 세션 발급
- [ ] 신규 카카오 유저는 **역할 선택(OWNER/TENANT)** 후 가입 완료
- [ ] 기존 카카오 유저는 즉시 로그인
- [ ] BE: `Account` 모델 + `POST /auth/kakao`·`POST /auth/kakao/complete`
- [ ] BE Jest · FE Vitest · build·lint 통과

## 2. 아키텍처 — FE 콜백 + BE code 교환 (쿠키 일관)

현 구조는 **FE(:3000)=httpOnly 쿠키 소유자**, BE(:3001)=JWT 발급자. 비번 로그인과 동일하게 **쿠키 set은 항상 FE**에서 한다. 전통적 passport redirect(콜백이 BE) 대신 **FE가 콜백을 받고 code를 BE로 보내 교환**한다.

```
1. FE "카카오 로그인" → 카카오 authorize로 이동
   (redirect_uri = FE /auth/kakao/callback, state= CSRF 토큰)
2. 카카오 → FE /auth/kakao/callback?code=&state=
3. FE route handler가 code를 BE POST /auth/kakao 로 전달
4. BE: 카카오와 code↔access_token 교환 → 프로필(회원번호·email·nickname) 조회
   → Account(KAKAO, providerId) find
   ├─ 있으면: 우리 JWT 발급 → FE에 {accessToken}
   └─ 없으면: onboardingToken(카카오 신원 담은 단기 서명 JWT) → FE에 {onboardingToken}
5. FE:
   ├─ {accessToken} → httpOnly 쿠키 set → /dashboard
   └─ {onboardingToken} → /signup/role-select 로
6. 역할 선택 → FE가 {onboardingToken, role}을 BE POST /auth/kakao/complete
   → BE가 onboardingToken 검증 → User+Account 생성(선택 role) → 우리 JWT
   → FE 쿠키 set → /dashboard
```

쿠키·세션 단일 출처는 기존 `lib/session.ts`/`/api/session` 그대로. BE는 카카오 교환·유저 로직만.

## 3. 데이터 모델 (estate-server)

```prisma
model User {
  passwordHash String?   // nullable (OAuth-only 유저는 비번 없음). 기존 로컬 유저는 그대로 값 유지.
  accounts     Account[]
  // ... 기존 필드(id·email unique·name·role·timestamps·deletedAt) 유지
}

model Account {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  provider   String   // "KAKAO"
  providerId String   // 카카오 회원번호(문자열)
  createdAt  DateTime @default(now())

  @@unique([provider, providerId])   // 같은 소셜 계정 중복 연결 방지
  @@index([userId])
}
```
- 마이그레이션: `passwordHash` nullable화 + `Account` 신설.
- **find-or-create 키 = `Account(provider, providerId)`**(이메일 아님 — 이메일은 변경·부재 가능).
- `provider`는 닫힌 집합이나 BE는 `const enum` 컨벤션 → `AuthProvider` 상수(`KAKAO`)로 둔다.

## 4. 엣지케이스 / 정책

1. **이메일 부재**: 카카오 이메일 동의는 선택 → 없을 수 있음. `User.email`은 unique NOT NULL.
   - 정책: 카카오 authorize에 **`account_email` scope 요청**. 그래도 프로필에 이메일이 없으면 `AUTH_KAKAO_EMAIL_REQUIRED` 에러로 안내(합성 이메일 안 만듦).
2. **이메일 충돌(기존 로컬 계정과 동일 이메일)**: 자동 계정 연결 **안 함**(이번 범위). complete 시 `User` 생성에서 email unique 위반(P2002) → `AUTH_EMAIL_IN_USE`로 변환해 안내.
3. **onboardingToken**: 카카오 신원(`providerId`·`email`·`name`)을 담은 **단기(10분) 서명 JWT**(우리 JwtService, `typ: "kakao_onboarding"` 클레임으로 일반 access token과 구분). complete에서만 사용.
4. **CSRF**: OAuth `state` — FE가 난수 생성·쿠키/스토리지에 저장 후 콜백에서 일치 검증.
5. **complete 재사용/위변조**: onboardingToken 만료·서명 검증 실패 시 `AUTH_INVALID_ONBOARDING` 에러.

## 5. 백엔드 (estate-server)

### 5.1 도메인 / 인프라
- `Account` 엔티티 + `AccountRepository`(`findByProvider(provider, providerId)`, `save`). Prisma 구현.
- `User.passwordHash` nullable. `User.create`에 OAuth 분기(비번 없이 생성) 또는 `User.createOAuth({email,name,role})`.
- `KakaoOAuthClient`(인프라): `exchangeCode(code, redirectUri) → {accessToken}`, `fetchProfile(accessToken) → {providerId, email?, name}`. HTTP는 주입 가능하게(테스트 mock).
- `AuthProvider = { KAKAO: 'KAKAO' } as const`.

### 5.2 유스케이스
- `KakaoLoginUseCase(code, redirectUri)`:
  1. `KakaoOAuthClient`로 교환·프로필.
  2. 이메일 없으면 `AUTH_KAKAO_EMAIL_REQUIRED`.
  3. `accounts.findByProvider(KAKAO, providerId)`:
     - 있으면 → 그 User로 우리 JWT 발급 → `{ accessToken }`.
     - 없으면 → onboardingToken 발급(providerId·email·name) → `{ onboardingToken }`.
- `CompleteKakaoSignupUseCase(onboardingToken, role)`:
  1. onboardingToken 검증(서명·만료·typ). 실패 시 `AUTH_INVALID_ONBOARDING`.
  2. role ∈ {OWNER, TENANT} 검증(`AUTH_INVALID_ROLE`).
  3. (멱등) 이미 Account 있으면 그 User로 JWT(중복 complete 안전).
  4. User 생성(email·name·role, passwordHash=null) + Account 생성. email 충돌 P2002 → `AUTH_EMAIL_IN_USE`.
  5. 우리 JWT 발급 → `{ accessToken }`.

### 5.3 인터페이스 (auth.controller, Swagger + RateLimit)
- `POST /auth/kakao` body `{ code, redirectUri }` → `{ accessToken }` 또는 `{ onboardingToken }`.
- `POST /auth/kakao/complete` body `{ onboardingToken, role }` → `{ accessToken }`.
- 둘 다 `@RateLimit({ ipMax: 10 })`, 400/401 `ErrorResponseDto`. 신규 에러코드: `AUTH_KAKAO_EMAIL_REQUIRED`, `AUTH_INVALID_ONBOARDING`.
- env: `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`(서버 전용). 모듈에 use-case·client·repo 등록.

### 5.4 테스트 (Jest)
- `KakaoLoginUseCase`: 기존 Account→accessToken / 신규→onboardingToken / 이메일 없음→에러. (KakaoOAuthClient mock)
- `CompleteKakaoSignupUseCase`: 정상 생성 / 잘못된 토큰→AUTH_INVALID_ONBOARDING / email 충돌→AUTH_EMAIL_IN_USE / 멱등(Account 존재).

## 6. 프론트엔드 (estate-web)

### 6.1 페이지/컴포넌트
- 로그인 페이지: **"카카오로 로그인" 버튼** — 클릭 시 `state` 난수 생성·저장 후 카카오 authorize URL로 이동(`NEXT_PUBLIC_KAKAO_CLIENT_ID`, redirect_uri, scope=`account_email`, state).
- `app/auth/kakao/callback/page.tsx`(client): `?code&state` 수신 → state 검증 → `/api/auth/kakao`에 code POST → `{accessToken}`이면 쿠키 이미 set됨(핸들러가)·`/dashboard`, `{onboardingToken}`이면 토큰 보관 후 `/signup/role-select`.
- `app/signup/role-select/page.tsx`(신규): OWNER/TENANT 선택 → `/api/auth/kakao/complete`(onboardingToken+role) → `/dashboard`. 에러 표시.

### 6.2 Route Handlers (쿠키 set은 여기서)
- `app/api/auth/kakao/route.ts` POST: BE `/auth/kakao` 프록시 → `{accessToken}`이면 `setSession` 후 `{next:"dashboard"}`, `{onboardingToken}`이면 그대로 반환(`{next:"role-select", onboardingToken}`).
- `app/api/auth/kakao/complete/route.ts` POST: BE `/auth/kakao/complete` 프록시 → `{accessToken}` `setSession` → `{ok}`.
- (onboardingToken은 FE 메모리/세션스토리지로 잠깐 들고 complete 호출 시 전달. httpOnly 세션 쿠키엔 안 넣음 — 아직 로그인 전.)

### 6.3 상수 / 메시지
- `PAGE_ROUTES.kakaoCallback`·`roleSelect`, `API_ROUTES.kakao`·`kakaoComplete`. `MESSAGES.auth.kakao*`(이메일 동의 필요·로그인 실패 등). `NEXT_PUBLIC_KAKAO_CLIENT_ID`·카카오 authorize 베이스 URL 상수.

### 6.4 테스트 (Vitest)
- `role-select` 폼(성공 이동 / 실패 메시지) RTL. callback의 순수 분기(있으면 next 매핑) 단위. `/api/auth/kakao*` 핸들러(프록시·setSession 호출) — fetch/session mock.

## 7. 인증/보안 (사용자 수동 작업)
- **카카오 개발자 콘솔 앱 등록**: REST API 키(=client id), client secret, **Redirect URI** `http://localhost:3000/auth/kakao/callback`(운영 도메인 추가), 동의항목 **카카오계정(이메일)** 활성.
- env: BE `KAKAO_CLIENT_ID`·`KAKAO_CLIENT_SECRET`(서버 전용), FE `NEXT_PUBLIC_KAKAO_CLIENT_ID`(authorize redirect용, 공개 가능). secret은 절대 FE/NEXT_PUBLIC_ 노출 금지.
- 절차는 가이드 문서(`estate-server/docs/ci/` 또는 `docs/guides/`)로.

## 8. 범위 밖 (YAGNI)
- 자동 계정 연결(이메일 매칭으로 로컬↔카카오 병합).
- 카카오 외 소셜(구글 등), 다중 provider 동시 연결.
- 카카오 토큰 저장·갱신·연결 해제 UI(우리는 우리 JWT만 쓰고 카카오 토큰은 1회용).
- F2 채팅 자동 번역(별도).

## 9. 알려진 제약 / 트레이드오프
- **머지 순서**: BE 먼저(또는 함께) — FE가 `/auth/kakao`·`/complete` 계약에 의존.
- `passwordHash` nullable화로 비번 변경(M6) 경로는 OAuth-only 유저에서 의미 없음 → 그 유저는 비번 폼을 막거나 안내(후속; 이번엔 카카오 유저가 설정 비번폼 쓰면 현재 비번 검증 실패로 자연 차단).
- onboardingToken을 FE가 잠깐 보관(세션스토리지) — XSS 시 탈취 가능하나 10분·typ 한정·역할선택만 가능이라 피해 제한적(학습 범위 허용).
- 카카오 회원번호 기준 식별 → 같은 사람이 카카오 이메일을 바꿔도 동일 계정 유지(정확).
- 자동 계정 연결 안 함 → 같은 이메일을 비번·카카오로 각각 쓰면 email unique 충돌로 둘째 가입이 막힘(의도된 단순화, 후속에 링크 기능).
