import type { DocumentFieldSchema } from '../../../shared/contracts/document-fields';

// What the analyst is allowed to choose from (docs/03 §3.3.12): the slug is the stable identifier it
// answers with, the description is the guidance an admin wrote for exactly this.
export type DocumentTypeOption = {
  slug: string;
  name: string;
  description: string | null;
};

// A thing already in the catalogue, as the model is shown it: what sort of thing, which one, and how
// to recognise it (docs/03 §3.3.20).
export type KnownSubject = {
  kind: string;
  name: string;
  note: string | null;
};

// A person already in the catalogue, as the model is shown them (docs/03 §3.3.19): who, and the
// note that tells two of a name apart — whose "also known as" lines, written by merges, are how a
// boarding-pass spelling is recognised as somebody already here.
export type KnownPerson = {
  name: string;
  note: string | null;
};

// What one look at a document yields (docs/05 §5.5 step 4). Every field is independently optional:
// a model that recognises an invoice but cannot tell which country it is from should still be able
// to say so, rather than being pushed into inventing the rest.
export type DocumentAnalysis = {
  // What a person would write on the folder, in the document's own language — "Rental agreement,
  // Njegoševa 12" rather than "IMG_20260714_113355". Null when the excerpt says nothing worth
  // titling, which is a better answer than a title invented out of a file name (docs/03 §3.3.10).
  title: string | null;
  // What the document is, between whom and what for, in a few hundred characters — enough to judge
  // an unfamiliar document without reading it (docs/03 §3.3.10).
  description: string | null;
  // One of the offered slugs, or null when the model picks none of them — or answers with something
  // that was never on the list, which is the same thing as far as the caller is concerned.
  typeSlug: string | null;
  // BCP-47 tags. Read from what the document *is*, not from the shape of its letters: "ŽPCG" and
  // "PODGORICA" say Montenegro to a reader who knows the railway, and say nothing to an n-gram
  // detector (docs/03 §3.3.10).
  languages: string[];
  // ISO 3166-1 alpha-2, upper-case.
  country: string | null;
  // As written in the document, in whatever language it is written in.
  city: string | null;
  // The people the document is about, named as it names them: the parties to a contract, the
  // passenger on a ticket (docs/03 §3.3.19).
  people: string[];
  // The date written on the document — signed, issued, departed — as yyyy-mm-dd.
  date: string | null;
  // What the document is about: the kind of thing and which one (docs/03 §3.3.20).
  subjects: Array<{ kind: string; name: string }>;
  // How well the text this analysis was given represents the document, judged against the pages it
  // was shown (docs/05 §5.5 step 4). The signal nobody had: an OCR pass that recognised nothing
  // reported success, and the only way to notice was to open the document. `null` when the model
  // was shown no pages and so has nothing to compare the text against.
  textQuality: 'GOOD' | 'PARTIAL' | 'NONE' | null;
  // How readable the pages themselves are — focus, lighting, resolution, an edge the desk cut off —
  // out of a hundred (docs/05 §5.5 step 4). A fact about what the archive was handed, as against
  // `extraction` below, which is a fact about what this product did with it.
  legibility: number | null;
  // How faithfully the stored text carries what those pages visibly say, out of a hundred: the same
  // question `textQuality` answers in three words, counted (docs/05 §5.5 step 4).
  //
  // 🔒 Both are `null` where the model answered nothing usable, and null is not nought: a missing
  // mark means the step did not answer that question (docs/03 §3.3.18). Neither gates anything.
  extraction: number | null;
  // What the provider reported spending on this call, when it reports it at all (docs/03 §3.3.18).
  usage?: { promptTokens?: number; completionTokens?: number };
};

// A page of the document as the model is shown it (docs/05 §5.5 step 4): a JPEG, already scaled
// down — a model reads a page, it does not print it.
export type PageImage = { bytes: Buffer };

