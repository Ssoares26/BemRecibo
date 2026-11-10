// Garante que o esquema executado pelo Worker (src/schema.ts) e a migração
// versionada (migrations/0001_init.sql) continuem idênticos — o Worker cria as
// tabelas sozinho no primeiro acesso, então os dois caminhos precisam coincidir.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const build = path.join(__dirname, "..", ".test-build");
const { SCHEMA_STATEMENTS } = require(path.join(build, "schema.js"));

const normalize = (sql) => sql.replace(/\s+/g, " ").trim();

const migrationStatements = () => {
  const file = path.join(__dirname, "..", "migrations", "0001_init.sql");
  const withoutComments = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map(normalize)
    .filter(Boolean);
};

test("schema.ts tem as mesmas instrucoes da migracao", () => {
  assert.deepEqual(SCHEMA_STATEMENTS.map(normalize), migrationStatements());
});

test("todas as instrucoes sao idempotentes", () => {
  for (const sql of SCHEMA_STATEMENTS) {
    const ok =
      /^CREATE TABLE IF NOT EXISTS /i.test(sql) ||
      /^CREATE INDEX IF NOT EXISTS /i.test(sql) ||
      /^INSERT OR IGNORE INTO /i.test(sql);
    assert.ok(ok, `instrução não idempotente: ${sql.slice(0, 60)}`);
  }
});

test("o esquema cria as quatro tabelas e a instituicao", () => {
  const tables = SCHEMA_STATEMENTS
    .filter((sql) => /^CREATE TABLE/i.test(sql))
    .map((sql) => /CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql)[1]);
  assert.deepEqual(tables, ["institution", "donors", "donations", "documents"]);
  assert.ok(SCHEMA_STATEMENTS.some((sql) => /INSERT OR IGNORE INTO institution/.test(sql)));
});
