import {
  analysisLanguageSchema,
  updateAnalysisLanguageRequestSchema,
  type AnalysisLanguageDto,
  type UpdateAnalysisLanguageRequest,
} from '../../../shared/contracts/settings';
import { apiClient } from '../../shared/api';

// What the analysis writes in (docs/05 §5.5).
export const analysisSettingsApi = {
  read: (): Promise<AnalysisLanguageDto> =>
    apiClient.get('/api/admin/queue/analysis', { schema: analysisLanguageSchema }),

  save: (body: UpdateAnalysisLanguageRequest): Promise<AnalysisLanguageDto> =>
    apiClient.patch('/api/admin/queue/analysis', {
      schema: analysisLanguageSchema,
      body: updateAnalysisLanguageRequestSchema.parse(body),
    }),
};

export const queueKeys = {
  analysis: ['queue', 'analysis'] as const,
};
