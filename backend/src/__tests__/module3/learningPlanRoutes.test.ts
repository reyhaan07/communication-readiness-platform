/**
 * The student's 4-week plan: current plan + build status, ticking tasks, rebuilding.
 * DB and axios are mocked; no live services required.
 */
import express from 'express';
import request from 'supertest';

const mockQuery = jest.fn();

jest.mock('../../shared/db/pool', () => ({
  db: { query: mockQuery, connect: jest.fn() },
}));

jest.mock('axios', () => ({
  default: { post: jest.fn() },
  post: jest.fn(),
}));

import axios from 'axios';
import { learningRouter } from '../../routes/learning.routes';

const STUDENT_ID = '00000000-0000-0000-0000-000000001001';
const PLAN_ID = '00000000-0000-0000-0000-00000000aaaa';

let currentUser: Record<string, unknown>;
const student = { id: 'user-student-1', role: 'STUDENT', name: 'Alice', email: 'a@test.com', tokenVersion: 0 };
const admin = { id: 'user-admin-1', role: 'PROGRAM_ADMIN', name: 'Admin', email: 'admin@test.com', tokenVersion: 0 };

const app = express();
app.use(express.json());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((req: any, _res: express.Response, next: express.NextFunction) => { req.user = currentUser; next(); });
app.use('/learning', learningRouter);

const PLAN_DATA = {
  version: 2,
  weeklyPlan: [
    { week: 1, days: [{ day: 1, tasks: [{ id: 'w1-d1-t1', text: 'Study' }, { id: 'w1-d1-t2', text: 'Record' }] }], checkpoint: { id: 'w1-cp' } },
  ],
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Db {
  plan?: Record<string, unknown> | null;
  interview?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  runsLastHour?: number;
  ownStudent?: boolean;
  progress?: Record<string, string>;
}

// Answers each query by what it reads, so the order of queries does not matter
function useDb(state: Db): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM org.students')) return { rows: state.ownStudent === false ? [] : [{ id: STUDENT_ID }] };
    if (sql.includes('COUNT(*) AS n')) return { rows: [{ n: String(state.runsLastHour ?? 0) }] };
    if (sql.includes('FROM agent.agent_runs')) return { rows: state.run ? [state.run] : [] };
    if (sql.includes('UPDATE performance.learning_plans')) return { rows: [{ progress: state.progress ?? {} }] };
    if (sql.includes('SELECT student_id, plan_data FROM performance.learning_plans')) {
      return { rows: state.plan ? [{ student_id: STUDENT_ID, plan_data: state.plan.plan_data }] : [] };
    }
    if (sql.includes('FROM performance.learning_plans')) return { rows: state.plan ? [state.plan] : [] };
    if (sql.includes('FROM performance.assessment_reports')) return { rows: state.interview ? [state.interview] : [] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

const plan = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID, plan_data: PLAN_DATA, progress: { 'w1-d1-t1': '2026-10-08T10:00:00Z' },
  source_attempt_id: 'attempt-2', version: 2, created_at: minutesAgo(5), updated_at: minutesAgo(5), ...over,
});

beforeEach(() => {
  mockQuery.mockReset();
  (axios.post as jest.Mock).mockReset();
  currentUser = student;
});

