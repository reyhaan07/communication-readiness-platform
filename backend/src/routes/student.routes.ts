import { Router, Request, Response } from 'express';
import multer from 'multer';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../shared/db/pool';
import { AppError } from '../shared/errors/AppError';
import { sendSuccess, sendError } from '../shared/helpers/response';
import { LocalStorageClient } from '../shared/storage/LocalStorageClient';
import { eventBus } from '../shared/events/eventBus';
import { Events } from '../shared/events/events';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requireRole, requireStudentSelfOrStaff } from '../middleware/authorize';
import { env } from '../config/env';
import { STUDENT_SUMMARY_SELECT } from '../services/studentDirectory';
import { assertStudentAccess } from '../shared/auth/studentScope';
import { getCurrentResume, parseResume, saveResumeVersion } from '../services/resumeService';

export const studentRouter = Router();

const storage = new LocalStorageClient();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const STUDENT_PROFILE_SELECT = STUDENT_SUMMARY_SELECT;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /api/students/coding-stats/leetcode/:username ─────────────────────────
// Server-side lookup: leetcode.com does not allow browser (CORS) requests.

const LEETCODE_QUERY = `
  query userProblemsSolved($username: String!) {
    matchedUser(username: $username) {
      submitStats { acSubmissionNum { difficulty count } }
    }
  }`;

studentRouter.get(
  '/coding-stats/leetcode/:username',
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const username = String(req.params.username ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(username)) {
        throw new AppError(422, 'Invalid LeetCode username', 'VALIDATION_ERROR');
      }
      let stats: { difficulty: string; count: number }[] | undefined;
      try {
        const { data } = await axios.post(
          'https://leetcode.com/graphql',
          { query: LEETCODE_QUERY, variables: { username } },
          { timeout: 8000, headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' } }
        );
        stats = data?.data?.matchedUser?.submitStats?.acSubmissionNum;
      } catch {
        throw new AppError(503, 'LeetCode could not be reached right now', 'UPSTREAM_UNAVAILABLE');
      }
      if (!stats) throw new AppError(404, 'LeetCode user not found', 'NOT_FOUND');
      // "All" is already the total; adding Easy/Medium/Hard to it double-counts
      const solved = stats.find(s => s.difficulty === 'All')?.count
        ?? stats.reduce((sum, s) => sum + (s.count || 0), 0);
      sendSuccess(res, { username, solved });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── GET /api/students/me ─────────────────────────────────────────────────────

studentRouter.get(
  '/me',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;

      const { rows } = await db.query(`${STUDENT_PROFILE_SELECT} WHERE s.user_id = $1`, [userId]);

      if (rows.length === 0) {
        throw new AppError(404, 'Student not found', 'NOT_FOUND');
      }

      const resume = await getCurrentResume(rows[0].id);
      sendSuccess(res, { student: { ...rows[0], resume: resume?.view ?? null } });
    } catch (err) {
      sendError(res, err);
    }
  }
);

