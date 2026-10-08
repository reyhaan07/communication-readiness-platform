/**
 * College enrollment import: builds a college's training programs, units, staff and
 * students — with mentor assignments — from a seed workbook in the format of
 * COLLEGE_ENROLLMENT_QA_DB_SEED.xlsx (sheets Institution_Config, Training_Units,
 * Staff_Seed, Student_Assignments). Nothing about PEP/HOPE is hardcoded: programs and
 * units come from the workbook.
 *
 *   npm run import:college -- <workbook.xlsx> [--dry-run] [--institution-id <uuid>]
 *                                            [--credentials <file.md>]
 *
 * - Idempotent: accounts are matched by email and students by register number; existing
 *   ones are kept exactly as they are (passwords are never reset).
 * - New accounts get a strong random password; only its bcrypt hash is stored. The
 *   passwords are written once to a local Markdown file under private/ (git-ignored).
 * - Runs in one transaction: a failure leaves the database unchanged. --dry-run rolls
 *   back at the end and only reports what would happen.
 * - The college: --institution-id, else the college the workbook's staff already belong
 *   to, else the one with the workbook's institution_code, else a new one.
 */
import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { readXlsx, SheetRows } from '../shared/xlsx/readXlsx';
import { Client } from 'pg';
import { pgConnectionConfig } from '../config/pgConnection';

type Row = Record<string, string>;

const ROLE_MAP: Record<string, string> = {
  COLLEGE_COORDINATOR: 'COLLEGE_ADMIN', // enrolls and manages the college
  SUPER_ADMIN: 'SUPER_ADMIN',
  PROGRAM_ADMIN: 'PROGRAM_ADMIN',
  FACULTY_MENTOR: 'FACULTY_MENTOR',
  PLACEMENT_COORDINATOR: 'PLACEMENT_COORDINATOR',
};
const STARTING_CREDITS = 50; // 5 coins

function args() {
  const a = process.argv.slice(2);
  const flag = (name: string) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const file = a.find((x) => !x.startsWith('--') && !['--institution-id', '--credentials'].includes(a[a.indexOf(x) - 1] ?? ''));
  if (!file) throw new Error('Usage: npm run import:college -- <workbook.xlsx> [--dry-run] [--institution-id <uuid>]');
  return { file, dryRun: a.includes('--dry-run'), institutionId: flag('--institution-id'), credentials: flag('--credentials') };
}

