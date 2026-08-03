-- A third kind of document: one a person sent from the browser, whose bytes live in S3 like a
-- scan-set result and unlike a library file (docs/03 §3.3.10, docs/05 §5.1a).
--
-- Hand-written: `prisma migrate dev` also proposed dropping `document_chunks_embedding_idx`,
-- `documents_search_vector_idx` and the `search_vector` default, because those are raw SQL in
-- migration 1 and the Prisma model does not describe them (docs/04 §4.3). Adding an enum value must
-- not take the search indexes with it.
ALTER TYPE "DocumentSource" ADD VALUE 'UPLOAD';
