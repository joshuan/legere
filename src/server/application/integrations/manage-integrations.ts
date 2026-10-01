import type { z } from 'zod';
import type {
  integrationTokenRequestSchema,
  IntegrationDto,
} from '../../../shared/contracts/integrations';
import type { CreateApiTokenResponse } from '../../../shared/contracts/users';
import { NotFoundError, ForbiddenError } from '../../domain/errors/domain-error';
import type { IntegrationRepository } from '../../domain/repositories/integration.repository';
import type { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import type { SessionTokens } from '../ports/session-tokens';
import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';
import { API_TOKEN_PREFIX } from '../auth/authenticate-api-token';
import { toApiTokenDto } from '../users/manage-api-tokens';

export class ManageIntegrations {
  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly tokens: ApiTokenRepository,
    private readonly secrets: SessionTokens,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly defaultTtlDays: number,
  ) {}

  async list(userId: string): Promise<{ items: IntegrationDto[] }> {
    return {
      items: (await this.integrations.list(userId)).map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        documentCount: row.documentCount,
      })),
    };
  }
  async create(userId: string, name: string): Promise<IntegrationDto> {
    const row = await this.integrations.create(userId, name);
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      revokedAt: null,
      documentCount: 0,
    };
  }
  async issue(
    userId: string,
    id: string,
    input: z.infer<typeof integrationTokenRequestSchema>,
  ): Promise<CreateApiTokenResponse> {
    const integration = await this.integrations.findOwned(id, userId);
    if (integration === null) throw new NotFoundError('NOT_FOUND');
    if (integration.revokedAt !== null)
      throw new ForbiddenError('This integration has been revoked');
    const token = API_TOKEN_PREFIX + this.secrets.generate().token;
    const now = this.clock.now();
    const row = await this.tokens.create({
      userId,
      integrationId: id,
      name: input.name,
      scope: 'INTEGRATION',
      tokenHash: this.secrets.hash(token),
      expiresAt: new Date(
        now.getTime() + (input.expiresInDays ?? this.defaultTtlDays) * 86_400_000,
      ),
    });
    return { token, apiToken: toApiTokenDto(row, now) };
  }
  async revoke(userId: string, id: string): Promise<void> {
    if ((await this.integrations.findOwned(id, userId)) === null)
      throw new NotFoundError('NOT_FOUND');
    await this.unitOfWork.run((tx) => this.integrations.revoke(id, this.clock.now(), tx));
  }
}
