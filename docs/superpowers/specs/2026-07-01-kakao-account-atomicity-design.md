# 카카오 가입 User+Account 원자성 설계

- 작성일: 2026-07-01
- 대상 레포: `estate-server` (브랜치 `feature/kakao-oauth`, PR #69에 추가)
- 참조: `docs/superpowers/specs/frontend/2026-06-30-kakao-oauth-design.md`(§9 원자성 트레이드오프)

## 1. 배경 / 목표

`CompleteKakaoSignupUseCase`가 신규 카카오 유저를 만들 때 `users.save`(User) 후 `accounts.save`(Account)를 **2단계**로 호출한다. account 저장이 실패하면 User만 남는 **고아 레코드**가 되고, 같은 이메일 재시도 시 P2002(EMAIL_IN_USE)로 영구 로그인 불가가 된다(카카오 OAuth 최종 리뷰 Important 지적).

→ Prisma **nested write**로 User+Account를 한 번에 생성해 원자화한다. 외부 트랜잭션 라이브러리·러너 없이 Prisma가 자동으로 단일 트랜잭션 처리.

## 2. 트랜잭션 감사 요약 (전체 BE)

전체 use-case를 훑은 결과, 트랜잭션이 **필요한데 누락된** 지점은 이 건 하나뿐이다.
- **이미 적용(정상)**: create-post, create-comment, redeem-invite-code, end-lease, relay-outbox(도메인 변경+outbox를 `TransactionRunner`로 묶음).
- **단일 DB write(불필요)**: ensure-room, create-unit, create-building, sign-up, update-profile 등.
- **DB↔Redis 혼합(트랜잭션 부적합)**: mark-all-read, mark-one-read, handle-event — DB와 Redis는 한 트랜잭션으로 못 묶음. 분산 트랜잭션은 과함(YAGNI), 이미 멱등·드리프트 허용 설계가 있음. **이번 범위 제외.**
- **필요·누락**: `complete-kakao-signup`(User+Account, 둘 다 DB) → 이 작업 대상.

## 3. 변경

### 3.1 도메인 포트
`UserRepository`에 추가:
```ts
// User와 첫 OAuth Account를 한 트랜잭션(nested write)으로 함께 생성한다.
saveWithAccount(
  user: User,
  link: { provider: string; providerId: string },
): Promise<User>;
```

### 3.2 Prisma 구현
`PrismaUserRepository.saveWithAccount`:
```ts
const row = await this.prisma.user.create({
  data: {
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    role: user.role,
    accounts: { create: { provider: link.provider, providerId: link.providerId } },
  },
});
return User.reconstitute({ ... });   // 기존 save와 동일 매핑
```
- P2002 등 예외는 **호출부에서 처리**하도록 그대로 전파(현 `save`와 달리 여기선 try/catch 안 함 — use-case가 EMAIL_IN_USE 변환).

### 3.3 use-case
`CompleteKakaoSignupUseCase` 신규 경로:
- `users.save(...)` + `accounts.save(...)` 2단계 → `users.saveWithAccount(User.createOAuth({...}), { provider: AuthProvider.KAKAO, providerId: payload.providerId })` 1단계.
- P2002 → `AuthError.EMAIL_IN_USE` 변환(try/catch 유지).
- **멱등 경로는 그대로**: `accounts.findByProvider`로 기존 Account 조회는 계속 필요 → `AccountRepository` 주입 유지(단, `accounts.save` 호출과 `Account` 엔티티 import는 제거).

### 3.4 테스트
`kakao.use-cases.spec.ts`:
- `users` fake에 `saveWithAccount` 추가(정상 시 user 반환).
- P2002 케이스를 `saveWithAccount`가 throw하도록 변경.
- 정상 생성 케이스: `saveWithAccount`가 1회 호출되고 `accounts.save`는 호출 안 됨(또는 fake에서 save 제거).
- 멱등 케이스(기존 Account 존재)·INVALID_ONBOARDING·INVALID_ROLE·USER_NOT_FOUND는 그대로 통과.

## 4. 범위 밖 (YAGNI)
- notification DB-Redis 혼합의 분산 트랜잭션.
- 기존 `TransactionRunner` 도입(nested write로 충분 — 더 단순·Prisma다움).
- 다른 use-case(이미 정상/단일 write).

## 5. 알려진 제약
- nested write는 Prisma가 단일 트랜잭션 보장 → account 실패 시 user도 롤백(고아 불가).
- 멱등 경로에서 `accounts.findByProvider`만 쓰므로 `AccountRepository`는 read 전용 의존으로 남는다(정상).
- 검증: BE 전체 스위트 회귀(카카오 use-case spec만 영향), lint·build.
