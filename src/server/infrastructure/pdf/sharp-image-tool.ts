import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../application/ports/image-tool';

const DEFAULT_QUALITY = 80;

@Injectable()
export class SharpImageTool extends ImageTool {
  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    return (
      sharp(await toBuffer(source))
        // A photo taken sideways carries its rotation in EXIF only; without this the preview is
        // rotated while every viewer shows the original upright.
        .rotate()
        // `inside` keeps the aspect ratio and bounds the longest side; `withoutEnlargement` leaves a
        // small image at its own size rather than blowing it up into a blurry one.
        .resize({
          width: options.maxDim,
          height: options.maxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        // Flatten onto white: a transparent PNG would otherwise get a black background in JPEG.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: options.quality ?? DEFAULT_QUALITY })
        .toBuffer()
    );
  }

  async trim(source: BinarySource, threshold: number): Promise<Buffer> {
    return sharp(await toBuffer(source))
      .rotate()
      .trim({ threshold })
      .toBuffer();
  }
}
