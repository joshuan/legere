import { AdminLibraryDetailScreen } from '../../../../../web/screens/admin-library-detail';

// Route file: composition only (docs/10 §10.1).
export default async function AdminLibraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminLibraryDetailScreen id={id} />;
}
