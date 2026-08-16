import { ScreenSkeleton } from '../../web/widgets/screen-skeleton';

// The authenticated area's loading state (docs/10 §10.2, docs/11 §11.1). It is the safety net rather
// than the mechanism: the pages under it await nothing, so a navigation normally commits on the
// press and this is never seen. When a segment does suspend — a cold section, a slow answer — what
// is drawn is the shape of a screen, inside the shell, with the column still where it was.
//
// 🔒 This is the only loading boundary in the tree, and it lives here rather than deeper. A
// `loading.tsx` wraps the child slots of the segment it sits in, so one under `documents/[id]` would
// wrap the tab the viewer rewrites on every press and blank the document being read (docs/10 §10.2).
export default function AppLoading() {
  return <ScreenSkeleton />;
}
