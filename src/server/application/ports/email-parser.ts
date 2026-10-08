import type { BinarySource } from './binary-source';

export type EmailDocument = {
  markdown: string;
  // A trusted template containing escaped text only, never the sender's HTML.
  html: string;
  fields: Record<string, unknown>;
};

export abstract class EmailParser {
  abstract parse(source: BinarySource): Promise<EmailDocument>;
}
