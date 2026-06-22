# 터전 디자인 시스템 v0 설계 스펙

> 작성일: 2026-06-22 · 상태: 설계 확정 (구현 미착수)
> 성격: estate-server(건물주↔입주자 커뮤니케이션 플랫폼)의 프론트엔드 디자인 시스템 기반.
> 근거: 제품 스펙 [건물주 플랫폼 설계](../2026-06-11-building-owner-platform-design.md), 디자인 레퍼런스는 개인 위키 노트 `[[ui-ux-reference]]`(토스·당근·Airbnb·Linear 등 모방용 패턴·토큰).

---

## 0. 목적 & 범위

estate-server의 전체 페이지를 일관된 톤으로 만들기 위한 **디자인 토큰 + 컴포넌트 프리미티브 + 전달 방식**을 확정한다. 이 문서가 이후 모든 화면(대시보드·게시판·채팅·알림·건물/호실 관리·온보딩)의 시각 기준이 된다.

- **대상**: FE(별도 레포 `estate-web`, Next.js, estate-server에 git 서브모듈로 포함)
- **스코프 교정**: 제품은 **커뮤니케이션 플랫폼**(공지·게시판·채팅·알림·초대)이다. 결제·구독은 제품 스펙 8.2절에 따라 **범위 밖** — 화면 설계에서 임대료 납부 류를 중심에 두지 않는다.
- **이 문서 밖**: 페이지별 상세 와이어프레임/플로우(영역별 후속 스펙), 다크 모드(YAGNI, 토큰 구조상 후속 추가 가능).

---

## 1. 브랜드 & 원칙

- **메인 컬러**: 딥 틸그린 `#1F8A70` — 집·안심·신뢰·성장. 카카오=노랑처럼 "터전 하면 떠오르는 단일 브랜드 컬러"로 고정한다.
- **성격**: 따뜻한 신뢰 — 당근의 온기 + 토스의 명료함 + Airbnb의 사진·카드 위계.
- **설계 원칙** (위키 `ui-ux-reference` §A):
  1. 단일 강조색(틸그린). 코랄은 온기 포인트로만 제한.
  2. 정보 위계는 색이 아니라 **크기·대비·여백**으로 먼저 잡는다.
  3. 한 화면 한 목적(One Thing Per Screen) / 고급 옵션은 점진적 노출.
  4. 즉각 피드백 + **기능적 모션만**(장식 모션 금지), `prefers-reduced-motion` 존중.
  5. 신뢰 신호 시각화(임대인/임차인 매너온도 게이지), 위험 액션은 재확인.

---

## 2. 컬러 토큰

```
/* Brand (메인) */
--brand-50:  #E6F4F0
--brand-100: #C6E6DD
--brand-500: #1F8A70   /* 메인 컬러 (액션·강조) */
--brand-600: #176B57   /* press */
--brand-700: #0F4D3F

/* Neutral — 따뜻한 그레이(순회색 회피) */
--bg:        #FBFAF8   /* 페이지 베이스 */
--surface:   #FFFFFF   /* 카드/패널 */
--surface-2: #F4F2EE   /* 보조 면·ghost 버튼 */
--text:      #1A2B27   /* 거의 검정(순검정 회피) */
--text-2:    #6B7B76   /* 보조 텍스트 */
--text-3:    #9AA8A3   /* 메타·플레이스홀더 */
--border:    #ECEAE5

/* Semantic */
--success:    #1F8A70  /* 입주중·완료 — 브랜드와 통일 */
--success-bg: #E6F4F0
--warning:    #E8920B  /* 초대코드 만료 임박 */
--warning-bg: #FCF1DC
--danger:     #E5484D  /* 삭제·오류 */
--danger-bg:  #FCEBEC
--neutral:    #9AA8A3  /* 공실·비활성 */
--accent-warm:#FF6B4A  /* NEW·신뢰도 게이지 — 미세 악센트만 */
--warm-bg:    #FFEDE7
```

- 강조색은 브랜드 틸그린 **1개**. 코랄(`accent-warm`)은 "온기 포인트"(NEW 배지·매너온도)로만 쓰고 액션에는 쓰지 않는다 → 단일 강조색 원칙 유지.
- 상태 칩 매핑: `입주중`=success / `공실`=neutral / `만료 D-n`=warning / `NEW`=accent-warm / `삭제`=danger.

---

## 3. 타이포그래피 (Pretendard)

| 토큰 | 크기/굵기 | 용도 |
|---|---|---|
| display | 32 / 700 | 핵심 숫자·대시보드 헤드 (예: 입주 4/5) |
| h1 | 24 / 800 | 페이지 타이틀 |
| h2 | 18 / 700 | 섹션 헤드 |
| h3 | 16 / 700 | 카드 타이틀 |
| body | 15 / 400 | 본문 (모바일 가독성 우선) |
| sm | 13 / 400 | 보조·메타 |
| caption | 12 / 500 | 라벨·타임스탬프 |

- 행간: 본문 1.5 / 헤드 1.2. 자간: 기본 -0.01em, 헤드 -0.03em.
- 숫자는 `font-variant-numeric: tabular-nums`(금액·카운트 정렬).
- 폰트 로드: `next/font`로 Pretendard(가변).

---

## 4. 공간 · 모서리 · 그림자 · 모션

```
spacing  4px 그리드:  4 · 8 · 12 · 16 · 24 · 32 · 48 · 64
radius   --r-sm:10  --r-md:14  --r-lg:20(카드)  --r-full:999(칩·아바타)
shadow   --shadow-card:  0 1px 2px rgba(26,43,39,.04), 0 4px 16px rgba(26,43,39,.05)
         --shadow-hover: 0 2px 4px rgba(26,43,39,.06), 0 10px 28px rgba(26,43,39,.09)
motion   --ease: cubic-bezier(.2,.8,.2,1)
         --dur-fast:120ms  --dur-base:240ms  --dur-slow:400ms
```
모션은 상태 변화를 설명할 때만(전환·호버·카운트업). 장식적 바운스/회전 금지. `prefers-reduced-motion: reduce`면 애니메이션 생략.

