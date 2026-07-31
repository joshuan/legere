import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpImageTool } from './sharp-image-tool';

const images = new SharpImageTool();

// A landscape image, so a rotation is visible in the dimensions rather than only in the pixels.
function landscape(width = 1200, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#3355aa' },
  })
    .jpeg()
    .toBuffer();
}

// A dark page floating in a wide white border — what a photographed sheet looks like to the scanner.
function pageOnWhite(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: {
          create: { width: 100, height: 200, channels: 3, background: '#000000' },
        },
        left: 150,
        top: 100,
      },
    ])
    .png()
    .toBuffer();
}

describe('SharpImageTool', () => {
  describe('toJpegPreview', () => {
    it('bounds the longest side and keeps the aspect ratio', async () => {
      const preview = await images.toJpegPreview(await landscape(1200, 800), { maxDim: 400 });
      const meta = await sharp(preview).metadata();

      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(400);
      // 1200×800 scaled to fit a 400 box: the short side follows, it is not squashed to 400.
      expect(meta.height).toBe(267);
    });

    it('leaves a small image at its own size rather than upscaling it', async () => {
      const preview = await images.toJpegPreview(await landscape(120, 90), { maxDim: 1600 });
      const meta = await sharp(preview).metadata();

      expect(meta.width).toBe(120);
      expect(meta.height).toBe(90);
    });

    it('applies EXIF orientation, so a sideways photo previews upright', async () => {
      // Orientation 6 means "rotate 90° clockwise on display": a viewer shows 800×1200, and the
      // preview has to agree with it instead of showing the stored 1200×800.
      const rotated = await sharp(await landscape(1200, 800))
        .withMetadata({ orientation: 6 })
        .toBuffer();

      const meta = await sharp(await images.toJpegPreview(rotated, { maxDim: 1600 })).metadata();

      expect(meta.width).toBe(800);
      expect(meta.height).toBe(1200);
    });

    it('flattens transparency onto white instead of onto black', async () => {
      const transparent = await sharp({
        create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer();

      const preview = await images.toJpegPreview(transparent, { maxDim: 100 });
      const { data } = await sharp(preview).raw().toBuffer({ resolveWithObject: true });

      expect(data[0]).toBeGreaterThan(240);
      expect(data[1]).toBeGreaterThan(240);
      expect(data[2]).toBeGreaterThan(240);
    });

    it('honours the requested quality', async () => {
      const source = await landscape();
      const [high, low] = await Promise.all([
        images.toJpegPreview(source, { maxDim: 800, quality: 95 }),
        images.toJpegPreview(source, { maxDim: 800, quality: 20 }),
      ]);

      expect(low.length).toBeLessThan(high.length);
    });

    it('accepts a stream as readily as a buffer', async () => {
      const preview = await images.toJpegPreview(Readable.from([await landscape()]), {
        maxDim: 200,
      });

      expect((await sharp(preview).metadata()).width).toBe(200);
    });
  });

  describe('trim', () => {
    it('cuts the uniform border away and leaves the content', async () => {
      const trimmed = await images.trim(await pageOnWhite(), 10);
      const meta = await sharp(trimmed).metadata();

      expect(meta.width).toBe(100);
      expect(meta.height).toBe(200);
    });

    it('leaves an image with no border alone', async () => {
      const meta = await sharp(await images.trim(await landscape(300, 200), 10)).metadata();

      expect(meta.width).toBe(300);
      expect(meta.height).toBe(200);
    });
  });
});
