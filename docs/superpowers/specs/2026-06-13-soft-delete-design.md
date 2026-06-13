# 논리삭제(soft delete) 설계 스펙

> 작성일: 2026-06-13 · 상태: 설계 확정(구현 미착수)
> 성격: 데이터 영속성 정책. 엔티티 5개에 `deletedAt` 도입 + 물리삭제 → 논리삭제 전환.
> 선행: M2.6(Swagger) 머지. 브랜치: `dev`에서 분기.
> 관련: [README §5 결정 9 + 알려진 이슈](../../../README.md), [전체 도메인 설계](2026-06-11-building-owner-platform-design.md)

---

## 0. 목적

엔티티 삭제 시 row를 물리적으로 제거하지 않고 `deletedAt` 타임스탬프만 찍어 **데이터를 보존**한다. 두 가지 동기를 충족한다:

- **데이터 복구/실수 방지** — 실수로 지운 게시글·댓글 등 사용자 콘텐츠를 되살릴 수 있다.
- **참조 무결성 보존** — 부모 엔티티(User/Building/Unit)를 지워도 연결된 하위 이력(lease·post·comment)이 깨지지 않는다.

복구(restore) 기능 자체는 이번 범위 밖이며, 스키마만 복구 가능하도록 준비한다.

---

## 1. 현황 & 문제

- ORM: **Prisma + PostgreSQL**, DDD 스타일(순수 도메인 엔티티 ↔ Prisma 모델 분리).
- 모든 DB 접근은 **repository 메서드에 캡슐화**되어 있고 `where` 조건도 그 안에서 수동 작성한다(명시적 스타일).
- 도메인 엔티티는 `createdAt`조차 없는 순수 모델.
- 현재 `deletedAt` 같은 논리삭제 컬럼은 **전혀 없음**.
- 유일한 실제 삭제는 `DeletePostUseCase`의 **물리삭제**(`prisma.post.delete`)이고, `Comment`가 `onDelete: Cascade`라 **게시글을 지우면 댓글이 영구 소실**된다.
- `User`/`Building`/`Unit`은 삭제 기능 자체가 아직 없다.
- `Lease`는 이미 `status(ACTIVE/ENDED)` + `endDate`로 "계약 종료"라는 **도메인 상태**를 표현 중(논리삭제와 성격이 다름).

---

## 2. 적용 범위 판단

| 엔티티 | 판단 | 근거 |
|--------|------|------|
| **Post** | ✅ 적용 | "실수로 지운 글 복구" — 데이터 복구 동기에 정확히 부합. 현재 유일하게 물리삭제 중 |
| **Comment** | ✅ 적용 | 복구 대상 + Post를 soft delete로 바꾸면 `onDelete: Cascade`가 무의미해짐 → 일관성 위해 함께 soft delete |
| **User** | ✅ 적용 | 탈퇴해도 작성한 글·계약·소유 건물이 깨지면 안 됨 — 참조 무결성. (회원 탈퇴 = 전형적 soft delete) |
| **Building** | ✅ 적용 | 건물 삭제해도 하위 Unit·Post 이력 보존 — 참조 무결성 |
| **Unit** | ✅ 적용 | 호실 삭제해도 Lease 이력 보존 — 참조 무결성 |
| **Lease** | ⚠️ **제외** | 이미 `status: ENDED` + `endDate`로 "종료"를 표현 → 의미 중복. 자식이 없는 leaf 엔티티라 무결성 압박도 약함. 계약 취소가 필요하면 `status: CANCELLED` 추가가 더 적절 |

**결정: User/Building/Unit/Post/Comment 5개 적용, Lease 제외.**

---

## 3. 설계 결정 (트레이드오프)

1. **`deletedAt DateTime?`(nullable) 컬럼 방식.** `null` = 살아있음, 값 있음 = 삭제됨.
   - *근거:* "언제 지웠는지"까지 남아 복구·감사에 유리. `isDeleted` 불린은 시점 정보가 없어 기각.

2. **접근 A — Repository 내 수동 필터링.** 각 repository 조회 메서드의 `where`에 `deletedAt: null`을 추가하고, `delete()`는 `update({ deletedAt: new Date() })`로 치환한다. **도메인 엔티티·유스케이스는 soft delete를 전혀 모른다**(repository가 모든 접근을 캡슐화).
   - *근거:* 이 프로젝트의 명시적 repository 패턴·학습 목적에 부합. Prisma 표준 문법만 사용해 동작이 투명하다.
   - *트레이드오프:* 새 조회 메서드 추가 시 `deletedAt: null`을 빠뜨릴 위험(repository 6개로 적어 관리 가능). 빈번해지면 접근 B로 전환.

3. **(기각) 접근 B — Prisma Client Extension 자동 필터링.** `$extends`로 모든 `findX`에 `deletedAt: null`을 자동 주입하고 `delete`를 update로 가로챈다.
   - 빠뜨림을 원천 차단하지만 동작이 숨겨져 "마법적"이고 디버깅이 어렵다. 학습 단계에서 과해 보류(향후 전환 후보).

