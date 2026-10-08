import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../config/env';
import { db } from '../shared/db/pool';
import { authenticate, AuthRequest, accountBlock } from '../middleware/authenticate';
import { AppError } from '../shared/errors/AppError';
import { sendSuccess, sendError } from '../shared/helpers/response';
import { eventBus } from '../shared/events/eventBus';
import { Events, UserRegisteredPayload } from '../shared/events/events';
import { UserRole } from '../shared/types/roles';
import { AuthUser } from '../shared/types/auth';
import { lockedForSeconds, recordFailure, clearFailures } from '../shared/security/loginThrottle';
import { emailConfigured, sendPasswordResetCode } from '../services/emailService';
import crypto from 'crypto';

export const authRouter = Router();

// A real bcrypt hash (cost 10) of a throwaway value, compared when the email does
// not exist so both paths cost the same. A malformed hash makes compare() return
// immediately, which would reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      tokenVersion: user.tokenVersion,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
}

// ── POST /api/auth/register ────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(255),
  email: z.string().trim().email('Enter a valid email address').transform(s => s.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Omitted when a student signs up on their own, without a college batch
  batchId: z.string().uuid().optional(),
  subdivisionId: z.string().uuid().optional(),
  rollNumber: z.string().trim().min(1).max(50).optional(),
});

const firstIssue = (error: z.ZodError) => error.issues[0]?.message || 'Validation failed';

interface BatchPlacement { id: string; program_id: string; institution_id: string }

/**
 * Students who sign up on their own join one shared cohort (institution INDEPENDENT,
 * program SELF, one batch per year), created on first use. Runs inside the caller's
 * transaction; the advisory lock stops two sign-ups from creating it twice.
 */
