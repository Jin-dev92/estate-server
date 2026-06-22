# 온보딩 백엔드 변경 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 온보딩이 요구하는 estate-server 백엔드 변경 2건 — ① 가입 시 역할 선택(OWNER/TENANT, ADMIN 차단) ② 미인증 초대코드 미리보기 엔드포인트 — 를 TDD로 구현한다.

**Architecture:** 기존 DDD 레이어(interface/application/domain/infrastructure)와 패턴을 그대로 따른다. 역할 선택은 `SignUpDto`+`SignUpUseCase`에 `role`을 흘려보내고(엔티티 `User.create`는 이미 `role?` 지원), 미리보기는 store에 비소비 `peek`를 추가하고 새 `PreviewInviteCodeUseCase`+미인증 라우트를 더한다.

**Tech Stack:** NestJS 11, class-validator, Redis(초대코드 store), Jest(`*.spec.ts` 단위 + `test/*.e2e-spec.ts`), supertest.

**근거 스펙:** `docs/superpowers/specs/2026-06-22-onboarding-design.md` (§2 백엔드 변경, §7 성공 기준).

---

## 파일 구조 (생성/수정)

**역할 선택 (변경 2.1)**
- Modify `src/auth/interface/dto/sign-up.dto.ts` — `role?` 필드 + `@IsIn([OWNER,TENANT])`
- Modify `src/auth/application/sign-up.use-case.ts` — `SignUpInput.role` + `User.create`에 전달
- Test `src/auth/application/sign-up.use-case.spec.ts` — role 지정 케이스 추가
- Test `test/auth.e2e-spec.ts` — OWNER 가입/ADMIN 차단 e2e

**초대코드 미리보기 (변경 2.2)**
- Modify `src/property/domain/invite-code.store.ts` — 인터페이스에 `peek` 추가
- Modify `src/property/infrastructure/redis-invite-code.store.ts` — `peek` 구현(GET, 비소비)
- Create `src/property/application/preview-invite-code.use-case.ts` — 미리보기 유스케이스
- Test `src/property/application/preview-invite-code.use-case.spec.ts`
- Modify `src/property/property.module.ts` — provider 등록
- Modify `src/property/interface/property.controller.ts` — `GET /invite-codes/:code/preview` (미인증)
- Test `test/property.e2e-spec.ts` — 미리보기 e2e

> 명령어: 단위 `npm test`, e2e `npm run test:e2e`, 린트 `npm run lint:check`.

---

## Task 1: 가입 유스케이스에 역할 전달 (단위 TDD)

**Files:**
- Modify: `src/auth/application/sign-up.use-case.ts`
- Test: `src/auth/application/sign-up.use-case.spec.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/auth/application/sign-up.use-case.spec.ts` 상단 import에 `Role` 추가하고 테스트를 더한다:

```typescript
import { Role } from '../domain/role.enum';
```

`describe('SignUpUseCase', () => { ... })` 안에 추가:

```typescript
  it('role을 OWNER로 지정하면 OWNER 유저를 생성한다', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({
      email: 'owner@test.com',
      name: '사장',
      password: 'pw123456',
      role: Role.OWNER,
    });
    expect(user.role).toBe('OWNER');
  });

  it('role 미지정이면 기본 TENANT', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({
      email: 'def@test.com',
      name: '기본',
      password: 'pw123456',
    });
    expect(user.role).toBe('TENANT');
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- sign-up.use-case`
Expected: FAIL — `SignUpInput`에 `role`이 없어 타입 에러, 또는 `user.role`이 항상 TENANT.

- [ ] **Step 3: 최소 구현**

`src/auth/application/sign-up.use-case.ts` 수정 — `Role` import, `SignUpInput.role` 추가, `User.create`에 전달:

```typescript
import { Role } from '../domain/role.enum';

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
  role?: Role;
}
```

`execute` 안의 `User.create` 호출을 다음으로 변경:

```typescript
    const user = User.create({
      email: input.email,
      name: input.name,
      passwordHash,
      role: input.role,
    });
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- sign-up.use-case`
Expected: PASS (기존 2개 + 신규 2개).

- [ ] **Step 5: 커밋**

```bash
git add src/auth/application/sign-up.use-case.ts src/auth/application/sign-up.use-case.spec.ts
git commit -m "[M0]feat: 가입 유스케이스에 role 전달(기본 TENANT)"
```

---

## Task 2: 가입 DTO에 role + ADMIN 자가부여 차단 (e2e)

**Files:**
- Modify: `src/auth/interface/dto/sign-up.dto.ts`
- Test: `test/auth.e2e-spec.ts`

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`test/auth.e2e-spec.ts`에서 cleanup 대상에 이메일 추가 — 상단 상수 옆에:

