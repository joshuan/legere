import sharp from 'sharp';
import { MAX_CATALOGUE_ICON_BYTES } from '../../../shared/contracts/catalogue-icons';
import { CatalogueIconRenderer } from '../../application/ports/catalogue-icon-renderer';
import { PayloadTooLargeError, UnprocessableError } from '../../domain/errors/domain-error';

export class SharpCatalogueIconRenderer extends CatalogueIconRenderer {
  async render(bytes: Buffer): Promise<Buffer> {
    if (bytes.length > MAX_CATALOGUE_ICON_BYTES)
      throw new PayloadTooLargeError('Icon exceeds 2 MiB');
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, animated: false });
      const metadata = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
        throw new Error('Unsupported image');
      }
      return await image
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer();
    } catch {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        'Use a PNG, JPEG or WebP image up to 16 megapixels',
      );
    }
  }
}