async function independentBatch(client: PoolClient): Promise<BatchPlacement> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('independent-cohort'))`);
  const year = new Date().getFullYear();

  let { rows: inst } = await client.query<{ id: string }>(
    `SELECT id FROM org.institutions WHERE code = 'INDEPENDENT'`
  );
  if (inst.length === 0) {
    ({ rows: inst } = await client.query<{ id: string }>(
      `INSERT INTO org.institutions (name, code) VALUES ('Independent Candidates', 'INDEPENDENT') RETURNING id`
    ));
  }
  let { rows: prog } = await client.query<{ id: string }>(
    `SELECT id FROM org.programs WHERE institution_id = $1 AND code = 'SELF'`, [inst[0].id]
  );
  if (prog.length === 0) {
    ({ rows: prog } = await client.query<{ id: string }>(
      `INSERT INTO org.programs (institution_id, name, code) VALUES ($1, 'Self-Practice', 'SELF') RETURNING id`,
      [inst[0].id]
    ));
  }
  let { rows: batch } = await client.query<{ id: string }>(
    `SELECT id FROM org.batches WHERE program_id = $1 AND year = $2 ORDER BY created_at LIMIT 1`,
    [prog[0].id, year]
  );
  if (batch.length === 0) {
    ({ rows: batch } = await client.query<{ id: string }>(
      `INSERT INTO org.batches (program_id, name, year) VALUES ($1, $2, $3) RETURNING id`,
      [prog[0].id, `Independent ${year}`, year]
    ));
  }
  return { id: batch[0].id, program_id: prog[0].id, institution_id: inst[0].id };
}

authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, new AppError(422, firstIssue(parsed.error), 'VALIDATION_ERROR'));
    return;
  }
  const { name, email, password, batchId, subdivisionId, rollNumber } = parsed.data;

  const client = await db.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 10);

    await client.query('BEGIN');
    try {
      let placement: BatchPlacement;
      if (batchId) {
        const { rows: batchRows } = await client.query<BatchPlacement>(
          `SELECT b.id, b.program_id, p.institution_id
           FROM org.batches b JOIN org.programs p ON p.id = b.program_id
           WHERE b.id = $1 AND b.is_active = true`,
          [batchId]
        );
        if (batchRows.length === 0) {
          throw new AppError(404, 'Batch not found', 'NOT_FOUND');
        }
        placement = batchRows[0];
      } else {
        placement = await independentBatch(client);
      }

      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO identity.users (name, email, password_hash, role, token_version, status, institution_id)
         VALUES ($1, $2, $3, 'STUDENT', 0, 'ACTIVE', $4) RETURNING id`,
        [name, email, passwordHash, placement.institution_id]
      );
      const userId = userRows[0].id;

      // program_id is required and always the batch's program
      const { rows: studentRows } = await client.query<{ id: string }>(
        `INSERT INTO org.students (user_id, roll_number, program_id, batch_id, subdivision_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, rollNumber ?? null, placement.program_id, placement.id, batchId ? subdivisionId ?? null : null]
      );
      const studentId = studentRows[0].id;

      await client.query('COMMIT');

      const authUser: AuthUser = { id: userId, email, role: 'STUDENT', name, tokenVersion: 0 };
      const token = signToken(authUser);

      const payload: UserRegisteredPayload = { userId, studentId, email, name };
      eventBus.emit(Events.USER_REGISTERED, payload);

      sendSuccess(res, { token, user: { id: userId, name, email, role: 'STUDENT' }, studentId }, 201);
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    if (err instanceof AppError) { sendError(res, err); return; }
    if ((err as { code?: string }).code === '23505') {
      const isRollNumber = (err as { constraint?: string }).constraint === 'uq_students_roll_number';
      sendError(res, isRollNumber
        ? new AppError(409, 'Roll number already registered', 'DUPLICATE_ROLL_NUMBER')
        : new AppError(409, 'An account with this email already exists. Please sign in instead.', 'DUPLICATE_EMAIL'));
      return;
    }
    sendError(res, err);
  } finally {
    client.release();
  }
});

// ── POST /api/auth/register-candidate ──────────────────────────────────────────

const registerCandidateSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(255),
  email: z.string().email('Valid email is required').transform(s => s.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  collegeId: z.string().optional(),
  department: z.string().optional().default('Computer Science & Engineering'),
  batchYear: z.number().int().optional().default(2026),
  track: z.string().optional().default('General Track'),
  programName: z.string().optional().default('General Engineering'),
  rollNumber: z.string().optional(),
});

authRouter.post('/register-candidate', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerCandidateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    sendError(res, new AppError(422, `Validation failed: ${detail}`, 'VALIDATION_ERROR'));
    return;
  }
  const { name, email, password, collegeId, department, batchYear, track, programName, rollNumber } = parsed.data;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve institution
    let instId: string;
    let instName = 'Main Institution';
    if (collegeId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collegeId)) {
      const { rows } = await client.query(`SELECT id, name FROM org.institutions WHERE id = $1`, [collegeId]);
      if (rows.length > 0) {
        instId = rows[0].id;
        instName = rows[0].name;
      } else {
        const { rows: latest } = await client.query(`SELECT id, name FROM org.institutions ORDER BY created_at DESC LIMIT 1`);
        instId = latest[0]?.id;
        instName = latest[0]?.name || instName;
      }
    } else {
      const { rows: latest } = await client.query(`SELECT id, name FROM org.institutions ORDER BY created_at DESC LIMIT 1`);
      if (latest.length > 0) {
        instId = latest[0].id;
        instName = latest[0].name;
      } else {
        const { rows: created } = await client.query(
          `INSERT INTO org.institutions (name, code, type, is_active) VALUES ('Main Institution', 'INST01', 'COLLEGE', true) RETURNING id, name`
        );
        instId = created[0].id;
        instName = created[0].name;
      }
    }

    // 2. Resolve or create program
    let progId: string;
    const { rows: progs } = await client.query(
      `SELECT id, name FROM org.programs WHERE institution_id = $1 LIMIT 1`,
      [instId]
    );
    if (progs.length > 0) {
      progId = progs[0].id;
    } else {
      const { rows: newProg } = await client.query(
        `INSERT INTO org.programs (institution_id, name, code) VALUES ($1, $2, 'GEN') RETURNING id`,
        [instId, programName || 'General Engineering']
      );
      progId = newProg[0].id;
    }

    // 3. Resolve or create batch
    let batchId: string;
    const { rows: batches } = await client.query(
      `SELECT id FROM org.batches WHERE program_id = $1 AND year = $2 LIMIT 1`,
      [progId, batchYear]
    );
    if (batches.length > 0) {
      batchId = batches[0].id;
    } else {
      const { rows: newBatch } = await client.query(
        `INSERT INTO org.batches (program_id, name, year, track) VALUES ($1, $2, $3, $4) RETURNING id`,
        [progId, `Batch ${batchYear}`, batchYear, track || 'General Track']
      );
      batchId = newBatch[0].id;
    }

    // Check if email is already in use
    const { rows: existingUsers } = await client.query(
      `SELECT id FROM identity.users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (existingUsers.length > 0) {
      throw new AppError(409, 'An account with this email address already exists. Please sign in.', 'EMAIL_ALREADY_EXISTS');
    }

    // 4. Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // 5. Insert into identity.users (strictly prevent duplicates)
    const { rows: userRows } = await client.query<{ id: string; name: string; email: string; role: UserRole; token_version: number }>(
      `INSERT INTO identity.users (name, email, password_hash, role, token_version, status, institution_id)
       VALUES ($1, $2, $3, 'STUDENT', 0, 'ACTIVE', $4)
       RETURNING id, name, email, role, token_version`,
      [name, email.toLowerCase(), passwordHash, instId]
    );
    const user = userRows[0];

    // 6. Ensure independent candidate record is persisted in candidate.independent_candidates
    await client.query(
      `INSERT INTO candidate.independent_candidates (user_id, name, email, credits, status)
       VALUES ($1, $2, $3, 5, 'ACTIVE')
       ON CONFLICT (user_id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         credits = COALESCE(candidate.independent_candidates.credits, 5)`,
      [user.id, name, email.toLowerCase()]
    ).catch(() => {});

    // 7. Ensure student record exists in org.students with 5 coins/credits
    const actualRoll = rollNumber || `22CS${Math.floor(1000 + Math.random() * 9000)}`;
    const { rows: studentRows } = await client.query<{ id: string }>(
      `INSERT INTO org.students (user_id, program_id, batch_id, roll_number, department, batch_year, track, coins, overall_readiness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 5, 75)
       ON CONFLICT (user_id) DO UPDATE SET
         coins = COALESCE(org.students.coins, 5)
       RETURNING id`,
      [user.id, progId, batchId, actualRoll, department, batchYear, track]
    );
    const studentId = studentRows[0].id;

    // 8. Ensure credit account exists in credit.credit_accounts with 5 credits
    await client.query(
      `INSERT INTO credit.credit_accounts (student_id, balance)
       VALUES ($1, 5)
       ON CONFLICT (student_id) DO UPDATE SET balance = COALESCE(credit.credit_accounts.balance, 5)`,
      [studentId]
    ).catch(() => {});

    // 9. Role assignment
    await client.query(
      `INSERT INTO identity.role_assignments (user_id, role_id, institution_id, program_id, batch_id, scope_type, is_active)
       SELECT $1, id, $2, $3, $4, 'BATCH', true FROM identity.roles WHERE name = 'STUDENT'
       ON CONFLICT DO NOTHING`,
      [user.id, instId, progId, batchId]
    ).catch(() => {});

    await client.query('COMMIT');

    // Registration is strictly for registering — candidate must now sign in through login modal
    sendSuccess(res, {
      message: 'Candidate registration successful! Please sign in with your email and password to access the portal.',
      requiresLogin: true,
      email: user.email,
      name: user.name,
      studentId
    }, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, err);
  } finally {
    client.release();
  }
});

