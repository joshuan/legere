import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { CallContext } from '../../application/ports/call-context';
import { SecurityEvents, type SecurityEvent } from '../../application/ports/security-events';

// The value of `context` on every account record, and the one string an operator greps for
// (docs/06 §6.7). nestjs-pino gives each named logger its own instance, so this name is attached by
// the logger rather than written into each call.
export const SECURITY_EVENT_CONTEXT = 'security';

// 🔒 Where an account record goes (docs/06 §6.7): the same stdout stream as everything else, as one
// JSON line, tagged `context: "security"`. Not a second stream — the product ships as one container
// with a read-only root filesystem (docs/12 §12.7), so a file beside the process would be a place
// nothing rotates, nothing ships and `docker compose logs` cannot show.
//
// The record is written at `info` because it is a fact rather than a complaint: a failed login is
// not an application error, and putting the failures at `warn` would hide the *successful* login —
// the line that matters most in an incident — behind whatever level filter caught the noise.
@Injectable()
export class PinoSecurityEvents extends SecurityEvents {
  constructor(
    @InjectPinoLogger(SECURITY_EVENT_CONTEXT) private readonly logger: PinoLogger,
    private readonly calls: CallContext,
  ) {
    super();
  }

  record(event: SecurityEvent): void {
    this.logger.info(
      {
        event: event.event,
        actor: event.actor,
        target: event.target,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        // The id the request already has — pino-http minted it, answered with it as `X-Request-Id`
        // and wrote it on the request line — so a record joins to the request that caused it, and
        // through that to the address it came from. Null off a request (a cron, a job).
        requestId: this.calls.current,
      },
      // pino adds `time`; the message exists so the stream can be filtered by prefix as well as by
      // field, since not every log reader parses JSON.
      `security.${event.event}`,
    );
  }
}
