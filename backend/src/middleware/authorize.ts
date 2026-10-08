import { Response, NextFunction } from 'express';
import { AuthRequest } from './authenticate';
import { UserRole, STAFF_ROLES } from '../shared/types/roles';
import { AppError } from '../shared/errors/AppError';

// A College Admin is the Super Admin of their own college, and a Trainer works with
// students like a Faculty Mentor; routes written for one accept the other.
const ROLE_ALIASES: Partial<Record<UserRole, UserRole>> = {
  COLLEGE_ADMIN: 'SUPER_ADMIN',
  TRAINER: 'FACULTY_MENTOR',
};

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      const err = new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
      res.status(401).json({ status: 'error', message: err.message, code: err.code });
      return;
    }
    const alias = ROLE_ALIASES[req.user.role];
    if (!roles.includes(req.user.role) && !(alias && roles.includes(alias))) {
      const err = new AppError(403, `Requires one of: ${roles.join(', ')}`, 'FORBIDDEN');
      res.status(403).json({ status: 'error', message: err.message, code: err.code });
      return;
    }
    next();
  };
};

// Coarse guard: STUDENT or any staff role. The handler must still check the
// specific student (assertStudentAccess) — students and mentors are scoped.
export const requireStudentSelfOrStaff = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const user = req.user!;

  if (STAFF_ROLES.includes(user.role)) { next(); return; }
  if (user.role === 'STUDENT') { next(); return; }

  const err = new AppError(403, 'Access denied', 'FORBIDDEN');
  res.status(403).json({ status: 'error', message: err.message, code: err.code });
};
