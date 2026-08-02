import { redirect } from 'next/navigation';

// `/` is not a screen of its own: the documents grid is the default one (docs/10 §10.2). Who gets it
// is decided one level down — the (app) layout sends a caller without a session to /login, which in
// turn bounces a brand-new instance to /onboarding.
export default function HomePage(): never {
  redirect('/documents');
}
