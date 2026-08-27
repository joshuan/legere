import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  registerCompleteRequestSchema,
  registerStartRequestSchema,
  registerVerifyRequestSchema,
  type LoginRequest,
  type LogoutResponse,
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
import { Login } from '../../application/auth/login';
import { Logout } from '../../application/auth/logout';
import { StartRegistration } from '../../application/auth/start-registration';
import { VerifyEmailCode } from '../../application/auth/verify-email-code';
import type { Session } from '../../domain/entities/session';
import { AppConfig } from '../../infrastructure/config/app-config';
import { successEnvelope } from '../http/envelope';
import { clearSessionCookie, setLocaleCookie, setSessionCookie } from '../http/session-cookie';
import { Throttled } from '../http/throttling';
import { ZodBody } from '../http/zod-validation.pipe';
import { CurrentSession } from './current-user';
import { SessionGuard } from './session.guard';
import type { Envelope } from '../../../shared/contracts/common';

// Auth endpoints (docs/07 §7.3). Controllers stay thin: validate with the contract schema, call the
// use case, map to the envelope. Per-IP throttling covers the whole controller (docs/08 §8.4).
@Controller('auth')
@Throttled('auth')
export class AuthController {
  constructor(
    private readonly getOnboardingStatus: GetOnboardingStatus,
    private readonly startRegistration: StartRegistration,
    private readonly verifyEmailCode: VerifyEmailCode,
    private readonly completeRegistration: CompleteRegistration,
    private readonly login: Login,
    private readonly logout: Logout,
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

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async signIn(
    @ZodBody(loginRequestSchema) body: LoginRequest,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Envelope<UserDto>> {
    const result = await this.login.execute({
      email: body.email,
      password: body.password,
      captchaToken: body.captchaToken,
      ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    setSessionCookie(res, this.config, result.sessionToken);
    setLocaleCookie(res, this.config, result.user.language);
    return successEnvelope(result.user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async signOut(
    @CurrentSession() session: Session,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Envelope<LogoutResponse>> {
    await this.logout.execute(session.id);
    clearSessionCookie(res, this.config);
    return successEnvelope({ ok: true });
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
