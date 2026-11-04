#!/usr/bin/env node
/** Offline SQL generator: it never handles passwords or service-role keys. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) {
  console.error('Usage: node supabase/provision-allowlist.mjs students.json allowlist.sql');
  process.exit(1);
}
try {
  if (path.resolve(input) === path.resolve(output)) throw Error('Input and output paths must differ.');
  const bytes = await readFile(input);
  if (bytes.length > 1_000_000) throw Error('Roster exceeds 1 MB.');
  const accounts = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 5000) throw Error('Expected 1–5000 accounts.');
  const seen = new Set();
  const literal = text => "'" + text.replaceAll("'", "''") + "'";
  const rows = accounts.map((account, i) => {
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
      Object.keys(account).some(key => !['email', 'display_name'].includes(key))) {
      throw Error(`Row ${i + 1}: only email and display_name fields are accepted.`);
    }
    const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
    const name = typeof account.display_name === 'string' ? account.display_name.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !name || [...name].length > 80 || /[\u0000-\u001f\u007f]/.test(email + name)) {
      throw Error(`Row ${i + 1}: invalid email or display_name.`);
    }
    if (seen.has(email)) throw Error(`Row ${i + 1}: duplicate normalized email.`);
    seen.add(email);
    return `  (${literal(email)}, ${literal(name)}, false, true)`;
  });
  const sql = `-- Generated allowlist only; does not create Auth users or assign passwords.\n` +
    `-- Review before executing as the Supabase project owner.\nbegin;\nset local standard_conforming_strings = on;\n` +
    `insert into public.allowed_accounts (email, display_name, is_admin, enabled) values\n` +
    rows.join(',\n') + `\non conflict (email) do update set display_name = excluded.display_name, enabled = true, updated_at = now();\ncommit;\n`;
  await writeFile(output, sql, { mode: 0o600, flag: 'wx' });
  console.log(`Prepared ${accounts.length} allowed accounts in ${output}. No Auth account was created.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
