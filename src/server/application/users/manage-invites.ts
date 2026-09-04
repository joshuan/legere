import type {
  CreateInviteRequest,
  CreateInviteResponse,
  InviteDto,
} from '../../../shared/contracts/users';
import type { InvitePreview } from '../../../shared/contracts/auth';
import { NotFoundError } from '../../domain/errors/domain-error';
import {
  isInviteValid,
  type UserInvite,
  type UserInviteRepository,
} from '../../domain/repositories/user-invite.repository';
import type { Clock } from '../ports/clock';
import type { SecurityEvents } from '../ports/security-events';
import type { SessionTokens } from '../ports/session-tokens';

// Invites default to a week (docs/03 §3.3.4).
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// POST /api/admin/invites (docs/07 §7.3). The URL — and therefore the token — is returned exactly
// once, here; the database only ever holds its hash, so a leaked dump grants nothing.
export class CreateInvite {
  constructor(
    private readonly invites: UserInviteRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly appBaseUrl: string,
    private readonly events: SecurityEvents,
  ) {}

  async execute(input: CreateInviteRequest, createdById: string): Promise<CreateInviteResponse> {
    const { token, hash } = this.tokens.generate();
    const expiresAt = new Date(this.clock.now().getTime() + INVITE_TTL_MS);

    const invite = await this.invites.create({
      tokenHash: hash,
      role: input.role,
      emailHint: input.emailHint ?? null,
      createdById,
      expiresAt,
    });

    // The row and the role it grants, never the link: the token in `url` above is a bearer
    // credential and is returned exactly once, to the admin who asked (docs/06 §6.7).
    this.events.record({
      event: 'invite.issued',
      actor: { userId: createdById },
      target: {
        id: invite.id,
        ...(invite.emailHint === null ? {} : { email: invite.emailHint }),
      },
      detail: { role: invite.role },
    });

    const url = new URL('/invite', this.appBaseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    return {
      id: invite.id,
      url: url.toString(),
      role: invite.role,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

// GET /api/admin/invites — active invites only, never their tokens.
export class ListInvites {
  constructor(
    private readonly invites: UserInviteRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<{ items: InviteDto[] }> {
    const invites = await this.invites.listActive(this.clock.now());
    return { items: invites.map(toInviteDto) };
  }
}

// DELETE /api/admin/invites/:id — revoking is immediate and irreversible.
export class RevokeInvite {
  constructor(
    private readonly invites: UserInviteRepository,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(id: string, actorId: string): Promise<void> {
    const invite = await this.invites.findById(id);
    if (invite === null) throw new NotFoundError('INVITE_NOT_FOUND', 'Invite not found');
    await this.invites.revoke(id, this.clock.now());
    this.events.record({
      event: 'invite.revoked',
      actor: { userId: actorId },
      target: { id },
      detail: { role: invite.role },
    });
  }
}

// POST /api/invites/preview — public landing page data. Reports validity rather than 404-ing, so
// the UI can explain why a link no longer works; the token arrives in JSON, never in the URL.
export class PreviewInvite {
  constructor(
    private readonly invites: UserInviteRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(token: string): Promise<InvitePreview> {
    const invite = await this.invites.findByTokenHash(this.tokens.hash(token));
    if (invite === null) throw new NotFoundError('INVITE_NOT_FOUND', 'Invite not found');

    return {
      role: invite.role,
      emailHint: invite.emailHint,
      expiresAt: invite.expiresAt.toISOString(),
      valid: isInviteValid(invite, this.clock.now()),
    };
  }
}

function toInviteDto(invite: UserInvite): InviteDto {
  return {
    id: invite.id,
    role: invite.role,
    emailHint: invite.emailHint,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
  };
}
