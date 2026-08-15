import { Param, type PipeTransform } from '@nestjs/common';
import { MAX_FILE_PAGES } from '../../../shared/contracts/documents';
import { NotFoundError } from '../../domain/errors/domain-error';

// A page of a file, counted from zero the way a page order counts (docs/03 §3.3.16).
//
// 🔒 Answered 404 rather than 422 when it is not one, on the same reasoning as a malformed uuid
// (docs/07 §7.1): a page named `-1`, `1e9` or `three` is a page of the file that does not exist, and
// there is nothing else to say about it. The ceiling here is the outer bound of what any file may
// hold; the real limit is the file's own recorded page count, which only the use case knows.
const PAGE_INDEX = /^\d{1,4}$/;

export class PageIndexParamPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!PAGE_INDEX.test(value)) throw new NotFoundError('NOT_FOUND', 'No such page');
    const page = Number(value);
    if (page >= MAX_FILE_PAGES) throw new NotFoundError('NOT_FOUND', 'No such page');
    return page;
  }
}

// `@PageIndexParam('page')` — the shape the file-page routes use.
export function PageIndexParam(name: string): ParameterDecorator {
  return Param(name, new PageIndexParamPipe());
}
