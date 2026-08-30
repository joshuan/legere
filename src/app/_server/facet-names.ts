import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { listDocumentTypesResponseSchema } from '../../shared/contracts/document-types';
import { personDtoSchema } from '../../shared/contracts/people';
import { subjectKindDtoSchema } from '../../shared/contracts/subject-kinds';
import { subjectDtoSchema } from '../../shared/contracts/subjects';

// The name of the folder a browse page is showing, resolved on the server so the heading is right in
// the first paint rather than after a fetch (docs/11 §11.4). The same loopback origin the session
// check uses — see current-user.ts for why it is not the Host header.
const INTERNAL_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? '3000'}`;

async function fetchJson(path: string): Promise<unknown> {
  const headerList = await headers();
  const response = await fetch(`${INTERNAL_ORIGIN}${path}`, {
    headers: { cookie: headerList.get('cookie') ?? '' },
    cache: 'no-store',
  });
  if (!response.ok) notFound();
  const body: unknown = await response.json();
  return body !== null && typeof body === 'object' && 'data' in body ? body.data : null;
}

// A folder that does not exist is a wrong address, not an empty shelf: answering 404 says which.
export async function fetchDocumentTypeName(id: string): Promise<string> {
  const parsed = listDocumentTypesResponseSchema.safeParse(await fetchJson('/api/document-types'));
  const found = parsed.success
    ? parsed.data.items.find((documentType) => documentType.id === id)
    : undefined;
  if (found === undefined) notFound();
  return found.name;
}

// The catalogues are paginated (SEC-56), so these ask for the one row by id rather than reading a
// page and looking for it there: a row on any page but the first would otherwise be reported as a
// wrong address (docs/07 §7.3, docs/11 §11.4). A 404 from the endpoint is already a `notFound()`,
// since `fetchJson` makes one of every response that is not ok.
export async function fetchPersonName(id: string): Promise<string> {
  const parsed = personDtoSchema.safeParse(await fetchJson(`/api/people/${id}`));
  if (!parsed.success) notFound();
  return parsed.data.name;
}

export async function fetchSubjectName(id: string): Promise<string> {
  const parsed = subjectDtoSchema.safeParse(await fetchJson(`/api/subjects/${id}`));
  if (!parsed.success) notFound();
  return `${parsed.data.name} · ${parsed.data.kind}`;
}

export async function fetchSubjectKindName(id: string): Promise<string> {
  const parsed = subjectKindDtoSchema.safeParse(await fetchJson(`/api/subject-kinds/${id}`));
  if (!parsed.success) notFound();
  return parsed.data.name;
}
