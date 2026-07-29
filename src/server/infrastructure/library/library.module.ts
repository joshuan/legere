import { Global, Module } from '@nestjs/common';
import { LibraryReader } from '../../application/ports/library-reader';
import { FsLibraryReader } from './fs-library-reader';

// Read-only access to the library volume (docs/06 §6.5). Global so scan/ingest handlers and the
// documents module can inject the reader without importing this module explicitly.
@Global()
@Module({
  providers: [{ provide: LibraryReader, useClass: FsLibraryReader }],
  exports: [LibraryReader],
})
export class LibraryModule {}
