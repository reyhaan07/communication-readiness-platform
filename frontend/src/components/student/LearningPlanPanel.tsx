import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Dumbbell,
  ExternalLink,
  Flag,
  Lightbulb,
  ListChecks,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import { CurrentLearningPlan, InterviewPlanData, PlanWeek } from '../../types';

interface Props {
  current: CurrentLearningPlan | null;
  loading: boolean;
  error: string | null;
  rebuilding: boolean;
  readOnly: boolean;
  completed: number;
  total: number;
  onToggle: (taskId: string) => void;
  onRebuild: () => void;
  onStartInterview: () => void;
}

const KIND_LABEL: Record<PlanWeek['kind'], string> = {
  topic: 'Close a gap',
  delivery: 'Delivery',
  projects: 'Resume projects',
  depth: 'Go deeper',
  simulation: 'Simulation',
};

const scoreTone = (score: number | null | undefined) =>
  score == null ? 'text-neutral-500'
    : score >= 80 ? 'text-emerald-700 dark:text-emerald-400'
    : score >= 60 ? 'text-amber-700 dark:text-amber-400'
    : 'text-rose-700 dark:text-rose-400';

const STATUS_CHIP: Record<string, string> = {
  STRONG: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60',
  MODERATE: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60',
  NEEDS_WORK: 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/60',
};

const isInterviewPlan = (data: unknown): data is InterviewPlanData =>
  !!data && (data as InterviewPlanData).version === 2 && Array.isArray((data as InterviewPlanData).weeklyPlan);

function Checkbox({ checked, disabled, onClick, label }: { checked: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`mt-0.5 w-[18px] h-[18px] rounded-md flex items-center justify-center flex-shrink-0 transition-all ${
        checked
          ? 'bg-emerald-600 text-white border border-emerald-600'
          : 'border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 hover:border-neutral-500'
      } ${disabled ? 'cursor-default opacity-80' : 'cursor-pointer'}`}
    >
      {checked && <Check className="w-3 h-3" />}
    </button>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <h5 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
      <Icon className="w-3.5 h-3.5" />
      {children}
    </h5>
  );
}

