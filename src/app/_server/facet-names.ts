import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { listDocumentTypesResponseSchema } from '../../shared/contracts/document-types';
import { listPeopleResponseSchema } from '../../shared/contracts/people';
import { listSubjectKindsResponseSchema } from '../../shared/contracts/subject-kinds';
import { listSubjectsResponseSchema } from '../../shared/contracts/subjects';

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

export async function fetchPersonName(id: string): Promise<string> {
  const parsed = listPeopleResponseSchema.safeParse(await fetchJson('/api/people'));
  const found = parsed.success ? parsed.data.items.find((person) => person.id === id) : undefined;
  if (found === undefined) notFound();
  return found.name;
}

export async function fetchSubjectName(id: string): Promise<string> {
  const parsed = listSubjectsResponseSchema.safeParse(await fetchJson('/api/subjects'));
  const found = parsed.success ? parsed.data.items.find((subject) => subject.id === id) : undefined;
  if (found === undefined) notFound();
  return `${found.name} · ${found.kind}`;
}

export async function fetchSubjectKindName(id: string): Promise<string> {
  const parsed = listSubjectKindsResponseSchema.safeParse(await fetchJson('/api/subject-kinds'));
  const found = parsed.success ? parsed.data.items.find((kind) => kind.id === id) : undefined;
  if (found === undefined) notFound();
  return found.name;
}
