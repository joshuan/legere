import type {
  AnalysisLanguageDto,
  UpdateAnalysisLanguageRequest,
} from '../../../shared/contracts/settings';
import type { SettingsRepository } from '../../domain/repositories/settings.repository';

export const ANALYSIS_SETTINGS_KEY = 'analysis';

// What the analysis writes in (docs/05 §5.5). One language for everything the machine writes, so an
// archive does not end up with a Russian title over an English description. Empty is the behaviour
// that predates the setting: each field in the language of the document it came from.
export class AnalysisSettings {
  constructor(private readonly settings: SettingsRepository) {}

  async read(): Promise<AnalysisLanguageDto> {
    const stored = await this.settings.read(ANALYSIS_SETTINGS_KEY);
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return { language: '' };
    }
    const language = { ...stored }.language;
    return { language: typeof language === 'string' ? language : '' };
  }

  async write(input: UpdateAnalysisLanguageRequest): Promise<AnalysisLanguageDto> {
    const value = { language: input.language.trim() };
    await this.settings.write(ANALYSIS_SETTINGS_KEY, value);
    return value;
  }
}
