// Public API of the page arranger feature (docs/10 §10.1, docs/11 §11.5a): the strip itself, and the
// two questions a file row asks about it — has this file pages to arrange, and has somebody already
// been through them.
export { PageArranger, type PageArrangerProps } from './page-arranger';
export { hasArrangeablePages, isRearranged } from './page-order';
