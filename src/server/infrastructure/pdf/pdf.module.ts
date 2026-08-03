import { Global, Module } from '@nestjs/common';
import { ImageTool } from '../../application/ports/image-tool';
import { DocumentParser } from '../../application/ports/document-parser';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import { DoclingParser } from './docling-parser';
import { SharpImageTool } from './sharp-image-tool';
import { StirlingPdfToolbox } from './stirling-pdf-toolbox';

// The heavy-operation ports (docs/06 §6.5): the external Stirling container owns the whole PDF stack
// — conversion, rendering, OCR and parsing — and sharp does the light image work in process
// (ADR-012). One PDF engine, not two.
@Global()
@Module({
  providers: [
    { provide: PdfToolbox, useClass: StirlingPdfToolbox },
    { provide: ImageTool, useClass: SharpImageTool },
    { provide: DocumentParser, useClass: DoclingParser },
  ],
  exports: [PdfToolbox, ImageTool, DocumentParser],
})
export class PdfModule {}