4. **애플리케이션 레벨 cascade soft delete.** 물리삭제가 사라지면 `Comment`의 DB `onDelete: Cascade`가 작동하지 않는다 → Post를 soft delete할 때 **속한 Comment도 같은 트랜잭션에서 함께** `deletedAt`을 찍는다. 스키마의 `onDelete: Cascade`는 제거한다.
   - *근거:* 기존 Cascade 동작(글 삭제 시 댓글도 사라짐)과 가장 유사하고, 복구 시 함께 되살릴 수 있다.

5. **복구(restore)는 범위 밖.** 스키마는 준비하되 도메인 `softDelete()`/`restore()` 메서드와 복구 유스케이스는 도입하지 않는다(YAGNI). 도입 시 도메인 엔티티에 상태/메서드를 추가한다.

6. **`Lease` 무변경.** 위 §2 판단대로 제외.

---

## 4. 변경 상세

### 4.1 Prisma 스키마 (`prisma/schema.prisma`)

5개 모델에 `deletedAt DateTime?` 추가:

```prisma
model User      { ... deletedAt DateTime?   @@index([deletedAt]) }
model Building  { ... deletedAt DateTime? }
model Unit      { ... deletedAt DateTime? }
model Post      { ... deletedAt DateTime?   @@index([buildingId, deletedAt]) }
model Comment   { ... deletedAt DateTime? }
```

- `Comment.post` 관계에서 **`onDelete: Cascade` 제거**.
- 인덱스: 자주 필터링되는 `Post`는 `(buildingId, deletedAt)` 복합, `User`는 `deletedAt` 단일. Building/Unit/Comment는 조회량이 적어 일단 생략(필요 시 추가).
- `Lease`는 변경 없음.
- 마이그레이션: `prisma migrate dev`로 신규 컬럼 추가(기존 row의 `deletedAt`은 `NULL` = 살아있음).

### 4.2 Repository (5개)

각 Prisma repository에서 캡슐화. 예시(`PrismaPostRepository`):

```ts
// 조회: 모든 find에 deletedAt: null
findById(id)            → where: { id, deletedAt: null }
findByBuilding(bldgId)  → where: { buildingId: bldgId, deletedAt: null }

// 삭제: void 시그니처 유지, 내부만 update로 (cascade 포함은 4.3)
delete(id)              → prisma.post.update({ where: { id }, data: { deletedAt: new Date() } })
```

- 같은 패턴을 User/Building/Unit/Comment repository의 조회 메서드에도 적용한다(현재 삭제 메서드가 없는 엔티티는 조회 필터만).
- 도메인 repository **인터페이스 시그니처는 불변**(`delete(id): Promise<void>` 그대로).

### 4.3 Post 삭제 cascade (`DeletePostUseCase` + `PostRepository`)

cascade 세부는 repository에 메서드로 두어 유스케이스가 모르게 한다:

```ts
// PrismaPostRepository.delete(id) 내부
await this.prisma.$transaction([
  this.prisma.comment.updateMany({
    where: { postId: id, deletedAt: null },
    data: { deletedAt: now },
  }),
  this.prisma.post.update({
    where: { id },
    data: { deletedAt: now },
  }),
]);
```

- `DeletePostUseCase`의 권한 검사(`isAuthoredBy`)·캐시 무효화(`invalidateDetail`/`invalidateList`)는 **그대로 유지**. 호출하는 `posts.delete(id)`의 내부 의미만 물리→논리(+cascade)로 바뀐다.

---

## 5. 알려진 이슈 / 한계

> README §5 "알려진 이슈"와 동일 내용 — 단일 출처는 README, 여기서는 설계 맥락 보존용.

- **`User.email @unique` 충돌:** soft delete된 유저가 이메일을 계속 점유해 같은 이메일 재가입이 막힌다. **현재 User 삭제 유스케이스가 없어** 당장은 무해. 향후 User 삭제 도입 시 복합 unique(`email + deletedAt`)나 이메일 마스킹을 검토.
- **복구(restore) 미구현:** 스키마는 복구 가능하게 준비하지만 도메인/유스케이스는 이번 범위 밖.
- **조회 필터 누락 위험:** 접근 A의 트레이드오프 — 새 조회 메서드 추가 시 `deletedAt: null` 누락 가능. 빈번해지면 Prisma Client Extension(접근 B)으로 전환 검토.

---

## 6. 성공 기준

- [ ] 5개 모델에 `deletedAt` 컬럼 + 마이그레이션 적용, `Lease` 무변경.
- [ ] `Comment`의 `onDelete: Cascade` 제거.
- [ ] 모든 repository 조회가 `deletedAt: null`로 삭제된 row를 제외.
- [ ] Post 삭제 시 물리삭제 대신 Post·하위 Comment가 한 트랜잭션에서 soft delete(둘 다 조회에서 사라짐, DB에는 잔존).
- [ ] 도메인 엔티티·유스케이스·repository 인터페이스 시그니처 불변(soft delete가 인프라에 캡슐화).
- [ ] 기존 테스트 통과 + Post 삭제 cascade 동작 검증 테스트 추가.
