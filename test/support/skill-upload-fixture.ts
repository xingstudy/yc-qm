import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";

export const skillMarkdown = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Imported ${name}\n${extra}---\nRead references/guide.md and run scripts/run.sh.\n`;

export function skillZip(entries: Array<{ path: string; text: string | Buffer; mode?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = Buffer.from(entry.path);
    const raw = Buffer.from(entry.text);
    const data = deflateRawSync(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x0314, 4);
    header.copy(index, 6, 4, 30);
    index.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function skillTar(entries: Array<{ header: Headers; text?: string }>): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const chunk of tar) chunks.push(chunk);
  })();
  for (const entry of entries) tar.entry(entry.header, entry.text ?? "");
  tar.finalize();
  await reading;
  return gzipSync(Buffer.concat(chunks));
}
