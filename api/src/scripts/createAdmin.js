// createAdmin.js: make (or update) an admin account, from your own terminal only. Ported from NURA.
//
//   npm run create-admin -- --email you@example.com --name "Your Name"
//   npm run create-admin -- --email demo@example.com --name "Demo" --role DEMO_ADMIN
//   npm run create-admin -- --email you@example.com --reset-2fa      (lost phone)
//
// There is deliberately no web page that creates admins: whoever can run this already has the
// database password. For an ADMIN it prints a two-factor key ONCE. Add it to an authenticator
// app (Google Authenticator, Authy, Microsoft Authenticator) and don't keep a copy.
//
// For the demo account, ADMIN_PASSWORD can be given in the environment instead of typing it
// (for a script); a real admin should always type theirs.
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { admins } from '../db/schema.js';
import { newSecret, otpauthUrl } from '../lib/totp.js';

const { values } = parseArgs({ options: {
  email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'ADMIN' },
  'reset-2fa': { type: 'boolean', default: false },
} });
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) exit('Give an email: npm run create-admin -- --email you@example.com');
if (!['ADMIN', 'DEMO_ADMIN'].includes(values.role)) exit('--role must be ADMIN or DEMO_ADMIN');

/** Asks for a password without showing what you type. */
function askHidden(question) {
  if (process.env.ADMIN_PASSWORD) return Promise.resolve(process.env.ADMIN_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };  // hide the typing
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}
function exit(msg) { console.error(msg); process.exit(1); }

const [existing] = (await db.execute(sql`select id, name, role, totp_secret from admins where lower(email) = ${email}`)).rows;
console.log(existing ? `Updating ${email} (currently ${existing.role}).` : `Creating ${email}.`);

let passwordHash;
const pw = await askHidden(existing ? 'New password (Enter to keep the current one): ' : 'Password (at least 12 characters): ');
if (pw || !existing) {
  if (pw.length < 12) exit('Admin passwords need at least 12 characters.');
  if (pw !== await askHidden('Type it again: ')) exit('The two passwords don’t match. Nothing was changed.');
  passwordHash = await argon2.hash(pw, { type: argon2.argon2id });
}

// ADMIN gets a two-factor secret (new, or on --reset-2fa); DEMO_ADMIN never needs one.
const giveSecret = values.role === 'ADMIN' && (!existing?.totp_secret || values['reset-2fa']);
const totpSecret = values.role === 'ADMIN' ? (giveSecret ? newSecret() : existing.totp_secret) : null;
const name = values.name?.trim() || existing?.name || email.split('@')[0];

if (existing) {
  await db.update(admins).set({ role: values.role, name, totpSecret, ...(passwordHash ? { passwordHash } : {}), updatedAt: new Date() })
    .where(sql`id = ${existing.id}`);
  // Role, password or two-factor changed: sign this account out everywhere.
  await db.execute(sql`delete from sessions where sess->>'adminId' = ${existing.id}`);
} else {
  await db.insert(admins).values({ email, name, role: values.role, passwordHash, totpSecret });
}

console.log(`\n✔ ${email} is now ${values.role}.`);
if (giveSecret) {
  console.log('\nTwo-factor: in your authenticator app choose “Enter a setup key” and type:');
  console.log(`\n    Account: Safari Ember (${email})\n    Key:     ${totpSecret.match(/.{1,4}/g).join(' ')}\n    Type:    Time based\n`);
  console.log(`(Or, if your app accepts links: ${otpauthUrl(totpSecret, email)})`);
  console.log('\nThis key is shown ONCE. Close this window when it’s in your app.');
}
await pool.end();
