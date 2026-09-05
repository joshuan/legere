import { redirect } from 'next/navigation';

export default function LegacyAdminQueuePage() {
  redirect('/admin/processing');
}
