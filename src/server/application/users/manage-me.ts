import type { UserDto } from '../../../shared/contracts/auth';
import type { UpdateMeRequest } from '../../../shared/contracts/users';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { toUserDto } from '../auth/complete-registration';

// GET /api/me (docs/07 §7.3). The caller is already resolved by SessionGuard, so this only maps it.
export class GetMe {
  execute(user: Parameters<typeof toUserDto>[0]): UserDto {
    return toUserDto(user);
  }
}

// PATCH /api/me — profile settings. Absent fields mean "leave unchanged" (docs/07 §7.4); the
// controller refreshes NEXT_LOCALE afterwards so SSR keeps rendering in the chosen language.
export class UpdateMe {
  constructor(private readonly users: UserRepository) {}

  async execute(userId: string, input: UpdateMeRequest): Promise<UserDto> {
    const updated = await this.users.update(userId, {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.theme === undefined ? {} : { theme: input.theme }),
    });
    if (updated === null) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    return toUserDto(updated);
  }
}
