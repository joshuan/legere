import { ProcessingDashboard } from '../../widgets/processing-dashboard';
import type { AdminProcessingTab } from '../../entities/processing';

export function AdminProcessingScreen({ tab }: { tab?: AdminProcessingTab }) {
  return <ProcessingDashboard {...(tab === undefined ? {} : { tab })} />;
}