```typescript
  const ownerEmail = `owner_${Date.now()}@test.com`;
```

`afterAll`의 `deleteMany` where-in 배열에 `ownerEmail` 포함:

```typescript
    await prisma.user.deleteMany({
      where: { email: { in: [email, dupEmail, ownerEmail] } },
    });
```

테스트 2개 추가(describe 블록 내):

```typescript
  it('role을 OWNER로 지정해 signup하면 role=OWNER', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email: ownerEmail, name: '사장', password: 'pw123456', role: 'OWNER' })
      .expect(201)
      .expect((res) =>
        expect((res.body as { role: string }).role).toBe('OWNER'),
      );
  });

  it('role을 ADMIN으로 자가 부여하면 400', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({
        email: `adm_${Date.now()}@test.com`,
        name: 'x',
        password: 'pw123456',
        role: 'ADMIN',
      })
      .expect(400);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm run test:e2e -- auth`
Expected: FAIL — 현재 `role`은 `whitelist:true`로 무시돼 OWNER가 안 되고(첫 테스트 실패), ADMIN도 그냥 무시돼 201(둘째 테스트 400 기대 실패).

- [ ] **Step 3: 최소 구현 — DTO에 role 추가**

`src/auth/interface/dto/sign-up.dto.ts` 수정:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, MinLength } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class SignUpDto {
  @ApiProperty({ example: 'owner@estate.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '김철수' })
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'pw123456', minLength: 8 })
  @MinLength(8)
  password: string;

  // 자가 가입은 OWNER/TENANT만 허용. ADMIN 자가 부여 차단(보안).
  @ApiPropertyOptional({ enum: [Role.OWNER, Role.TENANT], example: Role.OWNER })
  @IsOptional()
  @IsIn([Role.OWNER, Role.TENANT])
  role?: Role;
}
```

> 컨트롤러는 `this.signUp.execute(dto)`로 이미 dto를 그대로 넘기므로 변경 불필요(`SignUpDto`가 `SignUpInput`에 할당 가능).

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm run test:e2e -- auth`
Expected: PASS (기존 흐름 + OWNER 201 + ADMIN 400). 기본 가입이 여전히 TENANT인 기존 테스트도 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/auth/interface/dto/sign-up.dto.ts test/auth.e2e-spec.ts
git commit -m "[M0]feat: 가입 DTO role 선택(OWNER/TENANT) + ADMIN 자가부여 차단"
```

---

## Task 3: 초대코드 store에 비소비 peek 추가

**Files:**
- Modify: `src/property/domain/invite-code.store.ts`
- Modify: `src/property/infrastructure/redis-invite-code.store.ts`

- [ ] **Step 1: 인터페이스에 peek 선언**

`src/property/domain/invite-code.store.ts`의 `InviteCodeStore`에 메서드 추가:

```typescript
export interface InviteCodeStore {
  issue(payload: InviteCodePayload): Promise<IssuedInvite>;
  // 단일 사용(원자적 GETDEL). 만료·이미 사용·존재하지 않음은 모두 null.
  redeem(code: string): Promise<InviteCodePayload | null>;
  // 소비하지 않고 조회만(미리보기용). 만료·없음이면 null.
  peek(code: string): Promise<InviteCodePayload | null>;
}
```

- [ ] **Step 2: Redis 구현 추가**

`src/property/infrastructure/redis-invite-code.store.ts`의 클래스에 메서드 추가(`redeem` 아래):

```typescript
  async peek(code: string): Promise<InviteCodePayload | null> {
    // GET: 삭제하지 않고 조회만(redeem과 달리 코드를 소비하지 않음)
    const raw = await this.redis.get(this.key(code));
    if (!raw) return null;
    return JSON.parse(raw) as InviteCodePayload;
  }
```

> `RedisService`에 `get`이 없으면(있을 가능성이 높음) `src/redis/redis.service.ts`에 `get(key: string): Promise<string | null>`를 underlying client로 위임해 추가한다.

- [ ] **Step 3: 컴파일/기존 테스트 확인**

Run: `npm test -- property`
Expected: PASS — 기존 property 단위 테스트(redeem/issue 등)가 여전히 통과하고, 인터페이스 변경으로 인한 타입 에러 없음.

> 참고: 기존 fake store(`FakeInviteStore`)는 `implements InviteCodeStore`라 `peek` 미구현 시 타입 에러가 날 수 있다. 그럴 경우 해당 spec의 fake에 `peek(){ return Promise.resolve(null); }`를 추가한다(테스트 보조).

- [ ] **Step 4: 커밋**

```bash
git add src/property/domain/invite-code.store.ts src/property/infrastructure/redis-invite-code.store.ts
git commit -m "[M1]feat: 초대코드 store에 비소비 peek 추가(미리보기용)"
```

---

## Task 4: PreviewInviteCodeUseCase (단위 TDD)

**Files:**
- Create: `src/property/application/preview-invite-code.use-case.ts`
- Test: `src/property/application/preview-invite-code.use-case.spec.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/property/application/preview-invite-code.use-case.spec.ts` 생성:

```typescript
import { PreviewInviteCodeUseCase } from './preview-invite-code.use-case';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import {
  InviteCodePayload,
  InviteCodeStore,
} from '../domain/invite-code.store';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';

