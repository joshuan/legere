import { DocumentsScreen } from '../../../web/screens/documents';
import { currentUser } from '../../_server/current-user';

// The home screen (docs/11 §11.3). The role is resolved here so the empty state can offer an admin
// the one action that fixes it — a regular user is told who can, not shown a button that 404s.
export default async function DocumentsPage() {
  const user = await currentUser();
  return <DocumentsScreen isAdmin={user?.role === 'ADMIN'} />;
}
