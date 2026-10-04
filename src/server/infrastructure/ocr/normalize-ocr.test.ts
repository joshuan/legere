import { describe, expect, it } from 'vitest';
import { normalizeGoogle, normalizeYandex } from './normalize-ocr';

const input = {
  pageId: '10000000-0000-4000-8000-000000000001',
  imageHash: 'abc',
  width: 100,
  height: 200,
  model: 'test',
};
const vertices = [
  { x: 0, y: 20 },
  { x: 60, y: 20 },
  { x: 60, y: 40 },
  { x: 0, y: 40 },
];
const item = {
  layout: {
    textAnchor: { textSegments: [{ endIndex: '4' }] },
    boundingPoly: { vertices },
    confidence: 0.9,
  },
};
const google = () => ({
  document: { text: 'Я😀42', pages: [{ blocks: [item], lines: [item], tokens: [item] }] },
});

describe('OCR geometry and text normalization', () => {
  it('decodes Unicode character anchors and preserves containment, confidence and order', () => {
    const result = normalizeGoogle(google(), input);
    expect(result.elements.map((entry) => [entry.level, entry.parentId, entry.text])).toEqual([
      ['block', null, 'Я😀42'],
      ['line', 'block-0', 'Я😀42'],
      ['word', 'line-0', 'Я😀42'],
    ]);
    expect(result.elements[2]?.confidence).toBe(0.9);
    expect(result.elements[2]?.polygon).toEqual([
      { x: 0, y: 0.1 },
      { x: 0.6, y: 0.1 },
      { x: 0.6, y: 0.2 },
      { x: 0, y: 0.2 },
    ]);
  });
  it.each([5, 6])('inverts Google deskew/resize matrices of OpenCV type %s', (type) => {
    const values = [2, 0, 10, 0, 2, 20];
    const bytes = Buffer.alloc(values.length * (type === 5 ? 4 : 8));
    values.forEach((value, at) =>
      type === 5 ? bytes.writeFloatLE(value, at * 4) : bytes.writeDoubleLE(value, at * 8),
    );
    const points = vertices.map((p) => ({ x: (p.x * 2 + 10) / 210, y: (p.y * 2 + 20) / 420 }));
    const result = normalizeGoogle(
      {
        document: {
          text: 'Я😀42',
          pages: [
            {
              image: { width: 210, height: 420 },
              transforms: [{ rows: 2, cols: 3, type, data: bytes.toString('base64') }],
              lines: [{ layout: { ...item.layout, boundingPoly: { normalizedVertices: points } } }],
            },
          ],
        },
      },
      input,
    );
    expect(result.elements[0]?.polygon[1]?.x).toBeCloseTo(0.6);
    expect(result.elements[0]?.polygon[1]?.y).toBeCloseTo(0.1);
  });
  it('keeps missing confidence null, accepts omitted zero coordinates and Yandex numeric strings', () => {
    const boundingBox = {
      vertices: [{ y: '20' }, { x: '60', y: '20' }, { x: '60', y: '40' }, { y: '40' }],
    };
    const result = normalizeYandex(
      {
        textAnnotation: {
          width: '100',
          height: '200',
          rotate: 'ANGLE_0',
          fullText: 'Счёт 42',
          blocks: [
            {
              boundingBox,
              lines: [{ boundingBox, text: 'Счёт 42', words: [{ boundingBox, text: '42' }] }],
            },
          ],
        },
      },
      input,
    );
    expect(result.fullText).toBe('Счёт 42');
    expect(result.elements[2]).toMatchObject({
      parentId: 'block-0-line-0',
      confidence: null,
      text: '42',
      polygon: [
        { x: 0, y: 0.1 },
        { x: 0.6, y: 0.1 },
        { x: 0.6, y: 0.2 },
        { x: 0, y: 0.2 },
      ],
    });
  });
  it('keeps rotated Yandex quads in input coordinates and converts their winding for text overlays', () => {
    const boundingBox = {
      vertices: [
        { x: 80, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 80 },
        { x: 80, y: 80 },
      ],
    };
    const result = normalizeYandex(
      {
        textAnnotation: {
          width: 100,
          height: 200,
          rotate: 'ANGLE_90',
          blocks: [{ boundingBox, lines: [{ text: 'ROTATED', boundingBox }] }],
        },
      },
      input,
    );
    expect(result.elements[1]?.polygon).toEqual([
      { x: 0.8, y: 0.1 },
      { x: 0.8, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.1 },
    ]);
  });
  it('handles empty pages without inventing text or confidence', () => {
    expect(normalizeGoogle({ document: { pages: [{}] } }, input).elements).toEqual([]);
    expect(
      normalizeYandex({ textAnnotation: { width: '100', height: '200' } }, input).fullText,
    ).toBe('');
  });
  it('rejects invalid anchors, provider errors and unsupported transforms', () => {
    expect(() => normalizeGoogle({ document: { ...google().document, text: 'x' } }, input)).toThrow(
      'anchor',
    );
    expect(() => normalizeGoogle({ document: { error: { code: 3 }, pages: [{}] } }, input)).toThrow(
      'processing error',
    );
    expect(() =>
      normalizeGoogle(
        { document: { pages: [{ transforms: [{ rows: 3, cols: 3, type: 2, data: '' }] }] } },
        input,
      ),
    ).toThrow('Unsupported');
    expect(() =>
      normalizeYandex({ textAnnotation: { width: '0', height: '200' } }, input),
    ).toThrow();
  });
});
