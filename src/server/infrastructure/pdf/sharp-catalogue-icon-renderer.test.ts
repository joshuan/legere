import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_CATALOGUE_ICON_BYTES } from '../../../shared/contracts/catalogue-icons';
import { SharpCatalogueIconRenderer } from './sharp-catalogue-icon-renderer';

describe('SharpCatalogueIconRenderer', () => {
  const renderer = new SharpCatalogueIconRenderer();

  it.each(['png', 'jpeg', 'webp'] as const)(
    'contains a %s logo without cropping or stretching it',
    async (format) => {
      const image = await sharp({
        create: { width: 1200, height: 300, channels: 4, background: '#ffd16e' },
      })
        .toFormat(format)
        .toBuffer();
      const rendered = await renderer.render(image);
      expect(await sharp(rendered).metadata()).toMatchObject({
        format: 'webp',
        width: 512,
        height: 128,
      });
    },
  );

  it('orients the logo and strips metadata without upscaling', async () => {
    const image = await sharp({
      create: { width: 100, height: 400, channels: 3, background: '#ffffff' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const metadata = await sharp(await renderer.render(image)).metadata();
    expect(metadata).toMatchObject({ width: 400, height: 100 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('rejects oversized, corrupt and vector input', async () => {
    await expect(renderer.render(Buffer.alloc(MAX_CATALOGUE_ICON_BYTES + 1))).rejects.toMatchObject(
      { httpStatus: 413 },
    );
    await expect(renderer.render(Buffer.from('not an image'))).rejects.toMatchObject({
      httpStatus: 422,
    });
    await expect(
      renderer.render(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      ),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('rejects an image exceeding the input pixel limit', async () => {
    const image = await sharp({
      create: { width: 4001, height: 4001, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await expect(renderer.render(image)).rejects.toMatchObject({ httpStatus: 422 });
  });
});
