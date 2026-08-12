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

// A page of text as paper: black lines on white, lit by a lamp that falls off to the left. `falloff`
// is that lamp — 1 is the even light of a scanner, 0.45 is a sheet photographed with the window on
// one side, which is the picture this correction exists for.
const PAGE = { width: 900, height: 600, lineWidth: 760, lineHeight: 10, lineGap: 44 } as const;

async function litPage(falloff: number): Promise<Buffer> {
  const { width, height, lineWidth, lineHeight, lineGap } = PAGE;
  const pixels = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(
      Array.from({ length: 12 }, (_, line) => ({
        input: {
          create: { width: lineWidth, height: lineHeight, channels: 3, background: '#000000' },
        },
        left: 60,
        top: 40 + line * lineGap,
      })),
    )
    .raw()
    .toBuffer();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const lamp = falloff + (1 - falloff) * (x / (width - 1));
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round((pixels[offset + channel] ?? 0) * lamp);
      }
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

// How much of the page is ink: a correction that lifted the text along with the paper would leave a
// blank sheet that passes every brightness assertion there is.
async function inkShare(image: Buffer): Promise<number> {
  const { data } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (const value of data) if (value < 128) dark += 1;
  return dark / Math.max(1, data.length);
}

// The most ink any single row of pixels holds, as a share of the width. A line of text on a straight
// page fills a row; the same line on a page held at an angle is spread over forty of them.
async function darkestRowShare(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  let most = 0;
  for (let y = 0; y < info.height; y += 1) {
    let dark = 0;
    for (let x = 0; x < info.width; x += 1) if ((data[y * info.width + x] ?? 255) < 128) dark += 1;
    if (dark > most) most = dark;
  }
  return most / info.width;
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

  describe('contentBox', () => {
    it('answers where the content sits, normalized to the whole image', async () => {
      const crop = await images.contentBox(await pageOnWhite());

      // The black rectangle is 100×200 at (150, 100) of a 400×400 frame.
      expect(crop.points).toEqual([
        [0.375, 0.25],
        [0.625, 0.25],
        [0.625, 0.75],
        [0.375, 0.75],
      ]);
    });

    it('answers the whole frame for an image with no border to trim', async () => {
      const crop = await images.contentBox(await landscape(300, 200));

      expect(crop.points).toEqual([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
    });
  });

  describe('applyCrop', () => {
    it('cuts an axis-aligned quad down to its own size', async () => {
      const cropped = await images.applyCrop(await pageOnWhite(), {
        points: [
          [0.375, 0.25],
          [0.625, 0.25],
          [0.625, 0.75],
          [0.375, 0.75],
        ],
      });

      const meta = await sharp(cropped).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(100);
      expect(meta.height).toBe(200);

      // What was cut out is the black rectangle, so the result is black all through.
      const { data } = await sharp(cropped).raw().toBuffer({ resolveWithObject: true });
      expect(Math.max(...data.subarray(0, 300))).toBeLessThan(20);
    });

    it('straightens a page photographed at an angle into a rectangle', async () => {
      // A quad whose top edge is 201 px and whose sides are 380: the result is that rectangle,
      // however slanted the sides were (docs/05 §5.6).
      const cropped = await images.applyCrop(await pageOnWhite(), {
        points: [
          [0.1, 0],
          [0.6, 0.05],
          [0.6, 1],
          [0.1, 0.95],
        ],
      });

      const meta = await sharp(cropped).metadata();
      expect(meta.width).toBe(201);
      expect(meta.height).toBe(380);
    });

    it('refuses a quadrilateral that encloses nothing', async () => {
      await expect(
        images.applyCrop(await pageOnWhite(), {
          points: [
            [0.5, 0.5],
            [0.5, 0.5],
            [0.5, 0.5],
            [0.5, 0.5],
          ],
        }),
      ).rejects.toThrow(/crop/i);
    });
  });

  // What a camera does to a page and a scanner does not (docs/05 §5.5 step 1). Measured on one real
  // photograph — a lab report lit from one side — where levelling took the recognised text from 643
  // characters to 768 and gave back three of the nine rows of its results table, which had been
  // arriving with none.
  describe('correctPage', () => {
    // The mean brightness of the paper in a column of the page: bright where the lamp was, dark
    // where it was not. Sampled between the lines of text so that it is paper being measured.
    async function paperAcross(image: Buffer): Promise<{ left: number; right: number }> {
      const { data, info } = await sharp(image)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // The paper of a strip, read as its 90th percentile: ink is the minority on a page, so the
      // bright end of the strip is the sheet and nothing has to know where the lines of text are.
      const paperOf = (from: number, to: number): number => {
        const values: number[] = [];
        for (let y = 0; y < info.height; y += 1) {
          for (let x = from; x < to; x += 1) values.push(data[y * info.width + x] ?? 0);
        }
        values.sort((a, b) => a - b);
        return values[Math.round((values.length - 1) * 0.9)] ?? 0;
      };
      return {
        left: paperOf(0, Math.round(info.width * 0.2)),
        right: paperOf(Math.round(info.width * 0.8), info.width),
      };
    }

    it('levels a page lit from one side, so both halves read as the same paper', async () => {
      const even = await litPage(1);
      const uneven = await litPage(0.45);

      // The lamp: the shaded edge starts at less than half the brightness of the lit one.
      const before = await paperAcross(uneven);
      expect(before.left / before.right).toBeLessThan(0.6);

      const corrected = await images.correctPage(uneven);
      if (corrected === null) throw new Error('a page lit from one side needed correcting');

      const after = await paperAcross(corrected);
      expect(after.left / after.right).toBeGreaterThan(0.95);
      // And it is paper it was levelled to, not grey: what defeats a single threshold over the
      // whole sheet is a shaded half, and this is the half that was shaded.
      expect(after.left).toBeGreaterThan(230);
      // The text is still there — a correction that lifted the ink with the paper would be a blank
      // page that passes every brightness assertion in this file.
      expect(await inkShare(corrected)).toBeGreaterThan(0.02);
      expect(await inkShare(even)).toBeGreaterThan(0.02);
    });

    // 🔒 The whole risk of this step: a scan that arrives flat and straight must come back as it
    // was, not "corrected" into a worse copy of itself. `null` says so exactly — the caller sends
    // the original bytes on, so there is not even a re-encode to lose detail to.
    it('leaves a flat, evenly lit page alone', async () => {
      expect(await images.correctPage(await litPage(1))).toBeNull();
    });

    it('leaves what it has already corrected alone the second time', async () => {
      const corrected = await images.correctPage(await litPage(0.45));
      if (corrected === null) throw new Error('a page lit from one side needed correcting');

      // Idempotence is the same claim from the other side: if the second pass finds nothing to do,
      // the first one really did level the lighting rather than merely change it.
      expect(await images.correctPage(corrected)).toBeNull();
    });

    // 🔒 The correction assumes dark ink on light paper, and a picture that is the other way round
    // would be brightened into a blank page. It is not a page, and it is left alone.
    it('leaves a picture that is not a lit sheet of paper alone', async () => {
      const darkScreenshot = await sharp({
        create: { width: 900, height: 600, channels: 3, background: '#1e1e1e' },
      })
        .composite(
          Array.from({ length: 12 }, (_, line) => ({
            input: {
              create: { width: 700, height: 8, channels: 3, background: '#d4d4d4' },
            },
            left: 60,
            top: 40 + line * 40,
          })),
        )
        .jpeg()
        .toBuffer();

      expect(await images.correctPage(darkScreenshot)).toBeNull();
    });

    it('straightens a page that was held at an angle', async () => {
      const straight = await litPage(1);
      const held = await sharp(straight).rotate(3, { background: '#ffffff' }).jpeg().toBuffer();

      // Held at 3°, no line of text lands on a row of pixels: the darkest row of the page holds a
      // fraction of the ink its line does.
      expect(await darkestRowShare(held)).toBeLessThan(0.3);

      const corrected = await images.correctPage(held);
      if (corrected === null) throw new Error('a page held at 3° needed straightening');

      // Straightened, a line of text is a row of the image again — which is what a recognizer, and
      // more to the point the table it is reading, needs. Not the whole width: turning a page back
      // widens the frame by the corners it has to keep, so the same line covers less of it.
      expect(await darkestRowShare(corrected)).toBeGreaterThan(0.6);
    });

    it('does not turn a page that is already within a degree of straight', async () => {
      // A rotation resamples every glyph, and below a degree that costs more than it returns: the
      // recognizer straightens each line of text on its own anyway. Measured on the reference
      // photograph, which sits at 0.65°, deskewing it lost text.
      const barelyCrooked = await sharp(await litPage(1))
        .rotate(0.4, { background: '#ffffff' })
        .jpeg()
        .toBuffer();

      expect(await images.correctPage(barelyCrooked)).toBeNull();
    });
  });

  describe('grayscaleRaster', () => {
    it('downscales to the longest side and answers one byte per pixel', async () => {
      const raster = await images.grayscaleRaster(await landscape(1200, 800), 100);

      expect(raster.width).toBe(100);
      expect(raster.height).toBe(67);
      expect(raster.data.length).toBe(100 * 67);
    });

    it('leaves a small image at its own size', async () => {
      const raster = await images.grayscaleRaster(await landscape(80, 40), 400);

      expect({ width: raster.width, height: raster.height }).toEqual({ width: 80, height: 40 });
    });
  });

  // 🔒 SEC-08: the pixel budget. Nest, Next and the queue workers share one process (docs/02
  // ADR-002), so an image bomb that OOMs a processing step takes the HTTP surface with it — and the
  // queue would then detonate it five more times (docs/05 §5.4).
  describe('the pixel budget', () => {
    it('refuses an image past the budget in every pipeline, cheaply and by name', async () => {
      // 100 Mpx of one colour: three megabytes on disk, past the 80 Mpx budget, and ~300 MB of raw
      // RGB if anything ever decoded it. Nothing does — the limit is checked off the header, before
      // a pixel is read, which is why this test costs milliseconds instead of a gigabyte.
      const bomb = await sharp({
        create: { width: 10000, height: 10000, channels: 3, background: '#3355aa' },
      })
        .png({ compressionLevel: 1 })
        .toBuffer();
      expect(bomb.byteLength).toBeLessThan(8 * 1024 * 1024);

      // Every entry point, because a budget one pipeline forgets is no budget: the step fails with
      // a message that says what happened, and the process is still here to run the next document.
      await expect(images.toJpegPreview(bomb, { maxDim: 400 })).rejects.toThrow(/pixel limit/);
      await expect(images.contentBox(bomb)).rejects.toThrow(/pixel limit/);
      await expect(images.grayscaleRaster(bomb, 400)).rejects.toThrow(/pixel limit/);
      await expect(images.correctPage(bomb)).rejects.toThrow(/pixel limit/);
      await expect(
        images.applyCrop(bomb, {
          points: [
            [0.1, 0.1],
            [0.9, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
          ],
        }),
      ).rejects.toThrow(/pixel limit/);
    });

    it('still processes the largest scan a document archive actually produces', async () => {
      // An A3 sheet at 600 dpi is 69.7 Mpx, which is the worst legitimate case and sits under the
      // budget: the guard has to refuse bombs without refusing scanners.
      const a3at600dpi = await sharp({
        create: { width: 9922, height: 7016, channels: 3, background: '#ffffff' },
      })
        .png({ compressionLevel: 1 })
        .toBuffer();

      const preview = await images.toJpegPreview(a3at600dpi, { maxDim: 400 });
      expect((await sharp(preview).metadata()).width).toBe(400);
    });
  });
});
