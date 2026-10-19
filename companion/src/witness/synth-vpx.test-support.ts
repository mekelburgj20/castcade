/**
 * Synthesises `.vpx`-shaped compound files for tests. `cfb` (SheetJS) is a devDependency used only
 * here; the reader under test shares no code with it. Real tables are never committed (project
 * rule), so every test table is built from these helpers. Excluded from the build by tsconfig.
 */
import * as CFB from 'cfb';

export const utf16 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf16le'));

export const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

export const f32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return b;
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));

/** A regular BIFF record: `[len = 4 + data][tag][data]`. */
export const record = (tag: string, data: Uint8Array): Uint8Array => concat(u32le(4 + data.length), ascii(tag), data);
export const floatRecord = (tag: string, v: number): Uint8Array => record(tag, f32le(v));
/** The irregular CODE record: header length covers only the tag; then `[scriptLen][script]`. */
export const codeRecord = (script: Uint8Array): Uint8Array => concat(u32le(4), ascii('CODE'), u32le(script.length), script);

export interface SynthOptions {
  tableInfo?: Record<string, Uint8Array> | null;
  gameStg?: boolean;
  version?: number;
  gameData?: Uint8Array;
  fillerBytes?: number;
}

export function buildVpx(opts: SynthOptions = {}): Uint8Array {
  const c = CFB.utils.cfb_new();
  if (opts.tableInfo !== null) {
    const info = opts.tableInfo ?? {
      TableName: utf16('Synth Table'),
      AuthorName: utf16('Castcade CI'),
      TableVersion: utf16('1.2'),
      ReleaseDate: utf16('Oct 2026'),
      TableSaveDate: utf16('Sat Oct 18 10:00:00 2026'),
      TableSaveRev: utf16('42'),
      Manufacturer: utf16('Williams'),
      Year: utf16('1998'),
      TableBlurb: utf16('A blurb'),
      Screenshot: new Uint8Array(70_000).fill(0xff),
    };
    for (const [name, bytes] of Object.entries(info)) CFB.utils.cfb_add(c, `/TableInfo/${name}`, Buffer.from(bytes));
  }
  if (opts.gameStg !== false) {
    CFB.utils.cfb_add(c, '/GameStg/Version', Buffer.from(u32le(opts.version ?? 1080)));
    const gameData =
      opts.gameData ??
      concat(
        record('LEFT', u32le(0)),
        floatRecord('GAVT', 1.75),
        floatRecord('FRCT', 0.2),
        codeRecord(ascii("Sub Table1_Init\r\n ' ENDB inside the script must not end parsing\r\nEnd Sub\r\n")),
        floatRecord('SLOP', 6),
        floatRecord('SLPX', 7),
        floatRecord('NDGT', 5),
        record('ENDB', new Uint8Array(0)),
        floatRecord('GAVT', 99), // after ENDB: must be ignored
      );
    CFB.utils.cfb_add(c, '/GameStg/GameData', Buffer.from(gameData));
    if (opts.fillerBytes) {
      // Stands in for the GameItem/Image/Sound bulk; the reader must never touch it.
      CFB.utils.cfb_add(c, '/GameStg/Image0', Buffer.alloc(opts.fillerBytes, 0xa5));
    }
  }
  return new Uint8Array(CFB.write(c, { type: 'buffer' }) as Buffer);
}

/** A table that looks like the owner's Monster Bash VPW mod to the identity code (TableInfo + physics). */
export function buildOwnerStyleVpx(info: { tableName: string; author: string; version: string; saveRev?: string; manufacturer?: string; year?: string }, slope = 6): Uint8Array {
  const tableInfo: Record<string, Uint8Array> = {
    TableName: utf16(info.tableName),
    AuthorName: utf16(info.author),
    TableVersion: utf16(info.version),
    TableSaveDate: utf16('Tue Jan  6 20:19:27 2026'),
    TableSaveRev: utf16(info.saveRev ?? '7'),
  };
  if (info.manufacturer) tableInfo['Manufacturer'] = utf16(info.manufacturer);
  if (info.year) tableInfo['Year'] = utf16(info.year);
  return buildVpx({
    tableInfo,
    gameData: concat(
      floatRecord('GAVT', 1.7629847526550293),
      floatRecord('FRCT', 0.2),
      floatRecord('ELAS', 0.25),
      codeRecord(ascii("Option Explicit\r\nConst cGameName = \"mb_106b\"\r\n")),
      floatRecord('SLOP', slope),
      floatRecord('SLPX', slope + 1),
      record('ENDB', new Uint8Array(0)),
    ),
  });
}