// What a person has already settled about this document, as both model calls are shown it
// (docs/05 §5.5 step 4). Two kinds of value, one meaning: the ones whose column says who decided —
// the title, the document type, each typed field — and the ones that carry no source of their own,
// where a value differing from the machine's own recorded reading in `autoValues` is precisely a
// person's hand. Which is which is the application layer's to decide; the adapter is only told what
// came out of it.
//
// 🔒 Every string in here was typed by a person, so it travels inside the same nonce-fenced data
// channel as the document text: confirmed is not the same as entitled to give instructions, and a
// title that could order the reading of the document it is attached to would be an injection
// surface this product handed to itself.
export type ConfirmedValues = {
  title?: string;
  // The slug of the type somebody chose, as the model is offered slugs elsewhere.
  typeSlug?: string;
  // yyyy-mm-dd, the shape the analysis answers dates in.
  date?: string;
  country?: string;
  city?: string;
  description?: string;
  people?: readonly string[];
  subjects?: readonly { kind: string; name: string }[];
  // The typed fields a person corrected, keyed as the schema keys them (docs/03 §3.3.10a). The
  // values are whatever the field's kind holds — a string, a number, a money, a table of rows — so
  // they are opaque here and rendered as the JSON they are stored as.
  fields?: Readonly<Record<string, unknown>>;
};

// What the fields step gets back (docs/05 §5.5 step 5): the raw answer, one value per asked key.
// Deliberately unvalidated here — validation is per field, in code, in the application layer
// (docs/03 §3.3.10a), so the adapter stays a transport and the rules stay testable without one.
export type FieldExtraction = {
  values: Record<string, unknown>;
  // How sure the step is of this reading, out of a hundred, once over the whole of it
  // (docs/05 §5.5 step 5). `null` where nothing usable came back — and null is not nought. Kept off
  // `values` by the adapter, so a schema key is never confused with the step's opinion of itself.
  confidence: number | null;
  usage?: { promptTokens?: number; completionTokens?: number };
};

// The AI step is optional in the same way vectorization is (docs/05 §5.5 step 4): unconfigured
// means SKIPPED, not failed.
export abstract class DocumentAnalyst {
  abstract get isConfigured(): boolean;

  // Which host the work goes to (docs/03 §3.3.18); empty when unconfigured.
  abstract get endpoint(): string;

  // The catalogues travel with the request. The kinds, so a model told what "apartment" is called
  // here reuses it instead of inventing a synonym; the things themselves with their notes, so a
  // lease, a bill and an insurance policy about one flat are recognised as being about one flat
  // rather than three; and the people likewise, so a boarding pass files under the person the
  // archive already knows (docs/03 §3.3.19–20a). 🔒 All of them are user-written text and ride
  // inside the fenced data channel, never the system message (docs/05 §5.5 step 4, SEC-55).
  abstract analyze(
    excerpt: string,
    documentTypes: readonly DocumentTypeOption[],
    subjectKinds: readonly string[],
    knownSubjects: readonly KnownSubject[],
    knownPeople: readonly KnownPerson[],
    // What to write in: a BCP-47 tag, or empty for the language of the document itself
    // (docs/05 §5.5).
    language: string,
    // The pages themselves, when there are any to show. A scan whose recognition found nothing has
    // no text to be analysed from — and a document is a picture before it is a string.
    pages?: readonly PageImage[],
    // What a person has confirmed about this document, to read the rest of it by. Absent on a
    // document nobody has touched, which is most of an archive.
    confirmed?: ConfirmedValues,
  ): Promise<DocumentAnalysis>;

  // The fields step (docs/05 §5.5 step 5): the same provider, shown the same text and pages, asked
  // to fill exactly the schema of the document's type. The schema travels as data — key, kind and
  // hint per field — and the answer comes back raw; what parses is decided by the caller.
  abstract extractFields(
    schema: DocumentFieldSchema,
    excerpt: string,
    pages?: readonly PageImage[],
    // The same block the analysis is shown, fields included: the fields of one paper are read
    // together, so a vendor a person corrected says which shop the lines under it belong to.
    confirmed?: ConfirmedValues,
  ): Promise<FieldExtraction>;
}
