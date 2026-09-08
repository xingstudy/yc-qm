import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { fromBuffer, type ZipFile } from "yauzl";
import { SKILL_UPLOAD_MAX_BYTES, type SkillUpload } from "../../plugins/chassis/src/skill-import.ts";
import type { FetchedRepo, RepoFile } from "./ingest.ts";
import { isProbablyBinary } from "./seed.ts";

const MAX_FILES = 5000;
const MAX_BYTES = 32 * 1024 * 1024;

function archivePath(raw: string): string {
  const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !path ||
    path.length > 1024 ||
    /[\\\x00-\x1f:]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Archive contains an unsafe path");
  return path;
}

export async function readSkillUpload(input: SkillUpload): Promise<FetchedRepo> {
  if (
    !input ||
    typeof input.name !== "string" ||
    typeof input.base64 !== "string" ||
    input.name.length > 255 ||
    !input.base64 ||
    input.base64.length > Math.ceil(SKILL_UPLOAD_MAX_BYTES / 3) * 4 ||
    input.base64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(input.base64)
  ) {
    throw new Error("Upload must be a valid file of at most 8 MiB");
  }
  const data = Buffer.from(input.base64, "base64");
  if (data.toString("base64") !== input.base64) throw new Error("Invalid upload encoding");
  if (data.length > SKILL_UPLOAD_MAX_BYTES) throw new Error("Upload exceeds 8 MiB");
  const files: RepoFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  let entries = 0;
  const checkEntry = (raw: string): string => {
    if (++entries > MAX_FILES) throw new Error("Archive exceeds 5000 entries");
    const path = archivePath(raw);
    if (paths.has(path)) throw new Error("Archive contains duplicate paths");
    paths.add(path);
    return path;
  };
  const read = async (stream: AsyncIterable<Buffer>, size: number): Promise<Buffer> => {
    if (size > MAX_BYTES - total) throw new Error("Expanded archive exceeds 32 MiB");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_BYTES) throw new Error("Expanded archive exceeds 32 MiB");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const add = (path: string, bytes: Buffer, executable = false): void => {
    if (path.split("/").some((part) => part === ".git" || part === "__MACOSX" || part === ".DS_Store")) return;
    const binary = isProbablyBinary(bytes);
    files.push({
      path,
      text: binary ? "" : bytes.toString("utf8"),
      binary,
      ...(binary ? { base64: bytes.toString("base64") } : {}),
      ...(executable ? { executable: true } : {}),
    });
  };
  if (/\.zip$/i.test(input.name)) {
    const zip = await new Promise<ZipFile>((resolve, reject) => {
      fromBuffer(data, { lazyEntries: true, strictFileNames: true }, (err, result) => {
        if (err) reject(err);
        else resolve(result!);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry) => {
          void (async () => {
            const path = checkEntry(entry.fileName);
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (entry.isEncrypted() || (mode && mode !== 0o100000 && mode !== 0o040000)) {
              throw new Error("Encrypted files, links and special files are not supported");
            }
            if (!entry.fileName.endsWith("/")) {
              const stream = await new Promise<Readable>((res, rej) => {
                zip.openReadStream(entry, (err, value) => (err ? rej(err) : res(value!)));
              });
              add(
                path,
                await read(stream, entry.uncompressedSize),
                ((entry.externalFileAttributes >>> 16) & 0o111) !== 0,
              );
            }
            zip.readEntry();
          })().catch(reject);
        });
        zip.readEntry();
      });
    } finally {
      zip.close();
    }
  } else if (/\.(tar\.gz|tgz|tar)$/i.test(input.name)) {
    const tar = extract();
    tar.on("entry", (header, stream, next) => {
      void (async () => {
        if ((header.name === "." || header.name === "./") && header.type === "directory") {
          if (++entries > MAX_FILES) throw new Error("Archive exceeds 5000 entries");
          await read(stream, 0);
          return next();
        }
        const path = checkEntry(header.name);
        if (header.type !== "file" && header.type !== "directory") {
          throw new Error("Links and special files are not supported");
        }
        const bytes = await read(stream, header.size ?? 0);
        if (header.type === "file") add(path, bytes, ((header.mode ?? 0) & 0o111) !== 0);
        next();
      })().catch((error: Error) => {
        tar.destroy(error);
      });
    });
    let expanded = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        expanded += chunk.length;
        done(
          expanded > MAX_BYTES + MAX_FILES * 2048 ? new Error("Expanded archive exceeds 32 MiB plus headers") : null,
          chunk,
        );
      },
    });
    if (/\.(tar\.gz|tgz)$/i.test(input.name)) await pipeline(Readable.from([data]), createGunzip(), bounded, tar);
    else await pipeline(Readable.from([data]), bounded, tar);
  } else if (/\.md$/i.test(input.name)) {
    add("SKILL.md", data);
  } else {
    throw new Error("Choose a .zip, .tar.gz, .tgz, .tar or .md file");
  }
  while (files.length && !files.some((f) => !f.path.includes("/"))) {
    const prefix = files[0]!.path.split("/")[0] + "/";
    if (!files.every((f) => f.path.startsWith(prefix))) break;
    for (const file of files) file.path = file.path.slice(prefix.length);
  }
  if (!files.some((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"))) {
    throw new Error("No SKILL.md found in this upload");
  }
  return { commit: createHash("sha256").update(data).digest("hex"), files };
}
