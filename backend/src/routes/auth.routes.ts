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

// ── POST /api/auth/register-institution ───────────────────────────────────────
// A college signs up: creates the institution and its Super Admin account.

const institutionSignupSchema = z.object({
  institutionName: z.string().trim().min(2, 'Enter the institution name').max(255),
  institutionCode: z.string().trim().min(2, 'Enter a short code for the institution').max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'The short code may only use letters, digits, - and _')
    .transform(s => s.toUpperCase()),
  campusCity: z.string().trim().min(2, 'Enter the campus city').max(100),
  adminName: z.string().trim().min(2, 'Enter the administrator name').max(255),
  adminEmail: z.string().trim().email('Enter a valid administrator email').transform(s => s.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  contactPhone: z.string().trim().max(30).optional(),
});

authRouter.post('/register-institution', async (req: Request, res: Response): Promise<void> => {
  const parsed = institutionSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, new AppError(422, firstIssue(parsed.error), 'VALIDATION_ERROR'));
    return;
  }
  const { institutionName, institutionCode, campusCity, adminName, adminEmail, password } = parsed.data;

  const client = await db.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query('BEGIN');
    try {
      const { rows: clash } = await client.query(
        'SELECT 1 FROM org.institutions WHERE code = $1 OR lower(name) = lower($2)',
        [institutionCode, institutionName]
      );
      if (clash.length > 0) {
        throw new AppError(409, `An institution named "${institutionName}" or with code ${institutionCode} is already registered.`, 'DUPLICATE_INSTITUTION');
      }
      const { rows: inst } = await client.query<{ id: string; name: string; code: string; campus_city: string; created_at: Date }>(
        `INSERT INTO org.institutions (name, code, campus_city) VALUES ($1, $2, $3)
         RETURNING id, name, code, campus_city, created_at`,
        [institutionName, institutionCode, campusCity]
      );
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO identity.users (name, email, password_hash, role, token_version, status, institution_id)
         VALUES ($1, $2, $3, 'SUPER_ADMIN', 0, 'ACTIVE', $4) RETURNING id`,
        [adminName, adminEmail, passwordHash, inst[0].id]
      );
      await client.query('COMMIT');

      const authUser: AuthUser = { id: userRows[0].id, email: adminEmail, role: 'SUPER_ADMIN', name: adminName, tokenVersion: 0 };
      sendSuccess(res, {
        token: signToken(authUser),
        user: { id: authUser.id, name: adminName, email: adminEmail, role: 'SUPER_ADMIN' },
        institution: {
          id: inst[0].id, name: inst[0].name, code: inst[0].code,
          campusCity: inst[0].campus_city, createdAt: inst[0].created_at,
        },
      }, 201);
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    if (err instanceof AppError) { sendError(res, err); return; }
    if ((err as { code?: string }).code === '23505') {
      sendError(res, new AppError(409, 'An account with this email already exists. Please sign in instead.', 'DUPLICATE_EMAIL'));
      return;
    }
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

    const { rows } = await db.query<{
      id: string; name: string; email: string; role: UserRole;
      password_hash: string; token_version: number; status: string; is_active: boolean;
    }>(
      `SELECT id, name, email, role, password_hash, token_version, status, is_active
       FROM identity.users WHERE email = $1`,
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

    const user = rows[0];
    const blocked = accountBlock(user.status, user.is_active);
    if (blocked) throw blocked;

    let studentId: string | null = null;
    if (user.role === 'STUDENT') {
      const { rows: sRows } = await db.query<{ id: string }>(
        'SELECT id FROM org.students WHERE user_id = $1', [user.id]
      );
      studentId = sRows[0]?.id ?? null;
    }

    const authUser: AuthUser = {
      id: user.id, email: user.email, role: user.role,
      name: user.name, tokenVersion: user.token_version,
    };
    const token = signToken(authUser);

    sendSuccess(res, {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      studentId,
    });
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
