const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 100;
const MAX_CELL_LENGTH = 32_768;

export const ORGANIZATION_MEMBER_CSV_FIELDS = [
  "principalId",
  "employeeNumber",
  "displayName",
  "email",
  "jobTitle",
  "mobile",
  "status",
  "primaryUnitId",
  "primaryUnitPath",
  "additionalUnitIds",
  "accessGroupIds",
  "lastLoginAt",
] as const;

export type OrganizationMemberCsvField = (typeof ORGANIZATION_MEMBER_CSV_FIELDS)[number];

export interface ParsedMemberCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
  normalizedText: string;
}

function csvError(message: string): Error {
  return new Error(`organization member CSV: ${message}`);
}

function decodeCsv(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw csvError("file exceeds 5 MiB");
    return input;
  }
  if (input.byteLength > MAX_BYTES) throw csvError("file exceeds 5 MiB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw csvError("file is not valid UTF-8");
  }
}

export function parseOrganizationMemberCsv(input: string | Uint8Array): ParsedMemberCsv {
  const decoded = decodeCsv(input).replace(/^\uFEFF/, "");
  if (decoded.includes("\0")) throw csvError("NUL bytes are not allowed");
  const normalizedText = decoded.replace(/\r\n?/g, "\n");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  const pushCell = (): void => {
    if (cell.length > MAX_CELL_LENGTH) throw csvError("cell exceeds the length limit");
    record.push(cell);
    cell = "";
    afterQuote = false;
    if (record.length > MAX_COLUMNS) throw csvError("record exceeds 100 columns");
  };
  const pushRecord = (): void => {
    pushCell();
    records.push(record);
    record = [];
    if (records.length > MAX_ROWS + 1) throw csvError("file exceeds 5,000 data rows");
  };
  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index]!;
    if (quoted) {
      if (char === '"') {
        if (normalizedText[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (afterQuote && char !== "," && char !== "\n") throw csvError("unexpected content after closing quote");
    if (char === '"') {
      if (cell.length > 0) throw csvError("quote must begin a cell");
      quoted = true;
    } else if (char === ",") {
      pushCell();
    } else if (char === "\n") {
      pushRecord();
    } else {
      cell += char;
    }
  }
  if (quoted) throw csvError("unterminated quoted cell");
  if (cell.length > 0 || record.length > 0 || normalizedText.endsWith(",")) pushRecord();
  while (records.at(-1)?.every((value) => value === "")) records.pop();
  if (records.length === 0) throw csvError("file is empty");
  const headers = records[0]!.map((header) => header.trim());
  if (headers.some((header) => !header)) throw csvError("header names must not be empty");
  if (new Set(headers).size !== headers.length) throw csvError("duplicate headers are not allowed");
  const allowed = new Set<string>(ORGANIZATION_MEMBER_CSV_FIELDS);
  const unknown = headers.find((header) => !allowed.has(header));
  if (unknown) throw csvError("unknown header");
  if (!headers.some((header) => header === "principalId" || header === "employeeNumber" || header === "email")) {
    throw csvError("principalId, employeeNumber, or email header is required");
  }
  const rows = records.slice(1).map((values) => {
    if (values.length !== headers.length) throw csvError("record column count does not match the header");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  return { headers, rows, normalizedText };
}

function safeSpreadsheetCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function encodeCell(value: unknown): string {
  const safe = safeSpreadsheetCell(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function createOrganizationMemberCsvHeader(): string {
  return `\uFEFF${ORGANIZATION_MEMBER_CSV_FIELDS.join(",")}\r\n`;
}

export function createOrganizationMemberCsvRow(row: Record<OrganizationMemberCsvField, unknown>): string {
  return `${ORGANIZATION_MEMBER_CSV_FIELDS.map((field) => encodeCell(row[field])).join(",")}\r\n`;
}

export function createOrganizationMemberCsv(rows: ReadonlyArray<Record<OrganizationMemberCsvField, unknown>>): string {
  return createOrganizationMemberCsvHeader() + rows.map(createOrganizationMemberCsvRow).join("");
}
