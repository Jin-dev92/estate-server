// 소셜 로그인 제공자(닫힌 집합). find-or-create 키의 일부.
export const AuthProvider = { KAKAO: 'KAKAO' } as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];
