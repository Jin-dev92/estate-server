import { Transform } from 'class-transformer';

// 문자열 필드의 앞뒤 공백을 제거하는 재사용 데코레이터.
// 식별자·표시용 입력(이름·이메일·제목·주소·코드 등)에만 옵트인으로 적용한다.
// 비밀번호·콘텐츠(게시글/댓글 본문)에는 붙이지 않는다 — 의도된 공백을 변형하면 안 되므로.
// 전역 ValidationPipe({ transform: true })가 켜져 있어 검증 전에 변환이 수행된다.
export function Trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}