const UNIT = Unit.reconstitute({ id: 'u1', buildingId: 'b1', name: '1503호', floor: 15 });
const BUILDING = Building.reconstitute({ id: 'b1', ownerId: 'o1', name: '래미안 역삼', address: '서울 강남구' });

function makeStore(payload: InviteCodePayload | null): InviteCodeStore {
  return {
    issue: () => Promise.resolve({ code: 'x', expiresInSec: 1 }),
    redeem: () => Promise.resolve(null),
    peek: () => Promise.resolve(payload),
  };
}
const units: Partial<UnitRepository> = { findById: () => Promise.resolve(UNIT) };
const buildings: Partial<BuildingRepository> = { findById: () => Promise.resolve(BUILDING) };

describe('PreviewInviteCodeUseCase', () => {
  it('유효한 코드면 valid=true와 건물/호실 이름을 반환', async () => {
    const useCase = new PreviewInviteCodeUseCase(
      makeStore({ unitId: 'u1', issuedBy: 'o1' }),
      units as UnitRepository,
      buildings as BuildingRepository,
    );
    const result = await useCase.execute('GOOD');
    expect(result).toEqual({ valid: true, buildingName: '래미안 역삼', unitName: '1503호' });
  });

  it('만료·없는 코드면 valid=false (이름 없음)', async () => {
    const useCase = new PreviewInviteCodeUseCase(
      makeStore(null),
      units as UnitRepository,
      buildings as BuildingRepository,
    );
    const result = await useCase.execute('EXPIRED');
    expect(result).toEqual({ valid: false });
  });
});
```

> 주의: `Unit.reconstitute`/`Building.reconstitute`의 실제 시그니처를 `src/property/domain/unit.entity.ts`·`building.entity.ts`에서 확인하고 인자 키를 맞춘다(위 예시는 id/buildingId/name/floor, id/ownerId/name/address 가정).

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- preview-invite-code`
Expected: FAIL — 모듈 `preview-invite-code.use-case`가 없음.

- [ ] **Step 3: 유스케이스 구현**

`src/property/application/preview-invite-code.use-case.ts` 생성:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { INVITE_CODE_STORE, InviteCodeStore } from '../domain/invite-code.store';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import { BUILDING_REPOSITORY, BuildingRepository } from '../domain/building.repository';

export interface InvitePreview {
  valid: boolean;
  buildingName?: string;
  unitName?: string;
}

