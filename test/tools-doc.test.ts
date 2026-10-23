import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** نام آرگومان اول registerTool. liara_create_network ابزار MCP نیست و اینجا نمی‌آید. */
function toolsInCode(): string[] {
  const names = new Set<string>();
  const re = /registerTool\(\s*["']([a-z0-9_]+)["']/g;
  for (const file of walkTs(path.join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(re)) names.add(match[1]!);
  }
  return [...names].sort();
}

function faDigits(value: number): string {
  return String(value).replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)] ?? digit);
}

function toolsInDoc(markdown: string): { table: string[]; headings: string[] } {
  const tableStart = markdown.indexOf("## جدول خلاصه");
  assert.ok(tableStart >= 0, "بخش جدول خلاصه در TOOLS.md نیست");
  const next = markdown.indexOf("\n## ", tableStart + "## جدول خلاصه".length);
  assert.ok(next > tableStart, "جدول خلاصه بسته نشده است");
  const table = markdown.slice(tableStart, next);
  const tableNames = [...table.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]!);
  const headings = [...markdown.matchAll(/^## `([a-z0-9_]+)`/gm)].map((match) => match[1]!);
  return { table: tableNames, headings };
}

function namesDiff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const have = new Set(actual);
  const want = new Set(expected);
  return {
    missing: expected.filter((name) => !have.has(name)),
    extra: actual.filter((name) => !want.has(name)),
  };
}

test("TOOLS.md همان نام‌های registerTool را در جدول و عنوان دارد", () => {
  const code = toolsInCode();
  const markdown = readFileSync(path.join(root, "docs", "TOOLS.md"), "utf8");
  const doc = toolsInDoc(markdown);

  assert.deepEqual(namesDiff(code, doc.table), { missing: [], extra: [] });
  assert.deepEqual(namesDiff(code, doc.headings), { missing: [], extra: [] });
  assert.equal(new Set(doc.table).size, doc.table.length, "ردیف تکراری در جدول");
  assert.equal(new Set(doc.headings).size, doc.headings.length, "عنوان تکراری");
  assert.ok(markdown.includes(`این سند **${faDigits(code.length)}** ابزار`));
});
