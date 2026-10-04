import { z } from 'zod';
import {
  ocrResultSchema,
  type OcrElement,
  type OcrPoint,
  type OcrResult,
} from '../../../shared/contracts/page-ocr';
import type { OcrIdentity } from '../../application/ports/page-ocr-provider';

const coordinate = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite());
const point = z.object({ x: coordinate.default(0), y: coordinate.default(0) });
const polygon = z.object({ vertices: z.array(point).min(3) });
const index = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());
const anchor = z.object({
  textSegments: z.array(z.object({ startIndex: index.default(0), endIndex: index })).default([]),
});
const layout = z.object({
  textAnchor: anchor.default({ textSegments: [] }),
  boundingPoly: z.object({
    vertices: z.array(point).optional(),
    normalizedVertices: z.array(point).optional(),
  }),
  confidence: z.number().min(0).max(1).optional(),
});
const item = z.object({ layout });
const matrix = z.object({
  rows: z.number().int(),
  cols: z.number().int(),
  type: z.number().int(),
  data: z.string(),
});
const googleResponse = z.object({
  document: z.object({
    text: z.string().default(''),
    error: z.object({ code: z.number().optional() }).optional(),
    pages: z
      .array(
        z.object({
          image: z
            .object({ width: z.number().positive(), height: z.number().positive() })
            .optional(),
          dimension: z
            .object({ width: z.number().positive(), height: z.number().positive() })
            .optional(),
          transforms: z.array(matrix).default([]),
          blocks: z.array(item).default([]),
          lines: z.array(item).default([]),
          tokens: z.array(item).default([]),
        }),
      )
      .length(1),
  }),
});

// Document AI indices count Unicode characters; JS string.slice counts UTF-16 code units.
export function anchoredText(text: readonly string[], value: z.infer<typeof anchor>): string {
  return value.textSegments
    .map(({ startIndex, endIndex }) => {
      if (endIndex < startIndex || endIndex > text.length)
        throw new Error('OCR text anchor is outside this page');
      return text.slice(startIndex, endIndex).join('');
    })
    .join('');
}

function contains(parent: z.infer<typeof anchor>, child: z.infer<typeof anchor>): boolean {
  return (
    child.textSegments.length > 0 &&
    child.textSegments.every((part) =>
      parent.textSegments.some(
        (outer) => outer.startIndex <= part.startIndex && outer.endIndex >= part.endIndex,
      ),
    )
  );
}

type Matrix = [number, number, number, number, number, number, number, number, number];
function inverse(raw: z.infer<typeof matrix>): Matrix {
  if (raw.cols !== 3 || (raw.rows !== 2 && raw.rows !== 3) || (raw.type !== 5 && raw.type !== 6))
    throw new Error('Unsupported OCR coordinate transform');
  const bytes = Buffer.from(raw.data, 'base64');
  const size = raw.type === 5 ? 4 : 8;
  if (bytes.length !== raw.rows * raw.cols * size)
    throw new Error('Incomplete OCR coordinate transform');
  const values = Array.from({ length: raw.rows * raw.cols }, (_, at) =>
    raw.type === 5 ? bytes.readFloatLE(at * size) : bytes.readDoubleLE(at * size),
  );
  if (raw.rows === 2) values.push(0, 0, 1);
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = values;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new Error('Singular OCR coordinate transform');
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}
function apply(m: Matrix, p: OcrPoint): OcrPoint {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < 1e-12) throw new Error('Invalid OCR perspective coordinate');
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}
function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeGoogle(raw: unknown, input: OcrIdentity): OcrResult {
  const { document } = googleResponse.parse(raw);
  if ((document.error?.code ?? 0) !== 0)
    throw new Error('Google returned a document processing error');
  const page = document.pages[0];
  if (page === undefined) throw new Error('Google returned no page');
  const dimensions = page.image ?? page.dimension ?? input;
  const inverses = page.transforms.map(inverse).reverse();
  const chars = Array.from(document.text);
  const elements: OcrElement[] = [];
  const groups = [
    { level: 'block' as const, items: page.blocks, parents: [] },
    { level: 'line' as const, items: page.lines, parents: page.blocks },
    { level: 'word' as const, items: page.tokens, parents: page.lines },
  ];
  for (const group of groups) {
    for (const [at, entry] of group.items.entries()) {
      const box = entry.layout.boundingPoly;
      const pixels =
        box.normalizedVertices?.map((p) => ({
          x: p.x * dimensions.width,
          y: p.y * dimensions.height,
        })) ?? box.vertices;
      if (pixels === undefined || pixels.length < 3)
        throw new Error('Google returned an element without geometry');
      const parent = group.parents.findIndex((candidate) =>
        contains(candidate.layout.textAnchor, entry.layout.textAnchor),
      );
      elements.push({
        id: `${group.level}-${at}`,
        parentId: parent < 0 ? null : `${group.level === 'word' ? 'line' : 'block'}-${parent}`,
        level: group.level,
        order: at,
        text: anchoredText(chars, entry.layout.textAnchor),
        confidence: entry.layout.confidence ?? null,
        polygon: pixels.map((p) => {
          const original = inverses.reduce((value, transform) => apply(transform, value), p);
          return { x: unit(original.x / input.width), y: unit(original.y / input.height) };
        }),
      });
    }
  }
  return ocrResultSchema.parse({
    ...input,
    schemaVersion: 1,
    provider: 'google-document-ai',
    fullText: document.text,
    elements,
  });
}

