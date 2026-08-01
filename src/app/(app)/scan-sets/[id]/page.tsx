import { ScanSetBuilderScreen } from '../../../../web/screens/scan-set-builder';

// /scan-sets/:id (docs/11 §11.8).
export default async function ScanSetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScanSetBuilderScreen id={id} />;
}