studentRouter.get(
  '/:studentId',
  requireStudentSelfOrStaff,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const studentId = req.params.studentId as string;
      if (!UUID_RE.test(studentId)) throw new AppError(404, 'Student not found', 'NOT_FOUND');
      const { rows } = await db.query(`${STUDENT_PROFILE_SELECT} WHERE s.id = $1`, [studentId]);
      if (rows.length === 0) throw new AppError(404, 'Student not found', 'NOT_FOUND');

      // Students: own record only; mentors: assigned students only
      await assertStudentAccess(req.user!, studentId);

      const resume = await getCurrentResume(studentId);
      sendSuccess(res, { student: { ...rows[0], resume: resume?.view ?? null } });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PATCH /api/students/:studentId ───────────────────────────────────────────

const patchStudentSchema = z.object({
  codingHandles: z
    .object({
      github: z.string().optional(),
      leetcode: z.string().optional(),
      hackerrank: z.string().optional(),
      codeforces: z.string().optional(),
      codechef: z.string().optional(),
      leetcodeSolved: z.number().int().min(0).optional(),
      githubRepos: z.number().int().min(0).optional(),
    })
    .optional(),
});

studentRouter.patch(
  '/:studentId',
  requireStudentSelfOrStaff,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const studentId = req.params.studentId as string;
      if (!UUID_RE.test(studentId)) throw new AppError(404, 'Student not found', 'NOT_FOUND');

      const { rows: existing } = await db.query(
        'SELECT id, user_id, coding_handles FROM org.students WHERE id = $1',
        [studentId]
      );
      if (existing.length === 0) throw new AppError(404, 'Student not found', 'NOT_FOUND');

      // Students: own record only; mentors: assigned students only
      await assertStudentAccess(req.user!, studentId);

      const parsed = patchStudentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      }

      const merged = {
        ...((existing[0].coding_handles as object) ?? {}),
        ...(parsed.data.codingHandles ?? {}),
      };

      const { rows } = await db.query(
        `UPDATE org.students SET coding_handles = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [JSON.stringify(merged), studentId]
      );

      sendSuccess(res, { student: rows[0] });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PATCH /api/students/:studentId/resume ─────────────────────────────────────
// Stores the file and reads it: the extracted text, skills and projects ground the
// mock interview's questions. Only facts written in the resume are kept.

const RESUME_TYPES: Record<string, { ext: string; mime: string }> = {
  '.pdf': { ext: 'pdf', mime: 'application/pdf' },
  '.docx': { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.txt': { ext: 'txt', mime: 'text/plain' },
};

async function assertOwnStudentRecord(studentId: string, userId: string): Promise<void> {
  if (!UUID_RE.test(studentId)) throw new AppError(404, 'Student not found', 'NOT_FOUND');
  const { rows } = await db.query('SELECT user_id FROM org.students WHERE id = $1', [studentId]);
  if (rows.length === 0) throw new AppError(404, 'Student not found', 'NOT_FOUND');
  // Only the student themselves may change their resume
  if (rows[0].user_id !== userId) throw new AppError(403, 'Access denied', 'FORBIDDEN');
}

studentRouter.patch(
  '/:studentId/resume',
  upload.single('resume'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const studentId = req.params.studentId as string;
      await assertOwnStudentRecord(studentId, req.user!.id);

      if (!req.file) throw new AppError(422, 'Resume file required', 'FILE_REQUIRED');
      const extension = (req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
      const type = RESUME_TYPES[extension];
      if (!type) {
        throw new AppError(422, 'Upload a PDF, DOCX or TXT file, or paste your resume text.', 'INVALID_FILE_TYPE');
      }

      // Read it first: an unreadable file (e.g. a scanned image) is rejected with a clear reason
      const parsed = await parseResume({ fileName: req.file.originalname, buffer: req.file.buffer });

      const resumeUrl = await storage.upload(req.file.buffer, `resumes/${randomUUID()}.${type.ext}`, type.mime);
      const version = await saveResumeVersion(studentId, {
        objectKey: resumeUrl,
        fileName: req.file.originalname,
        text: parsed.text,
        data: parsed.data,
      });
      const current = await getCurrentResume(studentId);

      sendSuccess(res, { resumeUrl, fileName: req.file.originalname, version, resume: current?.view ?? null });
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── POST /api/students/:studentId/resume/text ─────────────────────────────────

const resumeTextSchema = z.object({ text: z.string().trim().min(50).max(30_000) });

studentRouter.post(
  '/:studentId/resume/text',
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const studentId = req.params.studentId as string;
      await assertOwnStudentRecord(studentId, req.user!.id);
      const body = resumeTextSchema.safeParse(req.body);
      if (!body.success) {
        throw new AppError(422, 'Paste at least 50 characters of your resume.', 'VALIDATION_ERROR');
      }
      const parsed = await parseResume({ fileName: 'Pasted resume', text: body.data.text });
      const version = await saveResumeVersion(studentId, {
        objectKey: null,
        fileName: 'Pasted resume',
        text: parsed.text,
        data: parsed.data,
      });
      const current = await getCurrentResume(studentId);
      sendSuccess(res, { version, resume: current?.view ?? null }, 201);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ── PATCH /api/students/:studentId/verify-resume (FACULTY_MENTOR) ─────────────

studentRouter.patch(
  '/:studentId/verify-resume',
  requireRole('FACULTY_MENTOR'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { studentId } = req.params;
      const mentorId = req.user!.id;

      // Confirm this mentor is actively assigned to this student
      const { rows: assignment } = await db.query(
        `SELECT id FROM org.student_mentor_assignments
         WHERE student_id = $1 AND mentor_user_id = $2 AND is_active = true`,
        [studentId, mentorId]
      );
      if (assignment.length === 0) {
        throw new AppError(403, 'You are not assigned to this student', 'FORBIDDEN');
      }

      const { rows: resume } = await db.query(
        'SELECT id FROM org.resumes WHERE student_id = $1 AND is_current = true',
        [studentId]
      );
      if (resume.length === 0) throw new AppError(422, 'The student has not uploaded a resume', 'NO_RESUME');

      // Resume sign-off is a PROFILE verification (placement.mentor_verifications, per DBML)
      const { rowCount } = await db.query(
        `UPDATE placement.mentor_verifications
         SET status = 'VERIFIED', mentor_user_id = $2, verified_at = now(), updated_at = now()
         WHERE student_id = $1 AND verification_type = 'PROFILE'`,
        [studentId, mentorId]
      );
      if (rowCount === 0) {
        await db.query(
          `INSERT INTO placement.mentor_verifications
             (student_id, mentor_user_id, verification_type, status, verified_at)
           VALUES ($1, $2, 'PROFILE', 'VERIFIED', now())`,
          [studentId, mentorId]
        );
      }

      const payload = { studentId, mentorId, verifiedAt: new Date().toISOString() };
      eventBus.emit(Events.MENTOR_VERIFIED, payload);

      sendSuccess(res, { message: 'Resume verified' });
    } catch (err) {
      sendError(res, err);
    }
  }
);
