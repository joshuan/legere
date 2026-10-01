import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, tokenFromFragmentUrl, type TestApp } from './app';
import { cookieNamed, expectData } from './http';

export const IDENTITY_PASSWORD = 'identity-test-passphrase';
export async function onboardIdentity(
  app: TestApp,
  email: string,
  inviter?: string,
): Promise<string> {
  let inviteToken: string | undefined;
  if (inviter !== undefined) {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', inviter)
      .expect(201);
    inviteToken = tokenFromFragmentUrl(expectData(created, createInviteResponseSchema).url);
  }
  await api(app).post('/api/auth/register/start', { email, inviteToken }).expect(200);
  const verified = await api(app)
    .post('/api/auth/register/verify', { email, inviteToken, code: app.emails.lastCodeFor(email) })
    .expect(200);
  const completed = await api(app)
    .post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: IDENTITY_PASSWORD,
    })
    .expect(200);
  const cookie = cookieNamed(completed, 'sid');
  if (cookie === undefined) throw new Error('No session after onboarding');
  return cookie;
}
