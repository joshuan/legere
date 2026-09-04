import { InviteScreen } from '../../../web/screens/invite';

// Route file: composition only (docs/10 §10.1). The client reads the token from the URL fragment;
// fragments are never available to or sent through this server component (SEC-38).
export default function InvitePage() {
  return <InviteScreen />;
}
