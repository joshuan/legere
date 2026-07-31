import { Global, Module } from '@nestjs/common';
import { FileStorage } from '../../application/ports/file-storage';
import { LibraryReader } from '../../application/ports/library-reader';
import { MimeDetector } from '../../application/ports/mime-detector';
import { FileTypeMimeDetector } from '../library/file-type-mime-detector';
import { FsLibraryReader } from '../library/fs-library-reader';
import { S3FileStorage } from './s3-file-storage';

// The two storages of docs/09 behind one module (docs/06 §6.5): the read-only library volume and
// the private S3 bucket. Global so scan/ingest handlers, the pipeline and the document endpoints can
// inject them without importing this module explicitly.
@Global()
@Module({
  providers: [
    { provide: FileStorage, useClass: S3FileStorage },
    { provide: LibraryReader, useClass: FsLibraryReader },
    { provide: MimeDetector, useClass: FileTypeMimeDetector },
  ],
  exports: [FileStorage, LibraryReader, MimeDetector],
})
export class StorageModule {}
