import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { OAuthError } from '../../application/auth/oauth';

@Catch(OAuthError)
export class OAuthErrorFilter implements ExceptionFilter<OAuthError> {
  catch(error: OAuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    if (error.status === 401) response.setHeader('WWW-Authenticate', 'Basic realm="Legere OAuth"');
    response.status(error.status).json({ error: error.code, error_description: error.message });
  }
}
