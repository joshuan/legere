import { Global, Module } from '@nestjs/common';
import { ImageTool } from '../../application/ports/image-tool';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import { TextExtractor } from '../../application/ports/text-extractor';
import { PdfjsTextExtractor } from './pdfjs-text-extractor';
import { SharpImageTool } from './sharp-image-tool';
import { StirlingPdfToolbox } from './stirling-pdf-toolbox';

// The heavy-operation ports (docs/06 §6.5): the external Stirling container for anything that needs
// LibreOffice or tesseract, and two in-process libraries for the light work (ADR-012).
@Global()
@Module({
  providers: [
    { provide: PdfToolbox, useClass: StirlingPdfToolbox },
    { provide: ImageTool, useClass: SharpImageTool },
    { provide: TextExtractor, useClass: PdfjsTextExtractor },
  ],
  exports: [PdfToolbox, ImageTool, TextExtractor],
})
export class PdfModule {}
