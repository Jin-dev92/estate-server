// Swagger 문서 설정의 단일 출처(single source).
// 다른 파일에서 제목·경로·보안 스킴명 등을 하드코딩하지 않고 여기를 참조한다.

export const SWAGGER_TITLE = 'estate-server API';
export const SWAGGER_DESCRIPTION =
  '건물주·입주자 커뮤니케이션 플랫폼 백엔드 API 문서';
// 마일스톤(M2.6)에 맞춘 문서 버전. package.json version 과는 수동 동기화한다.
export const SWAGGER_VERSION = '0.2.6';

// Swagger UI가 노출되는 경로 (예: GET /docs, JSON 은 GET /docs-json).
export const SWAGGER_PATH = 'docs';

// Bearer 보안 스킴 이름. 컨트롤러의 @ApiBearerAuth() 인자가 이 값과 일치해야
// Swagger UI 의 Authorize 버튼이 해당 엔드포인트에 토큰을 주입한다.
export const SWAGGER_BEARER_AUTH = 'access-token';

// API 태그 이름. 컨트롤러의 @ApiTags() 인자와 일치해야 하며, setupSwagger 의
// addTag() 로 문서 루트 tags 배열에 선언해 UI 그룹핑/문서 탐색에 노출한다.
// (@ApiTags 만으로는 오퍼레이션에만 태깅되고 문서 루트 tags 는 채워지지 않는다.)
export const SWAGGER_TAG_METRICS = 'metrics';

export const SWAGGER_TAGS = [
  'auth',
  'property',
  'board',
  'chat',
  'notification',
  SWAGGER_TAG_METRICS,
] as const;