// ── POST /api/auth/register-institution ────────────────────────────────────────

const registerInstitutionSchema = z.object({
  institutionName: z.string().min(2, 'Institution name must be at least 2 characters').max(255),
  institutionCode: z.string().min(2, 'Institution code must be at least 2 characters').max(20).transform(s => s.toUpperCase()),
  campusCity: z.string().min(2, 'City must be at least 2 characters').max(255),
  adminName: z.string().min(2, 'Admin name must be at least 2 characters').max(255),
  adminEmail: z.string().email('Valid admin email is required').transform(s => s.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  contactPhone: z.string().optional().nullable(),
});

authRouter.post('/register-institution', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerInstitutionSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    sendError(res, new AppError(422, `Validation failed: ${detail}`, 'VALIDATION_ERROR'));
    return;
  }
  const { institutionName, institutionCode, campusCity, adminName, adminEmail, password } = parsed.data;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check if administrator email is already registered
    const { rows: existingUser } = await client.query(
      `SELECT id FROM identity.users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [adminEmail]
    );
    if (existingUser.length > 0) {
      throw new AppError(409, 'An account with this administrator email already exists. Please sign in or use another email.', 'EMAIL_ALREADY_EXISTS');
    }

    // Check if institution code or name already exists
    const { rows: existingInst } = await client.query(
      `SELECT id FROM org.institutions WHERE UPPER(code) = $1 OR LOWER(name) = LOWER($2) LIMIT 1`,
      [institutionCode, institutionName]
    );
    if (existingInst.length > 0) {
      throw new AppError(409, 'An institution with this code or name already exists. Please choose a unique name and code.', 'DUPLICATE_CODE');
    }

    // 1. Create institution
    const { rows: newInst } = await client.query(
      `INSERT INTO org.institutions (name, code, type, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id, name, code, type AS campus_city, created_at`,
      [institutionName, institutionCode, campusCity]
    );
    const instRow = newInst[0];

    // 2. Hash admin password
    const passwordHash = await bcrypt.hash(password, 10);

    // 3. Insert admin user as SUPER_ADMIN linked to this institution
    const { rows: userRows } = await client.query<{ id: string; name: string; email: string; role: UserRole; token_version: number; status: string; institution_id: string }>(
      `INSERT INTO identity.users (name, email, password_hash, role, status, institution_id)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', $4)
       RETURNING id, name, email, role, token_version, status, institution_id`,
      [adminName, adminEmail.toLowerCase(), passwordHash, instRow.id]
    );
    const user = userRows[0];

    // 4. Role assignment
    await client.query(
      `INSERT INTO identity.role_assignments (user_id, role_id, institution_id, scope_type, is_active)
       SELECT $1, id, $2, 'INSTITUTION', true FROM identity.roles WHERE name = 'SUPER_ADMIN'
       ON CONFLICT DO NOTHING`,
      [user.id, instRow.id]
    ).catch(() => {});

    // 5. Accepted invite record for audit trail
    await client.query(
      `INSERT INTO identity.pending_invites (institution_id, role, name, email, token, status, expires_at)
       VALUES ($1, 'SUPER_ADMIN', $2, $3, encode(gen_random_bytes(16), 'hex'), 'ACCEPTED', now() + interval '365 days')
       ON CONFLICT DO NOTHING`,
      [instRow.id, adminName, adminEmail]
    ).catch(() => {});

    await client.query('COMMIT');

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: 'SUPER_ADMIN',
      name: user.name,
      tokenVersion: user.token_version || 0,
    };
    const token = signToken(authUser);

    sendSuccess(res, {
      college: {
        id: instRow.id,
        name: instRow.name,
        code: instRow.code,
        campusCity: instRow.campus_city || campusCity,
        createdAt: instRow.created_at,
        superAdminStatus: 'ACTIVE',
        superAdminEmail: user.email,
        superAdminName: user.name
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'SUPER_ADMIN',
        collegeId: instRow.id,
        collegeName: instRow.name
      },
      token
    }, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    sendError(res, err);
  } finally {
    client.release();
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email().transform(s => s.toLowerCase()),
  password: z.string().min(1),
});

authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, new AppError(422, 'Validation failed', 'VALIDATION_ERROR'));
    return;
  }
  const { email, password } = parsed.data;
  const ip = req.ip ?? 'unknown';

  try {
    const lockSeconds = lockedForSeconds(ip, email);
    if (lockSeconds > 0) {
      throw new AppError(429, `Too many failed attempts. Try again in ${Math.ceil(lockSeconds / 60)} minute(s).`, 'TOO_MANY_ATTEMPTS');
    }

    // One query that also returns the org context the frontend's AuthUser needs
    const { rows } = await db.query<{
      id: string; name: string; email: string; role: UserRole;
      password_hash: string; token_version: number; status: string; is_active: boolean;
      // student fields
      student_id: string | null; roll_number: string | null;
      batch_year: number | null; student_track: string | null;
      program_id: string | null; program_name: string | null;
      institution_id: string | null; institution_name: string | null;
      // faculty / staff fields
      department: string | null;
    }>(
      `SELECT
         u.id, u.name, u.email, u.role, u.password_hash, u.token_version, u.status, u.is_active,
         s.id           AS student_id,
         s.roll_number,
         b.year         AS batch_year,
         b.track        AS student_track,
         p.id           AS program_id,
         p.name         AS program_name,
         COALESCE(u.institution_id, inst.id, ra_inst.id, inv_inst.id, ds_inst.id) AS institution_id,
         COALESCE(u_inst.name, inst.name, ra_inst.name, inv_inst.name, ds_inst.name) AS institution_name,
         COALESCE(ds.department, fp.department) AS department
       FROM identity.users u
       LEFT JOIN org.institutions       u_inst ON u_inst.id    = u.institution_id
       LEFT JOIN org.students           s    ON s.user_id     = u.id
       LEFT JOIN org.batches            b    ON b.id          = s.batch_id
       LEFT JOIN org.programs           p    ON p.id          = COALESCE(s.program_id, b.program_id)
       LEFT JOIN org.institutions       inst ON inst.id       = p.institution_id
       LEFT JOIN LATERAL (
         SELECT ra.institution_id FROM identity.role_assignments ra
         WHERE ra.user_id = u.id AND ra.is_active = true AND ra.institution_id IS NOT NULL LIMIT 1
       ) ra ON true
       LEFT JOIN org.institutions       ra_inst ON ra_inst.id = ra.institution_id
       LEFT JOIN LATERAL (
         SELECT inv.institution_id FROM identity.pending_invites inv
         WHERE lower(inv.email) = lower(u.email) AND inv.institution_id IS NOT NULL LIMIT 1
       ) inv ON true
       LEFT JOIN org.institutions       inv_inst ON inv_inst.id = inv.institution_id
       LEFT JOIN LATERAL (
         SELECT d.institution_id, d.department FROM org.department_staff d WHERE d.user_id = u.id LIMIT 1
       ) ds ON true
       LEFT JOIN org.institutions       ds_inst ON ds_inst.id = ds.institution_id
       LEFT JOIN org.faculty_profiles   fp   ON fp.user_id    = u.id
       WHERE u.email = $1`,
      [email]
    );

    // Always run bcrypt regardless of whether the email exists — prevents timing-based
    // user enumeration (a found email would otherwise be ~100ms slower than a missing one).
    const hashToCheck = rows.length > 0 ? rows[0].password_hash : DUMMY_HASH;
    const passwordMatch = await bcrypt.compare(password, hashToCheck);
    if (rows.length === 0 || !passwordMatch) {
      recordFailure(ip, email);
      throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }
    clearFailures(ip, email);

    const row = rows[0];
    const blocked = accountBlock(row.status, row.is_active);
    if (blocked) throw blocked;

    const authUser: AuthUser = {
      id: row.id, email: row.email, role: row.role,
      name: row.name, tokenVersion: row.token_version,
    };
    const token = signToken(authUser);

    sendSuccess(res, {
      token,
      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        // Org context — consumed by the frontend's AppContext / localStorage
        studentId:      row.student_id   ?? undefined,
        rollNumber:     row.roll_number  ?? undefined,
        batchYear:      row.batch_year   ?? undefined,
        track:          row.student_track ?? undefined,
        programId:      row.program_id   ?? undefined,
        programName:    row.program_name ?? undefined,
        collegeId:      row.institution_id   ?? undefined,
        collegeName:    row.institution_name ?? undefined,
        department:     row.department   ?? undefined,
      },
      studentId: row.student_id,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/auth/forgot-password ─────────────────────────────────────────────
// Emails a 6-digit code. The answer is the same whether or not the email has an
// account, so the form cannot be used to find out who is registered.

const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_CODES_PER_WINDOW = 3;

const forgotSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').transform(s => s.toLowerCase()),
});

authRouter.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, firstIssue(parsed.error), 'VALIDATION_ERROR');
    const { email } = parsed.data;
    const ip = req.ip ?? 'unknown';

    if (!emailConfigured()) {
      throw new AppError(503,
        'Password reset by email is not set up on this site yet. Ask your administrator to reset your password.',
        'EMAIL_NOT_CONFIGURED');
    }
    // Per IP: at most a handful of requests per window, whatever the email
    if (lockedForSeconds(ip, 'forgot-password') > 0) {
      throw new AppError(429, 'Too many reset requests. Please wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS');
    }
    recordFailure(ip, 'forgot-password');

    const sent = {
      message: `If an account exists for ${email}, we have emailed it a 6-digit code. It expires in ${RESET_CODE_MINUTES} minutes.`,
    };
    const { rows } = await db.query<{ id: string; name: string; status: string; is_active: boolean }>(
      'SELECT id, name, status, is_active FROM identity.users WHERE email = $1', [email]
    );
    const user = rows[0];
    if (!user || accountBlock(user.status, user.is_active)) { sendSuccess(res, sent); return; }

    const { rows: recent } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM identity.password_resets
       WHERE user_id = $1 AND created_at > now() - make_interval(mins => $2)`,
      [user.id, RESET_CODE_MINUTES]
    );
    if (Number(recent[0].n) >= RESET_CODES_PER_WINDOW) { sendSuccess(res, sent); return; }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Only the newest code works
      await client.query(
        'UPDATE identity.password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]
      );
      await client.query(
        `INSERT INTO identity.password_resets (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [user.id, codeHash, RESET_CODE_MINUTES]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    try {
      await sendPasswordResetCode({ to: email, name: user.name, code, minutes: RESET_CODE_MINUTES });
    } catch (mailErr) {
      console.error('[auth] password reset email failed:', (mailErr as Error).message);
      throw new AppError(502, 'The reset email could not be sent. Please try again in a few minutes.', 'EMAIL_FAILED');
    }
    sendSuccess(res, sent);
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/auth/reset-password ──────────────────────────────────────────────
// Checks the emailed code and sets the new password. Every existing session of the
// account is signed out, since whoever had the old password should lose access.

const resetSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').transform(s => s.toLowerCase()),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

authRouter.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, firstIssue(parsed.error), 'VALIDATION_ERROR');
    const { email, code, newPassword } = parsed.data;
    const invalid = new AppError(400, 'That code is not valid or has expired. Check the email or request a new code.', 'INVALID_RESET_CODE');

    const { rows: users } = await db.query<{ id: string; status: string; is_active: boolean }>(
      'SELECT id, status, is_active FROM identity.users WHERE email = $1', [email]
    );
    const user = users[0];
    if (!user) throw invalid;
    const blocked = accountBlock(user.status, user.is_active);
    if (blocked) throw blocked;

    const { rows: codes } = await db.query<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM identity.password_resets
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const active = codes[0];
    if (!active || active.attempts >= RESET_MAX_ATTEMPTS) throw invalid;

    if (!(await bcrypt.compare(code, active.code_hash))) {
      await db.query('UPDATE identity.password_resets SET attempts = attempts + 1 WHERE id = $1', [active.id]);
      const left = RESET_MAX_ATTEMPTS - active.attempts - 1;
      throw left > 0
        ? new AppError(400, `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, 'INVALID_RESET_CODE')
        : new AppError(400, 'Too many wrong codes. Request a new code.', 'INVALID_RESET_CODE');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE identity.users
         SET password_hash = $1, token_version = token_version + 1, updated_at = now()
         WHERE id = $2`,
        [passwordHash, user.id]
      );
      await client.query(
        'UPDATE identity.password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    clearFailures(req.ip ?? 'unknown', email);
    sendSuccess(res, { message: 'Your password has been changed. Sign in with the new password.' });
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
// Ends this browser's session only: the client discards its token. Revoking every
// token of the account here would also sign out everyone else using it (another
// device, or teammates sharing a demo account).

authRouter.post('/logout', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  sendSuccess(res, { message: 'Logged out successfully' });
});

// ── POST /api/auth/logout-all ──────────────────────────────────────────────────
// Signs the account out everywhere (e.g. after a lost device): all its tokens stop working.

authRouter.post('/logout-all', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await db.query(
      'UPDATE identity.users SET token_version = token_version + 1 WHERE id = $1',
      [req.user!.id]
    );
    sendSuccess(res, { message: 'Signed out on all devices' });
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────────

authRouter.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let studentId: string | null = null;
    if (req.user!.role === 'STUDENT') {
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM org.students WHERE user_id = $1', [req.user!.id]
      );
      studentId = rows[0]?.id ?? null;
    }
    sendSuccess(res, {
      user: { id: req.user!.id, name: req.user!.name, email: req.user!.email, role: req.user!.role },
      studentId,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ── GET /api/auth/invite/:token ────────────────────────────────────────────────
// Public: shows the invitee who invited them before they set a password. Only
// pending, unexpired invites resolve; the token itself is the credential.

authRouter.get('/invite/:token', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token ?? '');
    if (!/^[0-9a-f]{64}$/i.test(token)) {
      throw new AppError(404, 'Invalid or expired invitation', 'INVALID_INVITE');
    }
    const { rows } = await db.query(
      `SELECT i.email, i.name, i.first_name, i.last_name, i.role, i.institution_id,
              inst.name AS institution_name, i.permissions, i.status, i.expires_at, i.created_at
       FROM identity.invites i
       LEFT JOIN org.institutions inst ON inst.id = i.institution_id
       WHERE i.token = $1 AND i.status = 'PENDING' AND i.expires_at > now()`,
      [token]
    );
    if (rows.length === 0) throw new AppError(404, 'Invalid or expired invitation', 'INVALID_INVITE');
    sendSuccess(res, { invite: rows[0] });
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/auth/accept-invite ───────────────────────────────────────────────
// Accept an invitation and create user account

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters')
});

authRouter.post('/accept-invite', async (req: Request, res: Response): Promise<void> => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, new AppError(422, 'Validation failed', 'VALIDATION_ERROR'));
    return;
  }

  const { token, password } = parsed.data;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Find invite by token
    const inviteResult = await client.query(
      `SELECT * FROM identity.invites
       WHERE token = $1
       AND status = 'PENDING'
       AND expires_at > now()`,
      [token]
    );

    if (inviteResult.rows.length === 0) {
      throw new AppError(404, 'Invalid or expired invitation', 'INVALID_INVITE');
    }

    const invite = inviteResult.rows[0];

    // Check if user already exists with this email
    const existingUser = await client.query(
      `SELECT id FROM identity.users WHERE email = $1`,
      [invite.email]
    );

    if (existingUser.rows.length > 0) {
      throw new AppError(409, 'User with this email already exists', 'USER_EXISTS');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user account
    const userResult = await client.query(
      `INSERT INTO identity.users (
        name,
        email,
        password_hash,
        role,
        token_version,
        status,
        institution_id,
        first_name,
        last_name
      ) VALUES ($1, $2, $3, $4, 0, 'ACTIVE', $5, $6, $7)
      RETURNING id, name, email, role, token_version`,
      [invite.name, invite.email, passwordHash, invite.role, invite.institution_id, invite.first_name, invite.last_name]
    );

    const user = userResult.rows[0];

    // Update invite status
    await client.query(
      `UPDATE identity.invites
       SET status = 'ACCEPTED',
           accepted_by_user_id = $1,
           accepted_at = now()
       WHERE id = $2`,
      [user.id, invite.id]
    );

    await client.query('COMMIT');

    // Generate JWT token
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      tokenVersion: user.token_version
    };
    const jwtToken = signToken(authUser);

    sendSuccess(res, {
      token: jwtToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      message: 'Invitation accepted successfully'
    }, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      sendError(res, err);
      return;
    }
    sendError(res, err);
  } finally {
    client.release();
  }
});
