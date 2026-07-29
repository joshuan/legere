import type { OnboardingStatus } from '../../../shared/contracts/auth';
import type { UserRepository } from '../../domain/repositories/user.repository';

// GET /api/auth/onboarding (docs/08 §8.1.1): onboarding is required while the instance has no
// active user; once the first one exists it is closed forever.
export class GetOnboardingStatus {
  constructor(private readonly users: UserRepository) {}

  async execute(): Promise<OnboardingStatus> {
    return { required: (await this.users.countActive()) === 0 };
  }
}
