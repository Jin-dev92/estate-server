import { Role } from './role.enum';
import { DomainError } from '../../common/errors/domain-error';

interface UserProps {
  id: string | null;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
}

export class User {
  private constructor(private readonly props: UserProps) {}

  static create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role?: Role;
  }): User {
    if (!input.email) throw new DomainError('이메일은 필수입니다.');
    if (!input.name) throw new DomainError('이름은 필수입니다.');
    return new User({
      id: null,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? Role.TENANT,
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
  get passwordHash(): string {
    return this.props.passwordHash;
  }

  // 불변: 이름만 바꾼 새 인스턴스를 반환한다.
  rename(name: string): User {
    if (!name) throw new DomainError('이름은 필수입니다.');
    return new User({ ...this.props, name });
  }

  // 불변: 비밀번호 해시만 바꾼 새 인스턴스를 반환한다.
  changePassword(newHash: string): User {
    return new User({ ...this.props, passwordHash: newHash });
  }
}
