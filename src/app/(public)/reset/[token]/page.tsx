import { ResetScreen } from '../../../../web/screens/reset';

// Route file: composition only (docs/10 §10.1).
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ResetScreen token={token} />;
}
