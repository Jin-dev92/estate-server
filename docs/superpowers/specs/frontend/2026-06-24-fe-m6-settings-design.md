# FE-M6: 설정·프로필 (프로필 조회/수정 · 비밀번호 변경 · 로그아웃) 설계

- 작성일: 2026-06-24
- 대상 레포: `estate-server`(BE: 프로필 조회/수정·비밀번호 변경) + `estate-web`(FE, 주)
- 참조
  - 온보딩(세션·역할·폼): `docs/superpowers/specs/2026-06-22-onboarding-design.md`
  - 디자인 시스템: `docs/superpowers/specs/frontend/2026-06-22-design-system-design.md`

## 1. 목표 / 성공 기준

사용자가 자신의 프로필을 보고, 이름·비밀번호를 바꾸고, 로그아웃한다.

- [ ] `/settings` — 프로필(이름·이메일·역할) 표시
- [ ] 이름 수정
- [ ] 비밀번호 변경(현재 비번 확인 + 새 비번 8자+)
- [ ] 로그아웃(세션 쿠키 제거 → 로그인 이동)
- [ ] BE: `GET/PATCH /auth/profile`, `PATCH /auth/password`
- [ ] BE Jest · FE Vitest 통과, build·lint 통과

## 2. 기존 계약 / 코드 상태

- `GET /auth/me`(Bearer): JWT 토큰 값(`{id, email, role}`)만 반환 — **DB 미조회, name 없음**. 모든 인증 페이지가 호출(아바타·역할용). **이 라우트는 변경하지 않는다.**
- `User` 모델: `id, email, passwordHash, name, role, createdAt, updatedAt, deletedAt`(phone 없음).
- `User` 엔티티: 불변(private props) — 수정은 새 인스턴스 반환 메서드로.
- `UserRepository`: `findByEmail`, `save`(prisma `create` 전용). `PasswordHasher`: `hash`/`compare`.
- FE 세션: `app/api/session/route.ts`에 `POST`(로그인)·**`DELETE`(로그아웃, 쿠키 클리어) 이미 존재**. 로그아웃은 UI만 붙이면 됨.

## 3. 설계 결정 — `/auth/me`(토큰) vs `/auth/profile`(DB)

- `/auth/me`는 매 페이지가 부르므로 **토큰 기반(DB 0회)** 유지 — name을 넣으면 전 페이지에 DB 쿼리가 붙고, 토큰에 박힌 값은 수정 후에도 stale.
- name이 필요한 곳은 **설정 화면 하나뿐** → 무거운 DB 조회를 설정 전용 `GET /auth/profile`로 격리(항상 최신).
- 정리: **자주·가볍게=토큰(`/auth/me`)**, **가끔·정확하게=DB(`/auth/profile`)**.

## 4. 백엔드 변경 (estate-server)

### 4.1 도메인
- `User` 엔티티 메서드(불변, 새 인스턴스 반환):
  - `rename(name: string): User` — `name` 비면 `DomainError`.
  - `changePassword(newHash: string): User`.
- `UserRepository` 추가:
  - `findById(id: string): Promise<User | null>` (`deletedAt: null` 필터).
  - `update(user: User): Promise<User>` — `prisma.user.update({ where: { id }, data: { name, passwordHash } })`. (`save`는 create 전용으로 유지.)

### 4.2 유스케이스
- `GetProfileUseCase(userId): Promise<User>` — `findById`, 없으면 `AuthError.USER_NOT_FOUND`(신규 에러코드).
- `UpdateProfileUseCase(userId, name): Promise<User>` — load → `rename` → `update`.
- `ChangePasswordUseCase(userId, currentPassword, newPassword): Promise<void>` — load → `hasher.compare(current, hash)` 실패 시 `AuthError.INVALID_CREDENTIALS` → `hasher.hash(newPassword)` → `changePassword` → `update`. (newPassword 형식 검증은 DTO에서.)

### 4.3 인터페이스 (auth.controller, 각 `@UseGuards(JwtAuthGuard)`+`@ApiBearerAuth`+Swagger)
- `GET /auth/profile` → `ProfileResponseDto {id, email, name, role}`
- `PATCH /auth/profile` body `UpdateProfileDto {name}` → `ProfileResponseDto`
- `PATCH /auth/password` body `ChangePasswordDto {currentPassword, newPassword}` → `{ ok: true }` (401 `ErrorResponseDto`)
- DTO 검증: `name` 비공백, `newPassword` 8자+(class-validator). 모듈에 use-case 3종 등록.

