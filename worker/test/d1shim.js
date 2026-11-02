// Minimal D1-compatible shim over node:sqlite for local tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeDB(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));
  const stmt = sql => ({
    _args: [],
    bind(...args) { this._args = args; return this; },
    first() { return db.prepare(sql).get(...this._args) ?? null; },
    all() { return { results: db.prepare(sql).all(...this._args) }; },
    run() { const r = db.prepare(sql).run(...this._args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: stmt,
    async batch(stmts) { return stmts.map(s => s.run()); },
    raw: db,
  };
}
