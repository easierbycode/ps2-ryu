// Package an AthenaEnv app folder into a launcher-ready PlayStation 2 ISO.
//
// Why this exists: a bare athena.elf can't carry its companion files (athena.ini,
// main.js, images, frames/) through Play!'s bootElf path — Play! (the WASM PS2
// emulator under static/ps2/) only loads the single ELF, so apps that read files
// at runtime render nothing. The fix is to ship the app as a disc image, which
// Play! mounts and athena reads from (cdrom0:). macOS `hdiutil` doesn't emit a
// PS2-spec ISO9660 (Play! reports "Couldn't open executable"), so this writes a
// minimal-but-valid ISO9660 itself — no external tools.
//
// The ISO contains:
//   SYSTEM.CNF        BOOT2 = cdrom0:\ATHA_000.01;1   (the PS2 boot descriptor)
//   ATHA_000.01       the app's athena ELF, renamed (PS2 boot-file convention)
//   <everything else> athena.ini, main.js, *.png, frames/…  — names preserved,
//                     uppercased per ISO9660. PS2 cdvd fileio is case-insensitive,
//                     so athena's lowercase reads (new Image("frames/frame_000.png"))
//                     still resolve.
//
// Usage:
//   deno run -A scripts/build-athena-iso.ts <appDir> [outIso] [bootElfName]
//     appDir      folder with the athena ELF + athena.ini + scripts + assets
//     outIso      output path (default: static/PlayStation2/<appDir-name>.iso)
//     bootElfName ELF to boot (default: athena.elf, else the first *.elf found)
//
// Then load it from the dashboard's PlayStation 2 screen (BYOD), or drop it into
// static/PlayStation2/ and run `deno task ps2:manifest`.

const SECTOR = 2048;
// The only non-deterministic input to the image. Left as the wall clock the
// ISO would otherwise be byte-different on every build, which matters because
// the CMG launcher commits this 5.6MB blob: a rebuild that changed nothing
// would still land a fresh copy in its history. Honour SOURCE_DATE_EPOCH (the
// reproducible-builds convention) so CI can pin it to the source commit's
// date and identical input produces an identical disc.
const NOW = (() => {
  // reading the env is a permission; without --allow-env fall back to the clock
  let epoch: string | undefined;
  try {
    epoch = Deno.env.get("SOURCE_DATE_EPOCH");
  } catch {
    epoch = undefined;
  }
  if (epoch) {
    const seconds = Number(epoch);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000);
    console.error(`[athena-iso] ignoring unparseable SOURCE_DATE_EPOCH "${epoch}"`);
  }
  return new Date();
})();

