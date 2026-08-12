import { version } from '../../../package.json';

// Which build this process is (docs/11 §11.1). Read from the package the image was built from rather
// than from an environment variable somebody has to remember to set: `npm version` writes it, the
// release tag follows it, and the runtime image carries the file, so the number on the screen and
// the tag on the image cannot drift apart.
export const APP_VERSION: string = version;
