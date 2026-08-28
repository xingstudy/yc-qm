import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrganizationMemberCsv,
  ORGANIZATION_MEMBER_CSV_FIELDS,
  parseOrganizationMemberCsv,
} from "../src/organization/member-csv.ts";

test("organization member CSV parses BOM, quoted commas, escaped quotes, and embedded newlines", () => {
  const parsed = parseOrganizationMemberCsv(
    '\uFEFFprincipalId,displayName,email\r\nU1,"张, 三",zhang@example.com\r\nU2,"Alice ""A""\nLee",alice@example.com\r\n',
  );
  assert.deepEqual(parsed.headers, ["principalId", "displayName", "email"]);
  assert.deepEqual(parsed.rows, [
    { principalId: "U1", displayName: "张, 三", email: "zhang@example.com" },
    { principalId: "U2", displayName: 'Alice "A"\nLee', email: "alice@example.com" },
  ]);
});

test("organization member CSV rejects malformed and oversized inputs without echoing cells", () => {
  assert.throws(() => parseOrganizationMemberCsv("principalId,principalId\nU1,U1"), /duplicate headers/);
  assert.throws(() => parseOrganizationMemberCsv("displayName\nAlice"), /header is required/);
  assert.throws(() => parseOrganizationMemberCsv('principalId,displayName\nU1,"secret'), /unterminated/);
  assert.throws(() => parseOrganizationMemberCsv(`principalId,displayName\nU1,${"x".repeat(32_769)}`), /length limit/);
});

test("organization member CSV export is RFC 4180, BOM-prefixed, and formula-safe", () => {
  const row = Object.fromEntries(ORGANIZATION_MEMBER_CSV_FIELDS.map((field) => [field, ""])) as Record<
    (typeof ORGANIZATION_MEMBER_CSV_FIELDS)[number],
    unknown
  >;
  row.principalId = "U1";
  row.displayName = '=HYPERLINK("https://example.test")';
  row.jobTitle = "Engineer, Platform";
  const csv = createOrganizationMemberCsv([row]);
  assert.ok(csv.startsWith("\uFEFFprincipalId,"));
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /"Engineer, Platform"/);
  assert.ok(csv.endsWith("\r\n"));
});