---

## 5. 컴포넌트 프리미티브 (`components/ui/*`)

각 프리미티브는 한 가지 책임만 갖고, 위 토큰만 참조한다(하드코딩 색·크기 금지).

- **Button** — variant: primary(브랜드 채움) / secondary(surface-2) / ghost(투명) / danger. size: lg 50 · md 40 · sm 34. `:active` scale .985, hover는 press 색.
- **Field** — 라벨(위) + 인풋(border, focus 시 브랜드 ring) + 헬프/에러 텍스트. 입력 DTO와 1:1.
- **Card / Surface** — surface + border + r-lg + shadow-card, hover lift(translateY -2px).
- **Chip / Badge** — 상태별(2절 매핑). full radius, 12/700.
- **Avatar** — 원형, 이니셜 또는 사진. size sm/md/lg.
- **ListRow** — 아이콘 + (타이틀/설명 2줄) + 우측 메타. 게시판·채팅·알림 목록 공용(당근식 스캔형, 정보 밀도 높게).
- **TrustGauge** — 매너온도식 게이지(임대인/임차인 신뢰도). 코랄 그라데이션 바 + 값.
- **EmptyState** — 일러스트/아이콘 + 한 줄 안내 + 액션. 빈 화면을 부드럽게(당근).
- **Toast / Modal** — 위험·중요 액션은 2버튼 확인 다이얼로그(토스식 재확인).
- **AppShell** — 데스크톱: 좌측 사이드냅 + 상단 앱바. 모바일: 하단 탭바 + 상단 앱바. 앱바 = 로고·검색·알림(미읽음 dot)·아바타.

---

## 6. 전달 방식 — Tailwind v4 + CSS 변수 (Next.js)

토큰은 `:root` **CSS 변수**가 단일 출처(source of truth)이고, Tailwind v4 `@theme`가 이를 유틸리티로 매핑한다. 다크 모드/테마 교체는 CSS 변수만 바꾸면 되도록 둔다.

### 6.1 `app/globals.css`
```css
@import "tailwindcss";

:root {
  --brand-50:#E6F4F0; --brand-100:#C6E6DD; --brand-500:#1F8A70;
  --brand-600:#176B57; --brand-700:#0F4D3F;
  --bg:#FBFAF8; --surface:#FFFFFF; --surface-2:#F4F2EE;
  --text:#1A2B27; --text-2:#6B7B76; --text-3:#9AA8A3; --border:#ECEAE5;
  --success:#1F8A70; --warning:#E8920B; --danger:#E5484D;
  --neutral:#9AA8A3; --accent-warm:#FF6B4A;
  --r-sm:10px; --r-md:14px; --r-lg:20px;
  --shadow-card:0 1px 2px rgba(26,43,39,.04),0 4px 16px rgba(26,43,39,.05);
  --ease:cubic-bezier(.2,.8,.2,1);
}

/* CSS 변수 → Tailwind 토큰 매핑 */
@theme inline {
  --color-brand-50:  var(--brand-50);
  --color-brand-500: var(--brand-500);
  --color-brand-600: var(--brand-600);
  --color-bg:        var(--bg);
  --color-surface:   var(--surface);
  --color-surface-2: var(--surface-2);
  --color-text:      var(--text);
  --color-text-2:    var(--text-2);
  --color-border:    var(--border);
  --color-warning:   var(--warning);
  --color-danger:    var(--danger);
  --color-warm:      var(--accent-warm);
  --radius-lg:       var(--r-lg);
  --ease-brand:      var(--ease);
}
```
→ 사용: `bg-brand-500`, `text-text-2`, `rounded-lg`, `shadow-[var(--shadow-card)]` 등.

### 6.2 컴포넌트 예시 (Button)
```tsx
// components/ui/button.tsx
const styles = {
  primary:   "bg-brand-500 text-white hover:bg-brand-600",
  secondary: "bg-surface-2 text-text hover:brightness-95",
  ghost:     "bg-transparent text-text hover:bg-surface-2",
  danger:    "bg-danger text-white hover:brightness-95",
} as const;

export function Button({ variant = "primary", ...props }) {
  return (
    <button
      className={`h-[50px] rounded-[14px] font-bold text-[15px]
        grid place-items-center transition-[transform,background] duration-[120ms]
        active:scale-[.985] ${styles[variant]}`}
      {...props}
    />
  );
}
```

### 6.3 폰트
```tsx
// app/layout.tsx — next/font로 Pretendard(가변) 로드, body에 적용
```

---

## 7. 범위 밖 (YAGNI)

- **다크 모드** — 토큰이 CSS 변수라 후속 추가 쉬움. 1차 제외.
- **모션 라이브러리(framer 등)** — CSS 트랜지션/소수 카운트업으로 충분. 필요 시 후속.
- **디자인 토큰 빌드 파이프라인(Style Dictionary 등)** — CSS 변수 단일 출처로 충분. 토큰이 커지면 재검토.

---

## 참고
- 제품 도메인·역할·기능: `../2026-06-11-building-owner-platform-design.md`
- 모방용 패턴·토큰 출처: 개인 위키 `notes/design/ui-ux-reference.md` (`[[ui-ux-reference]]`)
- 검증: 임차인 대시보드 목업으로 토큰·레퍼런스 적용을 시각 확인함(테스트용, 레포 외부).