describe('GET /learning/plans/:studentId/current', () => {
  const get = () => request(app).get(`/learning/plans/${STUDENT_ID}/current`);

  it('is READY with the plan built from the latest interview', async () => {
    useDb({ plan: plan(), interview: { attempt_id: 'attempt-2', created_at: minutesAgo(6) },
            run: { id: 'r1', status: 'SUCCEEDED', created_at: minutesAgo(6) } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('READY');
    expect(res.body.data.plan.id).toBe(PLAN_ID);
    expect(res.body.data.plan.progress).toEqual({ 'w1-d1-t1': '2026-10-08T10:00:00Z' });
  });

  it('is GENERATING while the agent runs, and still returns the previous plan', async () => {
    useDb({ plan: plan({ source_attempt_id: 'attempt-1', created_at: minutesAgo(60) }),
            interview: { attempt_id: 'attempt-2', created_at: minutesAgo(1) },
            run: { id: 'r2', status: 'RUNNING', created_at: minutesAgo(1) } });
    const res = await get();
    expect(res.body.data.status).toBe('GENERATING');
    expect(res.body.data.plan.isCurrent).toBe(false);
  });

  it('is GENERATING right after an interview, before the run exists', async () => {
    useDb({ plan: null, interview: { attempt_id: 'attempt-2', created_at: minutesAgo(0.2) }, run: null });
    expect((await get()).body.data.status).toBe('GENERATING');
  });

  it('is FAILED when the run for the latest interview failed', async () => {
    useDb({ plan: null, interview: { attempt_id: 'attempt-2', created_at: minutesAgo(5) },
            run: { id: 'r2', status: 'FAILED', termination_reason: 'boom', created_at: minutesAgo(5) } });
    const res = await get();
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.run.reason).toBe('boom');
  });

  it('treats a run stuck for over 10 minutes as finished', async () => {
    useDb({ plan: null, interview: { attempt_id: 'attempt-2', created_at: minutesAgo(30) },
            run: { id: 'r2', status: 'RUNNING', created_at: minutesAgo(30) } });
    expect((await get()).body.data.status).toBe('MISSING');
  });

  it('is NO_INTERVIEW before the first interview', async () => {
    useDb({ plan: null, interview: null, run: null });
    expect((await get()).body.data.status).toBe('NO_INTERVIEW');
  });

  it("refuses another student's plan", async () => {
    useDb({ ownStudent: false });
    expect((await get()).status).toBe(403);
  });
});

describe('PATCH /learning/plans/:planId/progress', () => {
  const patch = (body: object) => request(app).patch(`/learning/plans/${PLAN_ID}/progress`).send(body);

  it('ticks a task with one atomic jsonb update', async () => {
    useDb({ plan: plan(), progress: { 'w1-d1-t2': '2026-10-08T11:00:00Z' } });
    const res = await patch({ taskId: 'w1-d1-t2', done: true });
    expect(res.status).toBe(200);
    expect(res.body.data.progress).toEqual({ 'w1-d1-t2': '2026-10-08T11:00:00Z' });
    const update = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE performance.learning_plans'));
    expect(update![0]).toContain('jsonb_build_object');
    expect(update![1]).toEqual([PLAN_ID, 'w1-d1-t2']);
  });

  it('un-ticks a task', async () => {
    useDb({ plan: plan() });
    await patch({ taskId: 'w1-cp', done: false });
    const update = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE performance.learning_plans'));
    expect(update![0]).toContain("- $2::text");
  });

  it('rejects ids that are not in the plan', async () => {
    useDb({ plan: plan() });
    expect((await patch({ taskId: 'w9-d1-t1', done: true })).status).toBe(422);
    expect((await patch({ taskId: "w1'; DROP TABLE x;--", done: true })).status).toBe(422);
  });

  it('is for the student only', async () => {
    currentUser = admin;
    useDb({ plan: plan() });
    expect((await patch({ taskId: 'w1-d1-t1', done: true })).status).toBe(403);
  });
});

describe('POST /learning/plans/:studentId/rebuild', () => {
  const rebuild = () => request(app).post(`/learning/plans/${STUDENT_ID}/rebuild`);

  it('starts the agent for the latest interview', async () => {
    useDb({ interview: { attempt_id: 'attempt-2', created_at: minutesAgo(30) }, run: { id: 'r1', status: 'SUCCEEDED', created_at: minutesAgo(29) } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { run_id: 'run-new' } });
    const res = await rebuild();
    expect(res.status).toBe(202);
    expect(res.body.data.agentRunId).toBe('run-new');
    expect((axios.post as jest.Mock).mock.calls[0][1]).toMatchObject({ student_id: STUDENT_ID, triggered_by_user_id: student.id });
  });

  it('needs an interview first', async () => {
    useDb({ interview: null });
    const res = await rebuild();
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code ?? JSON.stringify(res.body)).toContain('NO_INTERVIEW');
  });

  it('does not start a second build while one runs', async () => {
    useDb({ interview: { attempt_id: 'a' }, run: { id: 'r1', status: 'QUEUED', created_at: minutesAgo(1) } });
    expect((await rebuild()).status).toBe(409);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('limits rebuilds per hour', async () => {
    useDb({ interview: { attempt_id: 'a' }, run: null, runsLastHour: 5 });
    expect((await rebuild()).status).toBe(429);
  });

  it('reports the plan service being down as 503', async () => {
    useDb({ interview: { attempt_id: 'a' }, run: null });
    (axios.post as jest.Mock).mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true }));
    expect((await rebuild()).status).toBe(503);
  });
});