const yandexWord = z.object({ text: z.string(), boundingBox: polygon });
const yandexLine = z.object({
  text: z.string(),
  boundingBox: polygon,
  words: z.array(yandexWord).default([]),
});
const yandexResponse = z.object({
  textAnnotation: z.object({
    width: coordinate.pipe(z.number().positive()),
    height: coordinate.pipe(z.number().positive()),
    fullText: z.string().default(''),
    blocks: z
      .array(z.object({ boundingBox: polygon, lines: z.array(yandexLine).default([]) }))
      .default([]),
  }),
});
// Yandex documents TL → BL → BR → TR; our text overlay uses TL → TR → BR → BL.
// Preserve the first corner (and its rotation), changing only the winding of the polygon.
function clockwise(vertices: OcrPoint[]): OcrPoint[] {
  const area = vertices.reduce((sum, point, at) => {
    const next = vertices[(at + 1) % vertices.length];
    return next === undefined ? sum : sum + point.x * next.y - next.x * point.y;
  }, 0);
  return area < 0 ? [...vertices.slice(0, 1), ...vertices.slice(1).reverse()] : vertices;
}

export function normalizeYandex(raw: unknown, input: OcrIdentity): OcrResult {
  const { textAnnotation: page } = yandexResponse.parse(raw);
  const elements: OcrElement[] = [];
  const add = (
    id: string,
    parentId: string | null,
    level: OcrElement['level'],
    text: string,
    box: z.infer<typeof polygon>,
  ) => {
    // Yandex polygons already address the submitted image. `rotate` describes orientation;
    // rotating the polygons again would double-apply it. Input PNGs carry no EXIF orientation.
    elements.push({
      id,
      parentId,
      level,
      text,
      order: elements.length,
      confidence: null,
      polygon: clockwise(box.vertices).map((p) => ({
        x: unit(p.x / page.width),
        y: unit(p.y / page.height),
      })),
    });
  };
  for (const [b, block] of page.blocks.entries()) {
    const blockId = `block-${b}`;
    add(blockId, null, 'block', block.lines.map((line) => line.text).join('\n'), block.boundingBox);
    for (const [l, line] of block.lines.entries()) {
      const lineId = `${blockId}-line-${l}`;
      add(lineId, blockId, 'line', line.text, line.boundingBox);
      for (const [w, word] of line.words.entries())
        add(`${lineId}-word-${w}`, lineId, 'word', word.text, word.boundingBox);
    }
  }
  return ocrResultSchema.parse({
    ...input,
    schemaVersion: 1,
    provider: 'yandex-vision',
    fullText: page.fullText,
    elements,
  });
}
