import { Controller, Get, HttpCode, HttpStatus, Ip, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  registerCompleteRequestSchema,
  registerStartRequestSchema,
  registerVerifyRequestSchema,
  type OnboardingStatus,
  type RegisterCompleteRequest,
  type RegisterStartRequest,
  type RegisterStartResponse,
  type RegisterVerifyRequest,
  type RegisterVerifyResponse,
  type UserDto,
} from '../../../shared/contracts/auth';
import type { Language } from '../../../shared/contracts/enums';
import { CompleteRegistration } from '../../application/auth/complete-registration';
import { GetOnboardingStatus } from '../../application/auth/get-onboarding-status';
import { StartRegistration } from '../../application/auth/start-registration';
import { VerifyEmailCode } from '../../application/auth/verify-email-code';
import { AppConfig } from '../../infrastructure/config/app-config';
import { successEnvelope } from '../http/envelope';
import { setLocaleCookie, setSessionCookie } from '../http/session-cookie';
import { ZodBody } from '../http/zod-validation.pipe';
import type { Envelope } from '../../../shared/contracts/common';

// Auth endpoints (docs/07 §7.3). Controllers stay thin: validate with the contract schema, call the
// use case, map to the envelope. Login/logout land in M2.4.
@Controller('auth')
export class AuthController {
  constructor(
    private readonly getOnboardingStatus: GetOnboardingStatus,
    private readonly startRegistration: StartRegistration,
    private readonly verifyEmailCode: VerifyEmailCode,
    private readonly completeRegistration: CompleteRegistration,
    private readonly config: AppConfig,
  ) {}

  @Get('onboarding')
  async onboarding(): Promise<Envelope<OnboardingStatus>> {
    return successEnvelope(await this.getOnboardingStatus.execute());
  }

  @Post('register/start')
  @HttpCode(HttpStatus.OK)
  async registerStart(
    @ZodBody(registerStartRequestSchema) body: RegisterStartRequest,
    @Ip() ip: string,
  ): Promise<Envelope<RegisterStartResponse>> {
    return successEnvelope(await this.startRegistration.execute({ ...body, ip }));
  }

  @Post('register/verify')
  @HttpCode(HttpStatus.OK)
  async registerVerify(
    @ZodBody(registerVerifyRequestSchema) body: RegisterVerifyRequest,
  ): Promise<Envelope<RegisterVerifyResponse>> {
    return successEnvelope(await this.verifyEmailCode.execute(body));
  }

  @Post('register/complete')
  @HttpCode(HttpStatus.OK)
  async registerComplete(
    @ZodBody(registerCompleteRequestSchema) body: RegisterCompleteRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Envelope<UserDto>> {
    const result = await this.completeRegistration.execute({
      ticket: body.ticket,
      password: body.password,
      language: preferredLanguage(req.headers['accept-language']),
      userAgent: req.headers['user-agent'] ?? null,
    });

    setSessionCookie(res, this.config, result.sessionToken);
    setLocaleCookie(res, this.config, result.user.language);
    return successEnvelope(result.user);
  }
}

// Language for a brand-new account comes from Accept-Language (docs/08 §8.1.3 step 3); only the two
// supported UI languages exist, and EN is the default (ADR-016).
export function preferredLanguage(acceptLanguage: string | undefined): Language {
  if (acceptLanguage === undefined) return 'EN';
  const preferred = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', qPart] = part.trim().split(';q=');
      return { tag: tag.trim().toLowerCase(), q: qPart === undefined ? 1 : Number(qPart) };
    })
    .filter((entry) => entry.tag !== '' && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q)
    .find((entry) => entry.tag.startsWith('ru') || entry.tag.startsWith('en'));
  return preferred?.tag.startsWith('ru') === true ? 'RU' : 'EN';
}
