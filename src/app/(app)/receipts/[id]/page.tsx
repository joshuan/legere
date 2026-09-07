import { use } from 'react';
import { ReceiptViewerScreen } from '../../../../web/screens/receipt-viewer';

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ReceiptViewerScreen id={id} />;
}
