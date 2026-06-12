import { Role } from './role.enum';

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
    if (!input.email) throw new Error('email is required');
    if (!input.name) throw new Error('name is required');
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
}