function sheetRows(sheets: Map<string, SheetRows>, name: string): Row[] {
  const rows = sheets.get(name);
  if (!rows) throw new Error(`The workbook has no "${name}" sheet`);
  const header = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1)
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]).filter(([h]) => h)) as Row)
    .filter((r) => Object.values(r).some(Boolean));
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// Strong random password: 16 characters with every character class
function newPassword(): string {
  const base = crypto.randomBytes(12).toString('base64url');
  return `${base}A9!x`.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

async function main() {
  const opts = args();
  const sheets = await readXlsx(fs.readFileSync(path.resolve(opts.file)));
  const config = Object.fromEntries(sheetRows(sheets, 'Institution_Config').map((r) => [r.config_key, r.value]));
  const units = sheetRows(sheets, 'Training_Units');
  const staff = sheetRows(sheets, 'Staff_Seed');
  const students = sheetRows(sheets, 'Student_Assignments');
  console.log(`[import] workbook: ${units.length} units, ${staff.length} staff, ${students.length} students`);

  const db = new Client(pgConnectionConfig(process.env.DATABASE_URL ?? ''));
  await db.connect();
  const credentials: { role: string; name: string; email: string; password: string; scope: string }[] = [];
  const counts = { programs: 0, units: 0, staffNew: 0, staffKept: 0, studentsNew: 0, studentsKept: 0, mentorLinks: 0 };
  try {
    await db.query('BEGIN');

    // ── College ─────────────────────────────────────────────────────────────
    let institutionId = opts.institutionId ?? null;
    if (!institutionId) {
      const emails = staff.map((s) => s.email.toLowerCase()).filter(Boolean);
      const { rows } = await db.query<{ institution_id: string; n: string }>(
        `SELECT institution_id, count(*) n FROM identity.users
         WHERE email = ANY($1) AND institution_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [emails]);
      institutionId = rows[0]?.institution_id ?? null;
    }
    if (!institutionId && config.institution_code) {
      const { rows } = await db.query('SELECT id FROM org.institutions WHERE code = $1', [config.institution_code]);
      institutionId = rows[0]?.id ?? null;
    }
    if (!institutionId) {
      const { rows } = await db.query(
        `INSERT INTO org.institutions (name, code, type, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
        [config.institution_name || 'Imported College', config.institution_code || `IMP-${Date.now()}`, config.institution_type || 'COLLEGE']);
      institutionId = rows[0].id;
      console.log(`[import] created college ${config.institution_name}`);
    }
    const { rows: instRows } = await db.query('SELECT name FROM org.institutions WHERE id = $1', [institutionId]);
    console.log(`[import] college: ${instRows[0]?.name} (${institutionId})`);

    // ── Programs, a cohort batch per program, and the training units ─────────
    const programIds = new Map<string, string>();
    const batchIds = new Map<string, string>();
    const unitIds = new Map<string, string>(); // `${program}|${unitKey}` → subdivision id
    for (const code of [...new Set(units.map((u) => u.program_code))]) {
      const name = units.find((u) => u.program_code === code)?.program_name || code;
      const { rows } = await db.query(
        `INSERT INTO org.programs (institution_id, name, code, is_active) VALUES ($1, $2, $3, true)
         ON CONFLICT (institution_id, code) DO UPDATE SET is_active = true RETURNING id, (xmax = 0) AS created`,
        [institutionId, name, code]);
      programIds.set(code, rows[0].id);
      if (rows[0].created) counts.programs++;
      const { rows: b } = await db.query('SELECT id FROM org.batches WHERE program_id = $1 ORDER BY created_at LIMIT 1', [rows[0].id]);
      if (b.length) batchIds.set(code, b[0].id);
      else {
        const { rows: nb } = await db.query(
          `INSERT INTO org.batches (program_id, name, year, track, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [rows[0].id, `${code} Cohort ${new Date().getFullYear()}`, new Date().getFullYear(), code]);
        batchIds.set(code, nb[0].id);
      }
    }
    for (const u of units) {
      const programId = programIds.get(u.program_code)!;
      const { rows } = await db.query(
        `INSERT INTO org.subdivisions (program_id, batch_id, name, code, type, is_active) VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (program_id, code) DO UPDATE SET name = EXCLUDED.name, is_active = true RETURNING id, (xmax = 0) AS created`,
        [programId, batchIds.get(u.program_code), u.scope_unit_key, slug(u.scope_unit_key), u.scope_unit_type || 'UNIT']);
      unitIds.set(`${u.program_code}|${u.scope_unit_key}`, rows[0].id);
      if (rows[0].created) counts.units++;
    }

    // ── Staff ───────────────────────────────────────────────────────────────
    const staffUsers = new Map<string, { id: string; name: string; email: string }>(); // staff_key → user
    for (const s of staff) {
      const email = s.email.toLowerCase();
      const role = ROLE_MAP[s.role_requested] ?? s.role_requested;
      const { rows: found } = await db.query('SELECT id, name, email FROM identity.users WHERE email = $1', [email]);
      let user = found[0];
      if (user) {
        counts.staffKept++;
        await db.query('UPDATE identity.users SET institution_id = COALESCE(institution_id, $2) WHERE id = $1', [user.id, institutionId]);
      } else {
        const password = newPassword();
        const { rows } = await db.query(
          `INSERT INTO identity.users (name, email, password_hash, role, status, is_active, institution_id)
           VALUES ($1, $2, $3, $4, 'ACTIVE', true, $5) RETURNING id, name, email`,
          [s.name, email, await bcrypt.hash(password, 10), role, institutionId]);
        user = rows[0];
        counts.staffNew++;
        credentials.push({ role, name: s.name, email, password, scope: `${s.program_code} ${s.scope_type} ${s.scope_key}` });
      }
      staffUsers.set(s.staff_key, user);
      if (role === 'FACULTY_MENTOR') {
        await db.query(
          `INSERT INTO org.faculty_profiles (user_id, department, designation)
           SELECT $1, $2, 'Faculty Mentor' WHERE NOT EXISTS (SELECT 1 FROM org.faculty_profiles WHERE user_id = $1)`,
          [user.id, s.scope_key]);
      }
      if (role === 'PROGRAM_ADMIN' && programIds.has(s.program_code)) {
        await db.query('UPDATE org.programs SET assigned_admin_name = $2, assigned_admin_email = $3 WHERE id = $1',
          [programIds.get(s.program_code), user.name, user.email]);
      }
    }
    const assigner = staffUsers.get(config.coordinator_staff_key) ?? staffUsers.get(config.super_admin_staff_key)
      ?? [...staffUsers.values()][0];

    // ── Students (in chunks; one round trip per table per chunk) ─────────────
    const { rows: existingRolls } = await db.query<{ roll_number: string; id: string }>(
      'SELECT roll_number, id FROM org.students WHERE roll_number = ANY($1)', [students.map((s) => s.register_no)]);
    const studentIds = new Map(existingRolls.map((r) => [r.roll_number, r.id]));
    counts.studentsKept = studentIds.size;
    const toCreate = students.filter((s) => s.register_no && !studentIds.has(s.register_no));
    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      const passwords = chunk.map(() => newPassword());
      const hashes = await Promise.all(passwords.map((p) => bcrypt.hash(p, 10)));
      const emails = chunk.map((s) => `qa.${slug(s.program_code)}.${slug(s.register_no)}@test.local`);
      const { rows: users } = await db.query<{ id: string; email: string }>(
        `INSERT INTO identity.users (name, email, password_hash, role, status, is_active, institution_id)
         SELECT name, email, hash, 'STUDENT', 'ACTIVE', true, $4 FROM unnest($1::text[], $2::text[], $3::text[]) AS t(name, email, hash)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email`,
        [chunk.map((s) => s.student_name), emails, hashes, institutionId]);
      const userByEmail = new Map(users.map((u) => [u.email, u.id]));
      const unitKey = (s: Row) => s.scope_key || s.assignment_unit;
      const mentorOf = (s: Row) => staffUsers.get(s.mentor_staff_key);
      const { rows: created } = await db.query<{ id: string; roll_number: string }>(
        `INSERT INTO org.students (user_id, roll_number, program_id, batch_id, subdivision_id, department, track,
                                   program_name, sub_program_name, class_name, mentor_name, mentor_email, batch_year, coins)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[],
                              $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::int[], $14::int[])
         ON CONFLICT DO NOTHING RETURNING id, roll_number`,
        [chunk.map((_, k) => userByEmail.get(emails[k])), chunk.map((s) => s.register_no),
         chunk.map((s) => programIds.get(s.program_code) ?? null), chunk.map((s) => batchIds.get(s.program_code) ?? null),
         chunk.map((s) => unitIds.get(`${s.program_code}|${unitKey(s)}`) ?? null), chunk.map((s) => s.department || null),
         chunk.map((s) => unitKey(s) || null), chunk.map((s) => s.program_code), chunk.map((s) => unitKey(s) || null),
         chunk.map((s) => s.college_group || null), chunk.map((s) => mentorOf(s)?.name ?? null),
         chunk.map((s) => mentorOf(s)?.email ?? null), chunk.map(() => new Date().getFullYear()), chunk.map(() => 5)]);
      for (const c of created) studentIds.set(c.roll_number, c.id);
      await db.query(
        `INSERT INTO credit.credit_accounts (student_id, balance) SELECT unnest($1::uuid[]), $2 ON CONFLICT (student_id) DO NOTHING`,
        [created.map((c) => c.id), STARTING_CREDITS]);
      await db.query(
        `INSERT INTO performance.performance_profiles (student_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
        [created.map((c) => c.id)]);
      counts.studentsNew += created.length;
      const createdRolls = new Set(created.map((c) => c.roll_number));
      chunk.forEach((s, k) => {
        if (createdRolls.has(s.register_no)) {
          credentials.push({ role: 'STUDENT', name: s.student_name, email: emails[k], password: passwords[k],
            scope: `${s.program_code} / ${unitKey(s)} / ${s.register_no}` });
        }
      });
      process.stdout.write(`\r[import] students ${Math.min(i + 100, toCreate.length)}/${toCreate.length}`);
    }
    if (toCreate.length) process.stdout.write('\n');

    // ── Mentor assignments (students without an active mentor) ───────────────
    const links = students
      .map((s) => ({ studentId: studentIds.get(s.register_no), mentor: staffUsers.get(s.mentor_staff_key) }))
      .filter((l): l is { studentId: string; mentor: { id: string; name: string; email: string } } => !!l.studentId && !!l.mentor);
    if (links.length && assigner) {
      const { rowCount } = await db.query(
        `INSERT INTO org.student_mentor_assignments (student_id, mentor_id, mentor_user_id, assigned_by, is_active, assigned_at)
         SELECT t.sid, t.mid, t.mid, $3, true, now() FROM unnest($1::uuid[], $2::uuid[]) AS t(sid, mid)
         WHERE NOT EXISTS (SELECT 1 FROM org.student_mentor_assignments a WHERE a.student_id = t.sid AND a.is_active)`,
        [links.map((l) => l.studentId), links.map((l) => l.mentor.id), assigner.id]);
      counts.mentorLinks = rowCount ?? 0;
    }

    console.log('[import] result:', JSON.stringify(counts));
    if (opts.dryRun) {
      await db.query('ROLLBACK');
      console.log('[import] dry run — nothing was saved');
      return;
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }

  // Credentials of the accounts created now — local and git-ignored, never committed
  if (credentials.length) {
    const out = opts.credentials ?? path.resolve(__dirname, '../../../private',
      `QA_CREDENTIALS_${(config.institution_code || 'college').replace(/[^A-Za-z0-9_-]/g, '')}_${Date.now()}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const lines = [
      `# QA credentials — ${config.institution_name ?? 'college'} (created ${new Date().toISOString()})`,
      '', 'Accounts created by this import. Existing accounts kept their passwords and are not listed.', '',
      '| Role | Name | Email | Password | Scope |', '|---|---|---|---|---|',
      ...credentials.map((c) => `| ${c.role} | ${c.name} | ${c.email} | \`${c.password}\` | ${c.scope} |`),
    ];
    fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
    console.log(`[import] ${credentials.length} new account(s); credentials written to ${out}`);
  }
}

main().catch((err) => {
  console.error('[import] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
