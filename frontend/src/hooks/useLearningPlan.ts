import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { CurrentLearningPlan } from '../types';

// While the agent builds a plan the dashboard checks back this often, for at most this long
const POLL_MS = 4000;
const POLL_LIMIT_MS = 6 * 60 * 1000;

// Every id the student can tick: day tasks and weekly checkpoints, or (older plans) activities
export function planTaskIds(data: unknown): string[] {
  const weeks: any[] = Array.isArray((data as any)?.weeklyPlan) ? (data as any).weeklyPlan : [];
  const ids: string[] = [];
  weeks.forEach((week, w) => {
    if (Array.isArray(week.days)) {
      for (const day of week.days) for (const task of day.tasks ?? []) if (task?.id) ids.push(task.id);
      if (week.checkpoint?.id) ids.push(week.checkpoint.id);
    } else if (Array.isArray(week.activities)) {
      week.activities.forEach((_: unknown, i: number) => ids.push(`w${w + 1}-a${i + 1}`));
    }
  });
  return ids;
}

/**
 * The student's current 4-week plan. `refreshKey` (the latest report id) refetches after
 * a new interview; while the plan is being built it polls until it is ready.
 */
export function useLearningPlan(studentId: string | undefined, refreshKey?: string) {
  const [current, setCurrent] = useState<CurrentLearningPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const pollStarted = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!studentId) return;
    try {
      const next = await api.learning.getCurrentPlan(studentId);
      setCurrent(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plan');
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    setLoading(true);
    pollStarted.current = null;
    void load();
  }, [load, refreshKey]);

  // Poll while the agent is building the plan
  useEffect(() => {
    if (current?.status !== 'GENERATING') {
      pollStarted.current = null;
      return;
    }
    pollStarted.current ??= Date.now();
    if (Date.now() - pollStarted.current > POLL_LIMIT_MS) return;
    const timer = setTimeout(() => { void load(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [current, load]);

  const toggleTask = useCallback(async (taskId: string) => {
    const plan = current?.plan;
    if (!plan) return;
    const done = !plan.progress[taskId];
    const previous = plan.progress;
    const optimistic = { ...previous };
    if (done) optimistic[taskId] = new Date().toISOString(); else delete optimistic[taskId];
    setCurrent((c) => (c?.plan ? { ...c, plan: { ...c.plan, progress: optimistic } } : c));
    try {
      const progress = await api.learning.setPlanTask(plan.id, taskId, done);
      setCurrent((c) => (c?.plan?.id === plan.id ? { ...c, plan: { ...c.plan, progress } } : c));
    } catch (err) {
      setCurrent((c) => (c?.plan?.id === plan.id ? { ...c, plan: { ...c.plan, progress: previous } } : c));
      setError(err instanceof Error ? err.message : 'Could not save that tick');
    }
  }, [current]);

  const rebuild = useCallback(async () => {
    if (!studentId) return;
    setRebuilding(true);
    try {
      await api.learning.rebuildPlan(studentId);
      setError(null);
      pollStarted.current = null;
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rebuild the plan');
    } finally {
      setRebuilding(false);
    }
  }, [studentId, load]);

  const ids = planTaskIds(current?.plan?.data);
  const completed = ids.filter((id) => current?.plan?.progress[id]).length;

  return { current, loading, error, rebuilding, toggleTask, rebuild, reload: load, completed, total: ids.length };
}
