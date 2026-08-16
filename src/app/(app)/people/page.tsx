import { PeopleScreen } from '../../../web/screens/people';

// A catalogue is content, not administration (docs/11 §11.12a): anyone signed in reads it and adds
// to it, and the affordances that reach across documents are offered to an admin only — which the
// screen reads from the context the (app) layout provides, so this segment has nothing to await
// (docs/10 §10.2).
export default function PeoplePage() {
  return <PeopleScreen />;
}
