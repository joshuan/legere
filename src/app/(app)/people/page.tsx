import { PeopleScreen } from '../../../web/screens/people';
import { currentUser } from '../../_server/current-user';

// A catalogue is content, not administration (docs/11 §11.12a): anyone signed in reads it and adds
// to it, and the affordances that reach across documents are offered to an admin only.
export default async function PeoplePage() {
  const user = await currentUser();
  return <PeopleScreen isAdmin={user?.role === 'ADMIN'} />;
}
