import { InviteScreen } from '../../../../web/screens/invite';

// Route file: composition only (docs/10 §10.1).
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteScreen token={token} />;
}
