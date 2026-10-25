// Messages between the page (UI) and the engine (a Web Worker that holds every sequence).
import type { Quadripartite, TieRule } from './analysis';

export interface RecordMeta {
  uid: number;
  id: string;
  title: string;
  circular: boolean | null;
  source: string;             // file name, "Sample", "Pasted", "NCBI", "Saved"
  sample?: string;            // key of a built-in sample
  origin: number;             // genome coordinate of the first base held
  length: number;             // bases held
  fullLength: number;         // bases in the original record (more when only a stretch was loaded)
  comp: number[];             // A, T, C, G, other
  quad?: Quadripartite | null; // undefined while it is still being looked for
}

export interface Config {
  windows: number[];
  tie: TieRule;
  start: number;              // shown range, genome coordinates (1-based)
  length: number;             // 0 = to the end
  width: number;              // bases per row
  colors: number[][];         // RGB for A, T, C, G, other, background
}

export interface View { uid: number; offset: number; length: number }

/** Where every genome's columns sit in the image the tiles are cut from. */
export interface Layout {
  tv: number;                 // tile version: changes whenever any pixel may change
  ver: number;                // the config the layout belongs to
  W: number;                  // bases per row
  panels: { uid: number; colX: number[]; y: number; rows: number }[];
}

/** One tile: image px [x0, x1) x [y0, y1) of the whole image, averaged over 2^sh px blocks. */
export interface TileReq { key: string; sh: number; x0: number; x1: number; y0: number; y1: number }

export type ParseSource =
  | { kind: 'file'; file: File }
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string };

export interface LoadLimits { from: number; length: number; maxBases: number; maxRecords: number }

export interface ExportJob {
  ver: number;
  width: number;              // image px, before scaling
  height: number;
  margin: number;
  scale: number;              // output px per image px
  panels: { uid: number; colX: number[] }[];
  text: Record<string, string>;
}

export interface Inspection {
  ctx: number[];              // codes around the base (-1 outside the sequence)
  calls: number[];            // the call of each column at the base
  counts: number[][];         // A, T, C, G, other in each column's window
  ranges: [number, number][]; // each window, as view indices [start, end)
}

export type ToEngine =
  | { t: 'boot'; id: number; legacy: string | null; limits: LoadLimits }
  | { t: 'parse'; id: number; src: ParseSource; source: string; limits: LoadLimits }
  | { t: 'samples'; id: number; keys: string[] }
  | { t: 'drop'; uids: number[] }
  | { t: 'order'; uids: number[] }
  | { t: 'config'; id: number; ver: number; cfg: Config; uids: number[] }
  | { t: 'layout'; lay: Layout }
  | { t: 'tiles'; tv: number; reqs: TileReq[] }
  | { t: 'inspect'; id: number; uid: number; pos: number }
  | { t: 'peek'; id: number; uid: number; start: number; n: number }
  | { t: 'export'; id: number; job: ExportJob }
  | { t: 'cancel'; id: number };

export type FromEngine =
  | { t: 'ready'; bitmaps: boolean }
  | { t: 'ok'; id: number; result: unknown }
  | { t: 'err'; id: number; message: string; network?: boolean; aborted?: boolean }
  | { t: 'progress'; id: number; done: number; total: number }
  | { t: 'quad'; uid: number; quad: Quadripartite | null }
  | { t: 'tile'; tv: number; key: string; w: number; h: number; bitmap?: ImageBitmap; rgba?: ArrayBuffer; image?: ImageData };
