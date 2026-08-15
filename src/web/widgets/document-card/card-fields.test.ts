import { describe, expect, it } from 'vitest';
import { formatDocumentCardFields, parseDocumentCardFields } from './card-fields';

describe('the card arrangement in the URL (docs/11 §11.3)', () => {
  it('round-trips the extracted-fields option beside the rest', () => {
    expect(parseDocumentCardFields('type,fields')).toEqual(['type', 'fields']);
    expect(formatDocumentCardFields(['type', 'fields'])).toBe('type,fields');
  });

  it('drops a name the contract does not know rather than refusing the URL', () => {
    expect(parseDocumentCardFields('fields,nonsense')).toEqual(['fields']);
  });

  it('keeps absence and emptiness apart: no value is the default, an empty one is title-only', () => {
    expect(parseDocumentCardFields(null)).toBeNull();
    expect(parseDocumentCardFields('')).toEqual([]);
    expect(formatDocumentCardFields(['ext', 'type'])).toBeNull();
  });
});
