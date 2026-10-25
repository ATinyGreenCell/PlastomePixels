// NCBI Nucleotide search and download through E-utilities (which allow cross-origin requests).

export type Kind = 'plastid' | 'mito' | 'plasmid' | 'chromosome' | 'any';

export interface Hit {
  acc: string;           // accession.version
  title: string;
  length: number;
  circular: boolean | null;
}

export interface Found { term: string; count: number; ids: string[]; note: string }

/** Thrown when the request never reached NCBI (offline, or a sandbox that blocks outside requests). */
export class NetworkError extends Error { network = true; }

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
export const ACC_RE = /^[A-Za-z]{1,6}_?\d{4,12}(\.\d+)?$/;
export const PAGE = 20;

// Entrez filters for each kind of record. Length bounds keep gene fragments out of organelle searches.
const KIND_TERMS: Record<Kind, string> = {
  plastid: '(chloroplast[filter] OR plastid[filter]) AND 50000:3000000[SLEN]',
  mito: 'mitochondrion[filter] AND ("complete genome"[Title] OR "complete sequence"[Title])',
  plasmid: 'plasmid[filter] AND "complete sequence"[Title]',
  chromosome: '(chromosome[Title] OR "complete genome"[Title]) AND biomol_genomic[PROP] AND 100000:5000000000[SLEN] NOT (plasmid[filter] OR mitochondrion[filter] OR chloroplast[filter] OR plastid[filter] OR scaffold[Title] OR contig[Title] OR unlocalized[Title] OR unplaced[Title] OR patch[Title] OR "alternate locus"[Title])',
  any: '',
};

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<Response> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set('tool', 'plastome_pixels');
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(`${EUTILS}${path}?${qs}`, { signal: ctl.signal });
    } catch {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (ctl.signal.aborted) throw new Error('NCBI took too long to answer. Try again.');
      throw new NetworkError('NCBI could not be reached.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await pause(1200 * (attempt + 1)); continue; }
    if (res.status === 429) throw new Error('NCBI is limiting requests right now. Wait a few seconds and try again.');
    if (!res.ok) throw new Error(`NCBI answered with error ${res.status}.`);
    return res;
  }
}

/** NCBI's answer as JSON; anything else (a Wi-Fi sign-in page answers 200 too) is said plainly. */
async function json(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(/^\s*</.test(text)
      ? 'A web page answered instead of NCBI. On public Wi-Fi, sign in to it first, then search again.'
      : 'NCBI sent back something unreadable. Try again in a moment.');
  }
}

export function cleanQuery(q: string) {
  return q.replace(/["()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildTerm(q: string, kind: Kind, refseq: boolean, broad: boolean): string {
  const c = cleanQuery(q);
  if (ACC_RE.test(c)) return `${c}[accn]`;
  const parts = [broad ? `(${c})` : `"${c}"[Organism]`];
  if (KIND_TERMS[kind]) parts.push(`(${KIND_TERMS[kind]})`);
  // RefSeq: for chromosomes keep to NC_ records (assembled reference chromosomes and genomes);
  // otherwise any RefSeq record (NC_ organelles, NZ_ plasmids and genomes).
  if (refseq) parts.push(kind === 'chromosome' ? 'NC_000001:NC_999999[accn]' : 'srcdb_refseq[PROP]');
  return parts.join(' AND ');
}

export function websiteSearchURL(term: string) {
  return `https://www.ncbi.nlm.nih.gov/nuccore/?term=${encodeURIComponent(term)}`;
}

async function esearch(term: string, retstart: number, signal?: AbortSignal) {
  const j = await json(await call('esearch.fcgi', { db: 'nuccore', term, retmode: 'json', retmax: PAGE, retstart }, signal));
  const r = j?.esearchresult ?? {};
  if (r.ERROR) throw new Error(`NCBI could not run that search: ${r.ERROR}`);
  return { count: Number(r.count ?? 0), ids: (r.idlist ?? []) as string[] };
}

/**
 * Organism name first ("tobacco", "Nicotiana tabacum"), then any field ("duckweed"), then without the
 * RefSeq restriction. Accessions are looked up directly.
 */
export async function find(q: string, kind: Kind, refseq: boolean, signal?: AbortSignal): Promise<Found> {
  const c = cleanQuery(q);
  if (!c) throw new Error('Type an organism name or an accession.');
  const tries: [boolean, boolean, string][] = ACC_RE.test(c)
    ? [[false, false, '']]
    : [[refseq, false, ''], [refseq, true, '']];
  if (refseq && !ACC_RE.test(c)) {
    const note = 'No RefSeq records matched, so these are all GenBank records.';
    tries.push([false, false, note], [false, true, note]);
  }
  let last = '';
  for (let i = 0; i < tries.length; i++) {
    const [rs, broad, note] = tries[i];
    const term = buildTerm(c, kind, rs, broad);
    last = term;
    if (i > 0) await pause(350); // NCBI allows three requests a second without a key
    const { count, ids } = await esearch(term, 0, signal);
    if (count > 0) return { term, count, ids, note };
  }
  return { term: last, count: 0, ids: [], note: '' };
}

export async function page(term: string, retstart: number, signal?: AbortSignal): Promise<string[]> {
  return (await esearch(term, retstart, signal)).ids;
}

export async function summaries(ids: string[], signal?: AbortSignal): Promise<Hit[]> {
  if (!ids.length) return [];
  const j = await json(await call('esummary.fcgi', { db: 'nuccore', id: ids.join(','), retmode: 'json' }, signal));
  const res = j?.result ?? {};
  const uids: string[] = res.uids ?? ids;
  return uids.map(u => res[u]).filter((d: any) => d && !d.error && d.accessionversion).map((d: any) => ({
    acc: String(d.accessionversion || d.caption || d.uid),
    title: String(d.title || ''),
    length: Number(d.slen) || 0,
    circular: d.topology === 'circular' ? true : d.topology === 'linear' ? false : null,
  }));
}

/** efetch URL for FASTA; `from`/`to` (1-based, inclusive) ask for only that stretch of a long record. */
export function efetchURL(acc: string, from: number | null, to: number | null): string {
  const qs = new URLSearchParams({ db: 'nuccore', id: acc, rettype: 'fasta', retmode: 'text', tool: 'plastome_pixels' });
  if (from !== null && to !== null) { qs.set('seq_start', String(from)); qs.set('seq_stop', String(to)); }
  return `${EUTILS}efetch.fcgi?${qs}`;
}
