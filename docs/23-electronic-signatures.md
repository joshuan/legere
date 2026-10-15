# Electronic signatures

Electronic signatures describe immutable original files, not the canonical PDF that Legere
rebuilds from pages. A signature stays with its File across deduplication, page rearrangement,
splitting and combining. Replacing a file never transfers its signatures to the replacement.
The viewer explicitly calls these signatures of originals, including when only some pages of an
original are present. Legere does not sign documents.

## Formats and verification

- Upload detached CMS/PKCS#7 signatures (`.sig`, `.p7s`, DER, PEM or base64) against one selected
  original. Preserve the exact uploaded bytes in private S3. Reject malformed containers, containers
  without signers, signatures with encapsulated content, and signatures that fail verification
  against the selected original. Unsupported algorithms may be stored with an explicit unverified
  state. Filename similarity never establishes that a signature belongs to a file.
- Discover embedded CMS signatures in original PDFs on opening the viewer, including old uploads
  and read-only library originals. Use the PDF object structure and validate ByteRange boundaries,
  the excluded Contents bytes and whether unsigned bytes follow the signed revision. Earlier
  revisions are labelled as such; a valid earlier signature never certifies later changes.
- Parse all signer records and match certificates by issuer/serial or subject-key identifier.
  Show subject, issuer, hexadecimal serial, SHA-256 certificate fingerprint, certificate validity,
  claimed signing time, digest and signature algorithm names/OIDs. Claimed signing time is not a
  verified timestamp. Verify CMS content digests and cryptographic signatures with maintained
  parsing libraries and standard crypto providers, including GOST 2012 for Russian government
  signatures. Unknown algorithms/parameters and missing certificates are explicitly unverified.
- Cryptographic validity, certificate date validity, and certificate trust are separate facts.
  Trust chains, qualified-signature status, revocation (OCSP/CRL) and trusted timestamps are not
  checked. Never show an unconditional legal-validity or trusted-signature badge. Do not make
  external requests to certificate URLs or send original content to verification services.
- XML may contain an independent XMLDSig signature. A signed XML is a separate original, not the
  detached signature of its neighbouring PDF. XMLDSig validation and XML document ingestion are
  outside this CMS/PDF feature; preserve downloaded XML originals independently.

## Persistence and storage

`FileSignature` belongs to `File` with cascading deletion, unique `(fileId, contentHash)`; records
store an immutable upload name, byte size, storage key, upload time, original SHA-256 and a
versioned verification report. At most 20 detached signatures per original, each at most 5 MiB
(also bounded by `UPLOAD_MAX_BYTES`). Objects live at `files/:fileId/signatures/:id.sig`, so existing
trash/purge and orphan cleanup cover their lifecycle. Removing a signature removes its stored
object. Failed persistence cleans up the new object. Original library bytes are never modified.
PDF discovery reads at most the existing 256 MiB binary limit, uses the process-wide whole-file
read gate, and caches only reports in a bounded, short-lived cache keyed by original SHA-256.
Read failures and unsupported/encrypted PDFs are distinct from a successfully checked unsigned PDF.

## API and access

All responses use the normal envelope and shared Zod contracts in `signatures.ts`.

| Method | Path under `/api/documents/:id` | Behavior |
|---|---|---|
| GET | `/signatures` | Per-original discovery status, hashes, detached and embedded signature reports |
| POST | `/files/:fileId/signatures` | Raw upload with `X-Legere-Filename`; metadata-edit permission required |
| GET | `/files/:fileId/signatures/:signatureId/content` | Authorized attachment download |
| DELETE | `/files/:fileId/signatures/:signatureId` | Administrator removes a detached signature |

Every route authenticates and resolves document access; file and signature IDs must belong to a
current original of this document. Signatures never grant access to another original. Read-only
API tokens cannot upload or delete. Concurrent duplicate uploads are idempotent; the limit is
enforced while locking the File row. Malformed CMS returns `SIGNATURE_INVALID` (422), a
cryptographic/content mismatch returns `SIGNATURE_MISMATCH` (422).

## Viewer

The document sidebar identifies originals with electronic signatures and links to Files. Files
shows a localized signature section, an explicit original selector when several files exist,
attachment upload/download/removal, status and expandable signer/certificate details with copyable
serials and fingerprints. The section states the scope and unchecked trust/revocation. Discovery
errors have a retry action; successful unsigned discovery is not an error. Upload completion
refreshes this query without rebuilding the document pipeline.

## Verification

Synthetic CMS/PDF fixtures cover valid and changed content, malformed input, PEM/base64, multiple
signers, missing certificates, unsupported algorithms, PDF byte ranges and later revisions.
Persistence/HTTP checks cover exact byte downloads, access isolation, duplicate uploads, limits,
and file replacement. UI checks cover upload against a chosen original and honest status labels.
Private user examples may be checked locally but must never be committed as fixtures or logged.
