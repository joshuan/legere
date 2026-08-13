import type { Response } from 'express';
import { contentDispositionOf } from '../../application/ports/file-storage';
import type { Download } from '../../application/documents/download-document';

// How the two ways bytes leave Legere are written to a response: streamed through the app, or a 302
// to a signed URL (docs/09 §9.1–9.2). Shared, because a document's files and the trash both hand
// over originals and must do it on identical terms.
export function sendDownload(res: Response, download: Download): void {
  // 🔒 Said before the branch, so both ways out say it: what this is, and that a browser may not
  // decide otherwise. The redirect used to return above this block, which is how an uploaded page
  // came back ready to run (SEC-03). The headers on a 302 are courtesy — the browser leaves for the
  // bucket without them — so the same two terms are signed into the URL itself (docs/09 §9.2).
  res.setHeader('Content-Disposition', contentDispositionOf(download.delivery));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (download.kind === 'redirect') {
    res.redirect(302, download.url);
    return;
  }

  res.setHeader('Content-Type', download.delivery.contentType);
  // Absent for the canonical PDF: only the bucket knows how big it is, and asking would cost a round
  // trip to save the client a progress bar.
  if (download.contentLength !== undefined) {
    res.setHeader('Content-Length', download.contentLength.toString());
  }

  // Backpressure comes from pipe (docs/09 §9.1); a read error after the headers are out can only be
  // signalled by dropping the connection.
  download.body.on('error', () => res.destroy());
  download.body.pipe(res);
}
