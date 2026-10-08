import { Injectable } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MailParser,
  type AttachmentStream,
  type Headers,
  type HeaderValue,
  type MessageText,
} from 'mailparser';
import { EmailParser, type EmailDocument } from '../../application/ports/email-parser';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const HEADERS = [
  ['subject', 'Subject', 'subject'],
  ['sender', 'From', 'from'],
  ['recipients', 'To', 'to'],
  ['cc', 'Cc', 'cc'],
  ['bcc', 'Bcc', 'bcc'],
  ['replyTo', 'Reply-To', 'reply-to'],
  ['sentAt', 'Date', 'date'],
  ['messageId', 'Message-ID', 'message-id'],
  ['inReplyTo', 'In-Reply-To', 'in-reply-to'],
  ['references', 'References', 'references'],
] as const;

@Injectable()
export class MimeEmailParser extends EmailParser {
  async parse(source: BinarySource): Promise<EmailDocument> {
    const bytes = await toBuffer(source);
    const parser = new MailParser({
      skipImageLinks: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: MAX_TEXT_BYTES,
    });
    let headers: Headers = new Map();
    let body = '';
    const attachments: { name: string; contentType: string; sizeBytes: number }[] = [];
    parser.on('headers', (value: Headers) => {
      headers = value;
    });
    const sink = new Writable({
      objectMode: true,
      write(part: AttachmentStream | MessageText, _encoding, callback) {
        if (part.type === 'text') {
          body = part.text ?? '';
          callback();
          return;
        }
        // Consume attachments without buffering their content; their original bytes stay in EML.
        const drain = async () => {
          if (!(part.content instanceof Readable))
            throw new Error('Invalid email attachment stream');
          for await (const chunk of part.content) void chunk;
          attachments.push({
            name: part.filename ?? '(unnamed)',
            contentType: part.contentType,
            sizeBytes: part.size,
          });
          part.release();
        };
        void drain().then(() => callback(), callback);
      },
    });
    await pipeline(Readable.from([bytes]), parser, sink);
    if (!['from', 'to', 'subject', 'date', 'message-id'].some((key) => headers.has(key))) {
      throw new Error('Invalid EML: expected RFC 5322 message headers such as From or Subject');
    }
    const fields: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const [key, label, header] of HEADERS) {
      const value = headerText(headers.get(header));
      if (value === '') continue;
      fields[key] = value;
      lines.push(`${label}: ${value}`);
    }
    fields.attachments = attachments;
    const text = [
      ...lines,
      '',
      body.trim(),
      ...(attachments.length === 0
        ? []
        : [
            '',
            'Attachments:',
            ...attachments.map(
              (item) => `${item.name} (${item.contentType}, ${item.sizeBytes} bytes)`,
            ),
          ]),
    ].join('\n');
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Decoded email exceeds 8 MiB');
    // A fenced block keeps mail text literal in the common Markdown viewer, including hostile HTML.
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g))
      fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return {
      fields,
      markdown: `${fence}text\n${text}\n${fence}`,
      html:
        '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
        '<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:monospace">' +
        escapeHtml(text) +
        '</pre></body></html>',
    };
  }
}

function headerText(value: HeaderValue | undefined): string {
  if (value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ').trim();
  if (Array.isArray(value)) return value.map((item) => headerText(item)).join(' ');
  if ('text' in value) return headerText(value.text);
  return '';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