function WeekView({ week, progress, readOnly, onToggle, onStartInterview }: {
  week: PlanWeek; progress: Record<string, string>; readOnly: boolean;
  onToggle: (id: string) => void; onStartInterview: () => void;
}) {
  const [openQuestion, setOpenQuestion] = useState<number | null>(null);
  const done = (id: string) => Boolean(progress[id]);

  return (
    <div className="p-5 sm:p-6 space-y-6">
      {/* Objective + why */}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 font-mono">
                WEEK {week.week}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {KIND_LABEL[week.kind] ?? week.kind}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                <Clock className="w-3 h-3" /> about {week.estimatedHours} h
              </span>
            </div>
            <h4 className="text-base font-bold text-neutral-900 dark:text-neutral-100">{week.title}</h4>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mt-1 leading-relaxed">{week.objective}</p>
          </div>
          <div className="rounded-xl bg-neutral-50 dark:bg-neutral-900/60 border border-neutral-200/80 dark:border-neutral-800 p-3.5">
            <SectionTitle icon={Lightbulb}>Why this week</SectionTitle>
            <p className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">{week.whyThisWeek}</p>
            {week.evidence?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {week.evidence.map((e, i) => (
                  <li key={i} className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed pl-3 border-l-2 border-neutral-300 dark:border-neutral-700">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Targets */}
        <div className="lg:col-span-2">
          <SectionTitle icon={Target}>This week's targets</SectionTitle>
          <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-900/60 text-neutral-500">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Measure</th>
                  <th className="text-left font-semibold px-2 py-2">Now</th>
                  <th className="text-left font-semibold px-2 py-2">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {week.targets.map((t, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-neutral-800 dark:text-neutral-200">{t.metric}</td>
                    <td className="px-2 py-2 font-mono text-neutral-500 whitespace-nowrap">{t.baseline}</td>
                    <td className="px-2 py-2 font-mono font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">{t.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Day by day */}
      <div>
        <SectionTitle icon={CalendarDays}>Day by day</SectionTitle>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {week.days.map((day) => {
            const dayDone = day.tasks.filter((t) => done(t.id)).length;
            return (
              <div key={day.day} className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 p-3.5">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">Day {day.day} · {day.minutes} min</p>
                    <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{day.title}</p>
                  </div>
                  <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
                    dayDone === day.tasks.length ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                  }`}>{dayDone}/{day.tasks.length}</span>
                </div>
                <ul className="space-y-2">
                  {day.tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-2.5">
                      <Checkbox checked={done(task.id)} disabled={readOnly} onClick={() => onToggle(task.id)} label={task.text} />
                      <span className={`text-xs leading-relaxed ${done(task.id) ? 'line-through text-neutral-400' : 'text-neutral-700 dark:text-neutral-300'}`}>
                        {task.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Practice questions */}
        <div>
          <SectionTitle icon={MessageSquare}>Practice questions</SectionTitle>
          <ul className="space-y-2">
            {week.practiceQuestions.map((q, i) => (
              <li key={i} className="rounded-xl border border-neutral-200/80 dark:border-neutral-800">
                <button
                  type="button"
                  onClick={() => setOpenQuestion(openQuestion === i ? null : i)}
                  className="w-full flex items-start gap-2 p-3 text-left cursor-pointer"
                  aria-expanded={openQuestion === i}
                >
                  {openQuestion === i ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-neutral-500" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-neutral-500" />}
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100 leading-relaxed">{q.question}</span>
                    {q.from && <span className="block text-[10px] text-rose-700 dark:text-rose-400 font-semibold mt-0.5">{q.from}</span>}
                  </span>
                </button>
                {openQuestion === i && q.goodAnswerCovers.length > 0 && (
                  <div className="px-3 pb-3 pl-8">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 mb-1">A strong answer covers</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {q.goodAnswerCovers.map((c, j) => (
                        <li key={j} className="text-xs text-neutral-700 dark:text-neutral-300">{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          {/* Drill */}
          <div className="rounded-xl bg-indigo-50/60 dark:bg-indigo-950/20 border border-indigo-200/70 dark:border-indigo-900/50 p-3.5">
            <SectionTitle icon={Dumbbell}>Delivery drill — {week.drill.name}</SectionTitle>
            <ol className="list-decimal pl-4 space-y-1">
              {week.drill.steps.map((s, i) => (
                <li key={i} className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">{s}</li>
              ))}
            </ol>
            <p className="text-[11px] font-semibold text-indigo-800 dark:text-indigo-300 mt-2">{week.drill.target}</p>
          </div>

          {week.studyNotes && week.studyNotes.length > 0 && (
            <div>
              <SectionTitle icon={BookOpen}>Techniques to learn</SectionTitle>
              <ul className="space-y-2">
                {week.studyNotes.map((n, i) => (
                  <li key={i} className="text-xs text-neutral-700 dark:text-neutral-300">
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100">{n.topic}: </span>
                    {n.learn.join('; ')}{n.tryThis ? ` — try: ${n.tryThis}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Resources */}
          {week.resources.length > 0 && (
            <div>
              <SectionTitle icon={Search}>Resources</SectionTitle>
              <ul className="space-y-1.5">
                {week.resources.map((r, i) => {
                  const url = r.url ? safeHttpUrl(r.url) : null;
                  return (
                    <li key={i} className="text-xs">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer"
                           className="inline-flex items-center gap-1 font-medium text-blue-700 dark:text-blue-400 hover:underline">
                          {r.title} <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="font-medium text-neutral-900 dark:text-neutral-100">{r.title}</span>
                      )}
                      {r.usage && <span className="block text-[11px] text-neutral-500">{r.usage}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Checkpoint */}
      <div className="rounded-xl border-2 border-dashed border-neutral-300 dark:border-neutral-700 p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-start gap-2.5 min-w-0">
          <Checkbox checked={done(week.checkpoint.id)} disabled={readOnly} onClick={() => onToggle(week.checkpoint.id)} label="Weekly checkpoint done" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-1.5">
              <Flag className="w-3.5 h-3.5 text-rose-600" /> End-of-week checkpoint
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300 mt-0.5">{week.checkpoint.task}</p>
            <p className="text-[11px] text-neutral-500 mt-0.5"><span className="font-semibold">Pass if:</span> {week.checkpoint.passIf}</p>
            <p className="text-[11px] text-neutral-500 mt-1"><span className="font-semibold">Done when:</span> {week.measurableOutcome}</p>
          </div>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={onStartInterview}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-neutral-900 hover:bg-black text-white text-xs font-semibold cursor-pointer flex-shrink-0"
          >
            <Mic className="w-3.5 h-3.5" /> Start mock interview
          </button>
        )}
      </div>
    </div>
  );
}

// Plans made before interview-based plans: weeks with a focus and a list of activities
function LegacyPlanView({ data, progress, readOnly, onToggle }: {
  data: Record<string, any>; progress: Record<string, string>; readOnly: boolean; onToggle: (id: string) => void;
}) {
  const weeks: any[] = Array.isArray(data.weeklyPlan) ? data.weeklyPlan : [];
  return (
    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {weeks.map((w, wi) => (
        <div key={wi} className="p-5 sm:px-6">
          <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">Week {w.week ?? wi + 1}</p>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{w.focus}</p>
          {w.objective && <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">{w.objective}</p>}
          <ul className="mt-2 space-y-1.5">
            {(w.activities ?? []).map((a: string, ai: number) => {
              const id = `w${wi + 1}-a${ai + 1}`;
              return (
                <li key={id} className="flex items-start gap-2.5">
                  <Checkbox checked={Boolean(progress[id])} disabled={readOnly} onClick={() => onToggle(id)} label={a} />
                  <span className={`text-xs ${progress[id] ? 'line-through text-neutral-400' : 'text-neutral-700 dark:text-neutral-300'}`}>{a}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export const LearningPlanPanel: React.FC<Props> = ({
  current, loading, error, rebuilding, readOnly, completed, total, onToggle, onRebuild, onStartInterview,
}) => {
  const data = current?.plan?.data;
  const plan = isInterviewPlan(data) ? data : null;
  const progress = current?.plan?.progress ?? {};
  const status = current?.status;
  const percent = total ? Math.round((completed / total) * 100) : 0;

  // Open the first week that still has unticked work
  const firstOpenWeek = plan?.weeklyPlan.find((w) =>
    w.days.some((d) => d.tasks.some((t) => !progress[t.id])) || !progress[w.checkpoint.id])?.week ?? 1;
  const [activeWeek, setActiveWeek] = useState(firstOpenWeek);
  const planId = current?.plan?.id;
  // Re-open on the first unfinished week only when a different plan arrives
  useEffect(() => { setActiveWeek(firstOpenWeek); }, [planId]);

  const weekProgress = (w: PlanWeek) => {
    const ids = [...w.days.flatMap((d) => d.tasks.map((t) => t.id)), w.checkpoint.id];
    return { done: ids.filter((id) => progress[id]).length, total: ids.length };
  };

  const header = (
    <div className="p-5 sm:p-6 border-b border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/50 dark:bg-[#141414] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <h3 className="text-base font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <ListChecks className="w-4.5 h-4.5" /> Your 4-Week Improvement Plan
        </h3>
        <p className="text-xs text-neutral-500 mt-0.5">
          Built from your latest mock interview — every task targets something the interview measured.
        </p>
      </div>
      {current?.plan && (
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded-xl text-xs font-bold border ${
            percent >= 75 ? 'bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60'
              : percent > 0 ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60'
              : 'bg-neutral-100 text-neutral-700 border-neutral-300 dark:bg-neutral-900 dark:text-neutral-200 dark:border-neutral-700'
          }`}>
            {completed}/{total} tasks · {percent}%
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuilding || status === 'GENERATING'}
              title="Build a fresh plan from your latest interview"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 text-xs font-semibold text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rebuilding ? 'animate-spin' : ''}`} /> Rebuild
            </button>
          )}
        </div>
      )}
    </div>
  );

  const shell = (children: React.ReactNode) => (
    <div className="bg-white dark:bg-[#171717] border border-neutral-200/90 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-xs">
      {header}
      {error && (
        <div className="mx-5 sm:mx-6 mt-4 px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
        </div>
      )}
      {children}
    </div>
  );

  if (loading && !current) {
    return shell(
      <div className="p-10 flex items-center justify-center gap-2 text-xs text-neutral-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your plan…
      </div>
    );
  }

  if (!current?.plan) {
    if (status === 'GENERATING') {
      return shell(
        <div className="p-10 text-center space-y-2">
          <Loader2 className="w-7 h-7 animate-spin text-neutral-400 mx-auto" />
          <h4 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Building your personalised 4-week plan…</h4>
          <p className="text-xs text-neutral-500 max-w-md mx-auto">
            The learning agent is analysing every answer from your interview — scores, missed key points, pace and filler
            words — and planning four weeks of daily work around them. This usually takes under a minute.
          </p>
        </div>
      );
    }
    if (status === 'FAILED' || status === 'MISSING') {
      return shell(
        <div className="p-10 text-center space-y-3">
          <AlertTriangle className="w-7 h-7 text-amber-500 mx-auto" />
          <h4 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Your plan could not be built yet</h4>
          <p className="text-xs text-neutral-500 max-w-md mx-auto">Your interview is saved. Build the plan from it now.</p>
          {!readOnly && (
            <button type="button" onClick={onRebuild} disabled={rebuilding}
              className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-900 hover:bg-black text-white rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-60">
              <RefreshCw className={`w-3.5 h-3.5 ${rebuilding ? 'animate-spin' : ''}`} /> Build my plan
            </button>
          )}
        </div>
      );
    }
    return shell(
      <div className="p-10 text-center space-y-2">
        <Sparkles className="w-8 h-8 text-neutral-300 mx-auto" />
        <h4 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">No plan yet</h4>
        <p className="text-xs text-neutral-500 max-w-md mx-auto">
          Take a mock interview. Your 4-week plan is built from it: the questions you lost marks on, the key points you
          missed, and how you sounded.
        </p>
        {!readOnly && (
          <button type="button" onClick={onStartInterview}
            className="mt-2 inline-flex items-center gap-2 px-4 py-2 bg-neutral-900 hover:bg-black text-white rounded-xl text-xs font-semibold cursor-pointer">
            <Mic className="w-3.5 h-3.5" /> Take an interview to build your plan
          </button>
        )}
      </div>
    );
  }

  const banner = status === 'GENERATING' ? (
    <div className="mx-5 sm:mx-6 mt-4 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 text-xs text-blue-800 dark:text-blue-300 flex items-center gap-2">
      <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" /> Updating your plan from your latest interview…
    </div>
  ) : !current.plan.isCurrent ? (
    <div className="mx-5 sm:mx-6 mt-4 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> This plan is from an earlier interview. Use Rebuild to plan from your latest one.
    </div>
  ) : null;

  if (!plan) {
    return shell(<>{banner}<LegacyPlanView data={data as Record<string, any>} progress={progress} readOnly={readOnly} onToggle={onToggle} /></>);
  }

  const week = plan.weeklyPlan.find((w) => w.week === activeWeek) ?? plan.weeklyPlan[0];

  return shell(
    <>
      {banner}
      {/* Diagnosis */}
      <div className="p-5 sm:p-6 space-y-4 border-b border-neutral-200/80 dark:border-neutral-800">
        <div>
          <p className="text-sm font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4 text-emerald-600" /> {plan.headline}
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 leading-relaxed">{plan.summary}</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {plan.finalTargets.map((t, i) => (
            <div key={i} className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 px-3 py-2">
              <p className="text-[10px] font-semibold text-neutral-500 truncate" title={t.metric}>{t.metric}</p>
              <p className="text-sm font-bold font-mono text-neutral-900 dark:text-neutral-100">
                <span className={scoreTone(t.unit ? null : t.baseline)}>{t.baseline}</span>
                <span className="text-neutral-400 mx-1">→</span>
                <span className="text-emerald-700 dark:text-emerald-400">{t.target}</span>
                {t.unit && <span className="text-[10px] font-normal text-neutral-500 ml-1">{t.unit}</span>}
              </p>
            </div>
          ))}
        </div>

        {plan.focusAreas.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {plan.focusAreas.map((a) => (
              <span key={a.name} title={a.missed.length ? `Missed: ${a.missed.join('; ')}` : undefined}
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_CHIP[a.status] ?? STATUS_CHIP.MODERATE}`}>
                {a.name} · {a.score}/100
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Week tabs */}
      <div className="px-3 sm:px-4 pt-3 flex gap-1.5 overflow-x-auto border-b border-neutral-200/80 dark:border-neutral-800" role="tablist">
        {plan.weeklyPlan.map((w) => {
          const p = weekProgress(w);
          const active = w.week === week.week;
          return (
            <button
              key={w.week}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveWeek(w.week)}
              className={`flex-shrink-0 text-left px-3 py-2 rounded-t-xl border-b-2 transition-colors cursor-pointer ${
                active ? 'border-neutral-900 dark:border-white bg-neutral-50 dark:bg-neutral-900' : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-900/60'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Week {w.week} · {p.done}/{p.total}
              </span>
              <span className={`block text-xs font-semibold max-w-[180px] truncate ${active ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-600 dark:text-neutral-400'}`}>
                {w.focus}
                {w.focusScore != null && <span className={`ml-1 font-mono ${scoreTone(w.focusScore)}`}>{w.focusScore}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <WeekView week={week} progress={progress} readOnly={readOnly} onToggle={onToggle} onStartInterview={onStartInterview} />
    </>
  );
};