// ── little binary helpers ────────────────────────────────────────────────────
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u16be(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
// ISO9660 stores many integers "both-endian": LE immediately followed by BE.
const both16 = (v: number) => [...u16le(v), ...u16be(v)];
const both32 = (v: number) => [...u32le(v), ...u32be(v)];

const enc = new TextEncoder();
function ascii(s: string): number[] {
  return [...enc.encode(s)];
}
function strField(s: string, len: number, pad = 0x20): number[] {
  const out = ascii(s).slice(0, len);
  while (out.length < len) out.push(pad);
  return out;
}

// 7-byte directory-record timestamp.
function dirDate(d: Date): number[] {
  return [
    d.getUTCFullYear() - 1900,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    0, // GMT offset in 15-min units
  ];
}
// 17-byte volume-descriptor timestamp ("YYYYMMDDHHMMSScc" + tz byte).
function volDate(d: Date): number[] {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}00`;
  return [...ascii(s), 0];
}

// ── ISO9660 name mapping ─────────────────────────────────────────────────────
// d-characters are A-Z 0-9 _; everything else maps to _. Exactly one dot
// separates name and extension. Files get a ";1" version suffix; dirs don't.
function isoFileId(name: string): string {
  const dot = name.lastIndexOf(".");
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot + 1) : "";
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  base = clean(base);
  ext = clean(ext);
  const id = ext ? `${base}.${ext}` : base;
  return `${id};1`;
}
function isoDirId(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

// directory-record length for an identifier of idLen bytes (padded to even).
function recLen(idLen: number): number {
  const l = 33 + idLen;
  return l + (l % 2);
}

// ── app tree ─────────────────────────────────────────────────────────────────
interface Node {
  name: string; // original on-disk name
  iso: number[]; // identifier bytes ("." => [0], ".." => [1] handled separately)
  isDir: boolean;
  data?: Uint8Array; // files
  children?: Node[]; // dirs
  lba: number;
  size: number; // file size, or dir extent size (bytes)
  ptIndex?: number; // path-table index (dirs)
  parentIndex?: number;
}

const SKIP = /(^\.DS_Store$)|(\.iso$)/i;

async function readTree(dir: string, isoNameOverrides: Record<string, string> = {}): Promise<Node[]> {
  const out: Node[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (SKIP.test(e.name)) continue;
    if (e.isDirectory) {
      out.push({
        name: e.name,
        iso: ascii(isoDirId(e.name)),
        isDir: true,
        children: await readTree(`${dir}/${e.name}`),
        lba: 0,
        size: 0,
      });
    } else if (e.isFile) {
      const data = await Deno.readFile(`${dir}/${e.name}`);
      const isoName = isoNameOverrides[e.name] ?? isoFileId(e.name);
      out.push({ name: e.name, iso: ascii(isoName), isDir: false, data, lba: 0, size: data.length });
    }
  }
  // ISO9660 requires directory entries sorted ascending by identifier.
  out.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const appDir = Deno.args[0];
if (!appDir) {
  console.error("usage: build-athena-iso.ts <appDir> [outIso] [bootElfName]");
  Deno.exit(1);
}
const appName = appDir.replace(/\/+$/, "").split("/").pop() || "athena";
const outIso = Deno.args[1] ?? `static/PlayStation2/${appName}.iso`;
const bootElfName = Deno.args[2] ?? "athena.elf";

// Find the boot ELF and read the whole app folder (the ELF is re-added as
// ATHA_000.01, so skip its original name).
let elf: Uint8Array | null = null;
let elfOrig = bootElfName;
try {
  elf = await Deno.readFile(`${appDir}/${bootElfName}`);
} catch {
  for await (const e of Deno.readDir(appDir)) {
    if (e.isFile && e.name.toLowerCase().endsWith(".elf")) {
      elfOrig = e.name;
      elf = await Deno.readFile(`${appDir}/${e.name}`);
      break;
    }
  }
}
if (!elf) {
  console.error(`[athena-iso] no boot ELF found in ${appDir} (looked for ${bootElfName} / *.elf)`);
  Deno.exit(1);
}

const root = await readTree(appDir);
// Drop the original ELF entry and any pre-existing SYSTEM.CNF — we add our own.
const rootFiles = root.filter((n) => n.name !== elfOrig && n.name.toUpperCase() !== "SYSTEM.CNF");

const systemCnf = enc.encode("BOOT2 = cdrom0:\\ATHA_000.01;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n");
rootFiles.push(
  { name: "SYSTEM.CNF", iso: ascii("SYSTEM.CNF;1"), isDir: false, data: systemCnf, lba: 0, size: systemCnf.length },
  { name: "ATHA_000.01", iso: ascii("ATHA_000.01;1"), isDir: false, data: elf, lba: 0, size: elf.length },
);
rootFiles.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

const rootNode: Node = { name: "", iso: [], isDir: true, children: rootFiles, lba: 0, size: 0 };

// Collect directories in path-table order (breadth-first: parent before child).
const dirs: Node[] = [];
{
  rootNode.ptIndex = 1;
  rootNode.parentIndex = 1;
  const queue: Node[] = [rootNode];
  while (queue.length) {
    const d = queue.shift()!;
    dirs.push(d);
    for (const c of (d.children ?? [])) {
      if (c.isDir) {
        c.ptIndex = dirs.length + queue.length + 1; // assigned in encounter order
        c.parentIndex = d.ptIndex;
        queue.push(c);
      }
    }
  }
  // Re-number sequentially in BFS order to be safe.
  dirs.forEach((d, i) => (d.ptIndex = i + 1));
  for (const d of dirs) {
    for (const c of (d.children ?? [])) if (c.isDir) c.parentIndex = d.ptIndex;
  }
}

// Compute each directory's extent size (entries: "." "..", then children),
// respecting the rule that a record may not cross a 2048-byte boundary.
function dirExtentSize(d: Node): number {
  const idLens = [1, 1, ...(d.children ?? []).map((c) => c.iso.length)];
  let off = 0;
  for (const idLen of idLens) {
    const rl = recLen(idLen);
    if ((off % SECTOR) + rl > SECTOR) off = Math.ceil(off / SECTOR) * SECTOR;
    off += rl;
  }
  return Math.max(SECTOR, Math.ceil(off / SECTOR) * SECTOR);
}
for (const d of dirs) d.size = dirExtentSize(d);

// Path-table size (one record per directory).
function ptRecLen(d: Node): number {
  const idLen = d === rootNode ? 1 : d.iso.length;
  const l = 8 + idLen;
  return l + (idLen % 2); // pad to even
}
const ptBytes = dirs.reduce((s, d) => s + ptRecLen(d), 0);
const ptSectors = Math.max(1, Math.ceil(ptBytes / SECTOR));

// Assign LBAs: [0..15] system, 16 PVD, 17 terminator, path tables, dirs, files.
const ptLLba = 18;
const ptMLba = ptLLba + ptSectors;
let lba = ptMLba + ptSectors;
for (const d of dirs) {
  d.lba = lba;
  lba += d.size / SECTOR;
}
const files: Node[] = [];
(function collect(d: Node) {
  for (const c of (d.children ?? [])) {
    if (c.isDir) collect(c);
    else files.push(c);
  }
})(rootNode);
for (const f of files) {
  f.lba = lba;
  lba += Math.ceil(f.size / SECTOR);
}
const totalSectors = lba;

// ── emit ─────────────────────────────────────────────────────────────────────
const img = new Uint8Array(totalSectors * SECTOR);

function dirRecord(lbaVal: number, sizeVal: number, isDir: boolean, idBytes: number[]): number[] {
  const total = recLen(idBytes.length);
  const b = new Array(total).fill(0);
  b[0] = total;
  b[1] = 0;
  [...both32(lbaVal)].forEach((v, i) => (b[2 + i] = v));
  [...both32(sizeVal)].forEach((v, i) => (b[10 + i] = v));
  dirDate(NOW).forEach((v, i) => (b[18 + i] = v));
  b[25] = isDir ? 0x02 : 0x00;
  b[26] = 0;
  b[27] = 0;
  [...both16(1)].forEach((v, i) => (b[28 + i] = v));
  b[32] = idBytes.length;
  idBytes.forEach((v, i) => (b[33 + i] = v));
  return b;
}

// directory extents
for (const d of dirs) {
  const parent = dirs.find((x) => x.ptIndex === d.parentIndex)!;
  const records: number[][] = [
    dirRecord(d.lba, d.size, true, [0]), // "."
    dirRecord(parent.lba, parent.size, true, [1]), // ".."
    ...(d.children ?? []).map((c) => dirRecord(c.lba, c.size, c.isDir, c.iso)),
  ];
  let off = d.lba * SECTOR;
  let within = 0;
  for (const rec of records) {
    if (within + rec.length > SECTOR) {
      off += SECTOR - within;
      within = 0;
    }
    img.set(rec, off);
    off += rec.length;
    within += rec.length;
  }
}

// path tables (L = little-endian LBA/parent, M = big-endian)
function writePathTable(base: number, be: boolean) {
  let off = base * SECTOR;
  for (const d of dirs) {
    const idBytes = d === rootNode ? [0] : d.iso;
    const rec: number[] = [
      idBytes.length,
      0,
      ...(be ? u32be(d.lba) : u32le(d.lba)),
      ...(be ? u16be(d.parentIndex!) : u16le(d.parentIndex!)),
      ...idBytes,
    ];
    if (idBytes.length % 2) rec.push(0);
    img.set(rec, off);
    off += rec.length;
  }
}
writePathTable(ptLLba, false);
writePathTable(ptMLba, true);

// file data
for (const f of files) img.set(f.data!, f.lba * SECTOR);

// Primary Volume Descriptor (sector 16)
{
  const rootRec = dirRecord(rootNode.lba, rootNode.size, true, [0]);
  const pvd: number[] = [];
  const at = (offset: number, bytes: number[]) => {
    for (let i = 0; i < bytes.length; i++) pvd[offset + i] = bytes[i];
  };
  for (let i = 0; i < SECTOR; i++) pvd[i] = 0;
  pvd[0] = 1; // type: primary
  at(1, ascii("CD001"));
  pvd[6] = 1; // version
  at(8, strField("PLAYSTATION", 32));
  at(40, strField(appName.toUpperCase(), 32));
  at(80, both32(totalSectors)); // volume space size
  at(120, both16(1)); // volume set size
  at(124, both16(1)); // volume sequence number
  at(128, both16(SECTOR)); // logical block size
  at(132, both32(ptBytes)); // path table size
  at(140, u32le(ptLLba)); // L path table location
  at(144, u32le(0)); // optional L path table
  at(148, u32be(ptMLba)); // M path table location
  at(152, u32be(0)); // optional M path table
  at(156, rootRec); // root directory record (34 bytes)
  at(190, strField("", 128)); // volume set id
  at(318, strField("", 128)); // publisher
  at(446, strField("", 128)); // data preparer
  at(574, strField("ATHENAENV", 128)); // application id
  at(702, strField("", 37)); // copyright file id
  at(739, strField("", 37)); // abstract file id
  at(776, strField("", 37)); // bibliographic file id
  at(813, volDate(NOW)); // creation
  at(830, volDate(NOW)); // modification
  at(847, volDate(new Date(0))); // expiration (none)
  at(864, volDate(NOW)); // effective
  pvd[881] = 1; // file structure version
  img.set(pvd.slice(0, SECTOR), 16 * SECTOR);
}

// Volume Descriptor Set Terminator (sector 17)
{
  const t: number[] = new Array(SECTOR).fill(0);
  t[0] = 255;
  ascii("CD001").forEach((v, i) => (t[1 + i] = v));
  t[6] = 1;
  img.set(t, 17 * SECTOR);
}

await Deno.writeFile(outIso, img);
const mb = (img.length / (1024 * 1024)).toFixed(1);
console.log(
  `[athena-iso] wrote ${outIso} — ${mb} MB, ${totalSectors} sectors, ` +
    `${files.length} files, ${dirs.length} dir(s). Boot: ATHA_000.01 (from ${elfOrig}).`,
);
