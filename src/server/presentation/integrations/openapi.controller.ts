import { Controller, Get, Header } from '@nestjs/common';
import { AppConfig } from '../../infrastructure/config/app-config';
import { integrationOpenApi } from './openapi';

@Controller()
export class OpenApiController {
  constructor(private readonly config: AppConfig) {}
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  get() {
    return integrationOpenApi(this.config.get('APP_BASE_URL'));
  }
}