@Injectable()
export class PreviewInviteCodeUseCase {
  constructor(
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  async execute(code: string): Promise<InvitePreview> {
    const payload = await this.invites.peek(code);
    if (!payload) return { valid: false };
    const unit = await this.units.findById(payload.unitId);
    if (!unit) return { valid: false };
    const building = await this.buildings.findById(unit.buildingId);
    if (!building) return { valid: false };
    // 보안: 코드가 비밀이므로 이름만 노출(주소·소유자 등 민감정보 제외)
    return { valid: true, buildingName: building.name, unitName: unit.name };
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- preview-invite-code`
Expected: PASS (2개).

- [ ] **Step 5: 커밋**

```bash
git add src/property/application/preview-invite-code.use-case.ts src/property/application/preview-invite-code.use-case.spec.ts
git commit -m "[M1]feat: 초대코드 미리보기 유스케이스(이름만 노출)"
```

---

## Task 5: 미리보기 엔드포인트 + 모듈 등록

**Files:**
- Modify: `src/property/property.module.ts`
- Modify: `src/property/interface/property.controller.ts`

- [ ] **Step 1: provider 등록**

`src/property/property.module.ts`에 `PreviewInviteCodeUseCase`를 import하고 `providers` 배열에 추가:

```typescript
import { PreviewInviteCodeUseCase } from './application/preview-invite-code.use-case';
```
providers 배열(use-case들이 나열된 곳)에 `PreviewInviteCodeUseCase,` 한 줄 추가.

- [ ] **Step 2: 컨트롤러에 미인증 라우트 추가**

`src/property/interface/property.controller.ts` 상단 import 추가:

```typescript
import { PreviewInviteCodeUseCase } from '../application/preview-invite-code.use-case';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
```

생성자에 주입 추가(다른 use-case들과 함께):

```typescript
    private readonly previewInvite: PreviewInviteCodeUseCase,
```

`redeemInviteHandler` 위 또는 아래에 미인증 라우트 추가(클래스 레벨 `@ApiBearerAuth`가 있지만 이 라우트는 가드를 걸지 않아 공개됨):

```typescript
  @Get('invite-codes/:code/preview')
  @RateLimit({ ipMax: 20 })
  @ApiOperation({ summary: '초대코드 미리보기(미인증, 비소비)' })
  @ApiParam({ name: 'code', description: '미리볼 초대코드' })
  @ApiResponse({
    status: 200,
    description: '{ valid, buildingName?, unitName? } — 코드를 소비하지 않음',
  })
  previewInviteHandler(@Param('code') code: string) {
    return this.previewInvite.execute(code);
  }
```

> `@Get`, `@Param`, `@ApiOperation`, `@ApiParam`, `@ApiResponse`는 이 파일에 이미 import돼 있다(추가 import 불필요).

- [ ] **Step 3: 빌드/타입 확인**

Run: `npm run build`
Expected: 컴파일 성공(DI 토큰·타입 정합).

- [ ] **Step 4: 커밋**

```bash
git add src/property/property.module.ts src/property/interface/property.controller.ts
git commit -m "[M1]feat: GET /invite-codes/:code/preview 미인증 엔드포인트"
```

---

## Task 6: 미리보기 e2e

**Files:**
- Test: `test/property.e2e-spec.ts`

- [ ] **Step 1: 실패하는 e2e 작성**

`test/property.e2e-spec.ts`에 테스트 추가. 기존 테스트가 OWNER 로그인 → 건물/호실 생성 → 초대코드 발급까지 하는 흐름이 있으면 그 코드(발급된 `code`)를 재사용한다. 없으면 발급 단계를 포함해 다음을 검증:

```typescript
  it('발급된 초대코드는 미인증으로 미리보기되고 소비되지 않는다', async () => {
    // (선행) OWNER로 건물·호실 생성 후 code 발급 — 기존 헬퍼/흐름 재사용
    //   const code = <issue invite>;
    // 미인증 미리보기: valid=true + 이름
    const preview = await request(app.getHttpServer() as App)
      .get(`/invite-codes/${code}/preview`)
      .expect(200);
    expect((preview.body as { valid: boolean }).valid).toBe(true);
    expect((preview.body as { unitName?: string }).unitName).toBeDefined();

    // 비소비 검증: 미리보기 후에도 실제 redeem(입주)이 성공해야 함
    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201);
  });

  it('잘못된 코드 미리보기는 valid=false', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/invite-codes/NOPE_INVALID/preview')
      .expect(200);
    expect((res.body as { valid: boolean }).valid).toBe(false);
  });
```

> `tenantToken`은 기존 property e2e가 입주자 가입/로그인으로 만들어 둔 토큰을 재사용한다. 없으면 signup(role 생략=TENANT)+login으로 만든다.

- [ ] **Step 2: 테스트 실패 → 구현 확인 → 통과**

Run: `npm run test:e2e -- property`
Expected: 처음엔 라우트 부재면 FAIL이었겠지만 Task 5에서 구현됨 → 이제 PASS. (미리보기 후에도 redeem 201 = 비소비 보장)

- [ ] **Step 3: 커밋**

```bash
git add test/property.e2e-spec.ts
git commit -m "[M1]test: 초대코드 미리보기 e2e(비소비 보장)"
```

---

## Task 7: 마무리 — 전체 검증

- [ ] **Step 1: 린트 + 전체 테스트**

```bash
npm run lint:check
npm test
npm run test:e2e
```
Expected: 모두 통과(경고 0).

- [ ] **Step 2: Swagger 확인(수동, 선택)**

서버 기동 후 `/docs`에서 `signup`에 `role` 옵션 노출, `GET /invite-codes/:code/preview`가 인증 없이 호출 가능한지 확인.

- [ ] **Step 3: 최종 커밋 없음(각 Task에서 커밋 완료). PR 본문에 스펙 경로 첨부.**

---

## 성공 기준 (스펙 §7 대응)

- `role:"OWNER"` 가입 → `/auth/me` role=OWNER (Task 1,2)
- `role:"ADMIN"` 가입 시도 → 400 (Task 2)
- 유효 코드 미리보기 → valid=true + 건물/호실 이름, **소비되지 않아 이후 redeem 성공** (Task 4,6)
- 잘못/만료 코드 미리보기 → valid=false (Task 4,6)
- 미리보기는 이름만 노출(주소·소유자 제외), rate limit 적용 (Task 4,5)

## 다음 플랜
- FE 온보딩(estate-web): 세션 Route Handler(httpOnly 쿠키), API 클라이언트, 화면 5종 — 별도 플랜 `2026-06-22-onboarding-frontend.md`로 작성 예정.
