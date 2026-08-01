import type { UserLookupQuery, UserLookupResponse } from '../../../shared/contracts/users';
import type { UserRepository } from '../../domain/repositories/user.repository';

// Ten is the whole answer (docs/07 §7.3): enough to pick somebody by name, not enough to walk the
// directory. Any signed-in user may look up, because sharing needs it.
const MAX_RESULTS = 10;

export class LookupUsers {
  constructor(private readonly users: UserRepository) {}

  async execute(query: UserLookupQuery): Promise<UserLookupResponse> {
    const users = await this.users.lookup(query.q, MAX_RESULTS);
    return users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
    }));
  }
}