### 4.4 테스트 (Jest)
- `UpdateProfileUseCase`(rename+update 호출), `ChangePasswordUseCase`(현재 비번 불일치→INVALID_CREDENTIALS / 성공 시 hash+update), `GetProfileUseCase`(없으면 USER_NOT_FOUND). `Partial<Repo>` 페이크.

## 5. 프론트엔드 (estate-web) — `main`에서 분기 (M5 머지 완료)

### 5.1 페이지/컴포넌트
- `app/(app)/settings/page.tsx`(Server): `getToken`(없으면 login) → `backendProfile` 조회 → 프로필 카드 + `<ProfileForm>` + `<PasswordForm>` + `<LogoutButton>`. 페치 실패 시 안내.
- `components/settings/profile-form.tsx`(client, rhf+zod): 이름 수정 → `PATCH /api/profile` → 성공 시 `router.refresh()`, 서버 에러는 폼 상단.
- `components/settings/password-form.tsx`(client, rhf+zod): 현재/새 비밀번호 → `PATCH /api/profile/password` → 성공 시 폼 리셋 + 성공 메시지, 실패 시 폼 상단(현재 비번 불일치 등).
- `components/settings/logout-button.tsx`(client): `DELETE /api/session` → `router.push(login)` + `router.refresh()`.
- `app/(app)/layout.tsx`: 헤더 아바타를 `PAGE_ROUTES.settings` 링크로(현재 단순 div).

### 5.2 Route Handlers
- `app/api/profile/route.ts` `PATCH` — 쿠키 토큰 → `backendUpdateProfile`.
- `app/api/profile/password/route.ts` `PATCH` — 쿠키 토큰 → `backendChangePassword`.
- 로그아웃은 기존 `DELETE /api/session`.

### 5.3 lib / 상수
- `lib/api/auth.ts`: `Profile = {id, email, name, role}`; `backendProfile(t)`·`backendUpdateProfile(t,{name})`·`backendChangePassword(t,{currentPassword,newPassword})`.
- `lib/schemas.ts`: `profileSchema {name}`·`passwordSchema {currentPassword, newPassword(≥8)}`.
- `lib/constants.ts`: `PAGE_ROUTES.settings`, `API_ROUTES.profile`, `API_ROUTES.profilePassword`.
- `lib/messages.ts`: `MESSAGES.settings`(이름/비번 라벨·실패·성공·로그아웃 카피).

## 6. 에러 처리

| 상황 | 처리 |
|---|---|
| 토큰 없음/만료 | `redirect(login)` |
| 프로필 페치 실패 | 안내 문구(폼 숨김 또는 재시도 안내) |
| 이름/비번 수정 실패 | 폼 상단 메시지 |
| 현재 비밀번호 불일치 | 401 → 비번 폼 상단 "현재 비밀번호가 일치하지 않습니다" |
| 로그아웃 실패 | 그래도 login으로 이동(쿠키 제거는 서버측) |

## 7. 테스트

- BE(Jest): `UpdateProfileUseCase`·`ChangePasswordUseCase`(불일치/성공)·`GetProfileUseCase`.
- FE(Vitest): `lib/api/auth` 신규 함수(path/method/headers/body), `ProfileForm`·`PasswordForm` RTL(성공/검증실패/서버에러), `LogoutButton` RTL(DELETE 호출 + login 이동).

## 8. 범위 밖 (YAGNI)

- 이메일 변경(식별자), 전화번호(모델에 없음), 계정 탈퇴(soft delete 존재하나 제외), 알림 환경설정·언어·테마.

## 9. 알려진 제약 / 트레이드오프

- `/auth/profile` DB 조회 1회/설정 진입 — `/auth/me`(토큰)는 그대로라 다른 페이지 비용 불변.
- JWT 무상태라 로그아웃은 클라이언트 쿠키 제거(서버 토큰 폐기 없음) — 토큰 만료(1h)까지는 기술적으로 유효하나 쿠키 없이는 사용 불가. 학습 범위 허용.
- 비밀번호 변경 후 기존 토큰은 그대로 유효(재로그인 강제 없음) — 후속으로 토큰 버전/블랙리스트 도입 가능.
- **머지 순서**: BE 먼저(또는 함께) — FE가 `/auth/profile`·`/auth/password` 계약에 의존.
