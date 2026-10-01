import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  oauthAuthorizeSchema,
  oauthConsentSchema,
  oauthRegistrationSchema,
  oauthRevocationSchema,
  oauthTokenRequestSchema,
} from '../../../shared/contracts/oauth';
import { OAuth, OAuthError, type OAuthClientCredentials } from '../../application/auth/oauth';
import type { User } from '../../domain/entities/user';
import type { Session } from '../../domain/entities/session';
import { CurrentSession, CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { Throttled } from '../http/throttling';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { OAuthErrorFilter } from './oauth-error.filter';

@Controller('oauth')
@UseFilters(OAuthErrorFilter)
export class OAuthController {
  constructor(private readonly oauth: OAuth) {}
  @Get('metadata')
  @Header('Cache-Control', 'public, max-age=300')
  metadata() {
    return this.oauth.metadata();
  }
  @Get('resource-metadata')
  @Header('Cache-Control', 'public, max-age=300')
  resourceMetadata() {
    return this.oauth.resourceMetadata();
  }
  @Get('archive-resource-metadata')
  @Header('Cache-Control', 'public, max-age=300')
  archiveResourceMetadata() {
    return this.oauth.resourceMetadata(true);
  }
  @Post('register')
  @Throttled('auth')
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: unknown) {
    const parsed = oauthRegistrationSchema.safeParse(body);
    if (!parsed.success)
      throw new OAuthError('invalid_client_metadata', 'Invalid client registration metadata');
    return this.oauth.register(parsed.data);
  }
  @Get('authorize/preview')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async preview(@CurrentSession() _session: Session, @Query() query: unknown) {
    return successEnvelope(await this.oauth.preview(parse(oauthAuthorizeSchema, query)));
  }
  @Post('authorize')
  @UseGuards(SessionGuard)
  @Throttled('auth')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async authorize(
    @CurrentUser() user: User,
    @CurrentSession() _session: Session,
    @Body() body: unknown,
  ) {
    const parsed = parse(oauthConsentSchema, body);
    return successEnvelope(await this.oauth.authorize(user.id, parsed, parsed.decision));
  }
  @Post('token')
  @Throttled('auth')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async token(@Req() request: Request, @Body() body: unknown) {
    requireForm(request);
    const grant = z.object({ grant_type: z.string() }).safeParse(body);
    if (grant.success && !['authorization_code', 'refresh_token'].includes(grant.data.grant_type)) {
      throw new OAuthError('unsupported_grant_type', 'Unsupported grant type');
    }
    const parsed = parse(oauthTokenRequestSchema, body);
    return this.oauth.token(parsed, clientCredentials(request, parsed));
  }
  @Post('revoke')
  @Throttled('auth')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async revoke(@Req() request: Request, @Body() body: unknown) {
    requireForm(request);
    const parsed = parse(oauthRevocationSchema, body);
    await this.oauth.revoke(parsed.token, clientCredentials(request, parsed));
    return {};
  }
}

@Controller('me/oauth-grants')
@UseGuards(SessionGuard)
export class OAuthGrantsController {
  constructor(private readonly oauth: OAuth) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@CurrentUser() user: User, @CurrentSession() _session: Session) {
    return successEnvelope(await this.oauth.listGrants(user.id));
  }
  @Delete(':id')
  async revoke(@CurrentUser() user: User, @UuidParam('id', 'NOT_FOUND', 'Application') id: string) {
    await this.oauth.revokeOwned(user.id, id);
    return successEnvelope({ ok: true });
  }
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new OAuthError('invalid_request', 'Required OAuth parameters are missing or invalid');
  return parsed.data;
}
function requireForm(request: Request): void {
  if (!request.is('application/x-www-form-urlencoded'))
    throw new OAuthError('invalid_request', 'Use application/x-www-form-urlencoded');
}
function clientCredentials(
  request: Request,
  body: { client_id?: string | undefined; client_secret?: string | undefined },
): OAuthClientCredentials {
  const header = request.get('authorization');
  if (header === undefined)
    return {
      id: body.client_id,
      secret: body.client_secret,
      method: body.client_secret === undefined ? 'none' : 'client_secret_post',
    };
  const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header)?.[1];
  if (encoded === undefined || body.client_secret !== undefined)
    throw new OAuthError('invalid_client', 'Invalid client authentication', 401);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) throw new OAuthError('invalid_client', 'Invalid client authentication', 401);
  let id: string;
  let secret: string;
  try {
    id = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '));
    secret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' '));
  } catch {
    throw new OAuthError('invalid_client', 'Invalid client authentication', 401);
  }
  if (
    !z.string().uuid().safeParse(id).success ||
    (body.client_id !== undefined && body.client_id !== id)
  )
    throw new OAuthError('invalid_client', 'Invalid client authentication', 401);
  return { id, secret, method: 'client_secret_basic' };
}
