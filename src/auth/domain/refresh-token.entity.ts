export interface RefreshTokenProps {
  id: string | null;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

// 리프레시 토큰의 상태 판정을 도메인에 모은다.
// 상태 변경 메서드는 새 인스턴스를 반환한다(불변) — 원본을 그대로 두면
// 유스케이스에서 "변경 전/후"를 함께 다루기 쉽다.
export class RefreshToken {
  private constructor(private readonly props: RefreshTokenProps) {}

  static create(input: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): RefreshToken {
    return new RefreshToken({
      id: null,
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    });
  }

  static fromPersistence(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get tokenHash(): string {
    return this.props.tokenHash;
  }
  get familyId(): string {
    return this.props.familyId;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get usedAt(): Date | null {
    return this.props.usedAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  // 갱신에 쓸 수 있는 상태인가. 세 조건이 각각 다른 무효 상태를 배제한다.
  isUsable(now: Date): boolean {
    return (
      this.props.usedAt === null &&
      this.props.revokedAt === null &&
      this.props.expiresAt.getTime() > now.getTime()
    );
  }

  // 이미 회전으로 소비됐는가. 재사용 탐지의 판정 근거이므로
  // "그냥 무효(만료·폐기)"와 반드시 구분해야 한다.
  isUsed(): boolean {
    return this.props.usedAt !== null;
  }

  markUsed(now: Date): RefreshToken {
    return new RefreshToken({ ...this.props, usedAt: now });
  }

  revoke(now: Date): RefreshToken {
    return new RefreshToken({ ...this.props, revokedAt: now });
  }
}
