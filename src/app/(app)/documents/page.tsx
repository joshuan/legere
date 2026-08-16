import { DocumentsScreen } from '../../../web/screens/documents';

// The home screen (docs/11 §11.3). Synchronous, with nothing of its own to fetch: the role its empty
// state needs — an admin is offered the one action that fixes an empty archive, a regular user is
// told who can — reaches the screen through the context the (app) layout provides, so the router
// commits this segment on the press rather than after a second call to /api/me (docs/10 §10.2).
export default function DocumentsPage() {
  return <DocumentsScreen />;
}
