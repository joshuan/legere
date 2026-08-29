import type { NextFunction, Request, Response } from 'express';

// 🔒 What an unset `TRUST_PROXY` costs, said where it can be observed rather than guessed
// (docs/12 §12.8).
//
// `TRUST_PROXY` is empty by default and that is right for the shipped stack, which publishes the
// app port directly: believing `X-Forwarded-For` with nothing in front to rewrite it lets a caller
// choose their own rate-limit bucket per request (SEC-05). So a boot-time warning is impossible to
// word — at boot the two topologies look identical, and warning on every correct deployment is how
// an operator learns to skip warnings.
//
// A request carrying `X-Forwarded-For` is the one moment they stop looking identical, and since the
// throttle key became one budget per caller rather than one per caller per handler, getting this
// wrong is no longer a matter of degree: behind a proxy `req.ip` is the proxy for everybody, so all
// anonymous callers share a single 20-per-60-second `auth` allowance — and the sign-in page spends
// from it on every load, through `GET /api/auth/onboarding`. Twenty page loads in a minute and the
// whole instance is answering 429.
//
// Said **once per process**, and worded to push neither way: the header is written by whoever sent
// the request, so an attacker can produce this line at will, and a line that read "set TRUST_PROXY"
// would be an attacker asking an operator to switch the per-IP limits off.
const MESSAGE =
  'a request arrived carrying X-Forwarded-For while TRUST_PROXY is empty, so req.ip is whatever connected to this process. ' +
  'If a reverse proxy sits in front of the app, set TRUST_PROXY (docs/12 §12.8): until then every anonymous caller behind it ' +
  'shares one 20-per-60-second auth budget — the sign-in page spends from it on every load — and they are refused together. ' +
  'If the app port is published directly, that header was written by the caller and TRUST_PROXY must stay empty. Said once per process.';

export function forwardedForNotice(warn: (message: string) => void) {
  let said = false;

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!said && req.headers['x-forwarded-for'] !== undefined) {
      said = true;
      warn(MESSAGE);
    }
    next();
  };
}
