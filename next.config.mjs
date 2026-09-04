import { createNextConfig } from '@joshuan/next-config';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// ESLint runs as its own strict CI step. Next 15's legacy build-time integration does not fully
// understand our flat shared config and otherwise emits a false "plugin was not detected" warning.
export default withNextIntl(createNextConfig({ legacyBuildLint: true }));
