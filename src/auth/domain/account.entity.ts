import { AuthProvider } from './auth-provider';

interface AccountProps {
  id: string | null;
  userId: string;
  provider: AuthProvider;
  providerId: string;
}

export class Account {
  private constructor(private readonly props: AccountProps) {}

  static create(input: {
    userId: string;
    provider: AuthProvider;
    providerId: string;
  }): Account {
    return new Account({ id: null, ...input });
  }

  static reconstitute(props: AccountProps): Account {
    return new Account(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get provider(): AuthProvider {
    return this.props.provider;
  }
  get providerId(): string {
    return this.props.providerId;
  }
}
