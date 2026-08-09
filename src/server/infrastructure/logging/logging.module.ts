import { Global, Module } from '@nestjs/common';
import { CallContext } from '../../application/ports/call-context';
import { SecurityEvents } from '../../application/ports/security-events';
import { AsyncLocalCallContext } from './async-call-context';
import { PinoSecurityEvents } from './pino-security-events';

// The two things every layer may need to say something about the call it is inside (docs/06 §6.7):
// the correlation id of the request or job in progress, and the account journal written under it.
// Global, because the alternative is listing it in every feature module that touches an account —
// and the one instance is what makes the id an HTTP middleware puts in reach of a use case eight
// frames away.
@Global()
@Module({
  providers: [
    { provide: CallContext, useClass: AsyncLocalCallContext },
    { provide: SecurityEvents, useClass: PinoSecurityEvents },
  ],
  exports: [CallContext, SecurityEvents],
})
export class LoggingModule {}
