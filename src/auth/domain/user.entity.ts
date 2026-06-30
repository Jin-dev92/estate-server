import { Role } from './role.enum';
import { DomainError } from '../../common/errors/domain-error';

interface UserProps {
  id: string | null;
  email: string;
  name: string;
  passwordHash: string | null;
  role: Role;
}

export class User {
  private constructor(private readonly props: UserProps) {}

  // 생성 공통 필수값 검증(create·createOAuth 공유).
  private static assertRequired(email: string, name: string): void {
    if (!email) throw new DomainError('이메일은 필수입니다.');
    if (!name) throw new DomainError('이름은 필수입니다.');
  }

  static create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role?: Role;
  }): User {
    User.assertRequired(input.email, input.name);
    return new User({
      id: null,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? Role.TENANT,
    });
  }

  // OAuth 가입: 비밀번호 없이 생성(passwordHash=null).
  static createOAuth(input: { email: string; name: string; role: Role }): User {
    User.assertRequired(input.email, input.name);
    return new User({
      id: null,
      email: input.email,
      name: input.name,
      passwordHash: null,
      role: input.role,
    });
  }

  static reconstitute(props: UserProps): User {
    return new User(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get email(): string {
    return this.props.email;
  }
  get name(): string {
    return this.props.name;
  }
  get role(): Role {
    return this.props.role;
  }
  get passwordHash(): string | null {
    return this.props.passwordHash;
  }

  // 불변: 이름만 바꾼 새 인스턴스를 반환한다.
  rename(name: string): User {
    const trimmed = name?.trim();
    if (!trimmed) throw new DomainError('이름은 필수입니다.');
    return new User({ ...this.props, name: trimmed });
  }

  // 불변: 비밀번호 해시만 바꾼 새 인스턴스를 반환한다.
  changePassword(newHash: string): User {
    return new User({ ...this.props, passwordHash: newHash });
  }
}
