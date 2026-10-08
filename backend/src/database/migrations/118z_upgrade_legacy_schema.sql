-- Upgrades a database built by the earlier version of these migrations (the shared
-- Supabase instance) to the columns this version of the application uses.
--
-- The earlier version is recognised by its own columns: org.subdivisions.batch_id and
-- org.student_mentor_assignments.mentor_id. Nothing is dropped or renamed. Legacy
-- columns stay, their values are copied into the new ones, and triggers keep both
-- in step, so rows written by either version of the application stay consistent.
--
-- On a database built from this repository the legacy columns do not exist and
-- every block below is skipped. The file sorts before 119_*, whose statements
-- depend on the columns added here.

-- ── Institutions, programs, batches: activity flag + updated_at ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'batches' AND column_name = 'track')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'batches' AND column_name = 'is_active') THEN
    ALTER TABLE org.institutions ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT true;
    ALTER TABLE org.institutions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE org.programs     ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT true;
    ALTER TABLE org.programs     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE org.batches      ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT true;
    ALTER TABLE org.batches      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    -- This version creates batches without a track
    ALTER TABLE org.batches ALTER COLUMN track DROP NOT NULL;

    DROP TRIGGER IF EXISTS trg_institutions_updated_at ON org.institutions;
    CREATE TRIGGER trg_institutions_updated_at BEFORE UPDATE ON org.institutions
      FOR EACH ROW EXECUTE FUNCTION system.set_updated_at();
    DROP TRIGGER IF EXISTS trg_programs_updated_at ON org.programs;
    CREATE TRIGGER trg_programs_updated_at BEFORE UPDATE ON org.programs
      FOR EACH ROW EXECUTE FUNCTION system.set_updated_at();
    DROP TRIGGER IF EXISTS trg_batches_updated_at ON org.batches;
    CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON org.batches
      FOR EACH ROW EXECUTE FUNCTION system.set_updated_at();
  END IF;
END $$;

-- ── Subdivisions: belong to a program (legacy: to a batch) ───────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'subdivisions' AND column_name = 'batch_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'subdivisions' AND column_name = 'program_id') THEN
    ALTER TABLE org.subdivisions ADD COLUMN program_id UUID;
    ALTER TABLE org.subdivisions ADD COLUMN code       VARCHAR(50);
    ALTER TABLE org.subdivisions ADD COLUMN is_active  BOOLEAN     NOT NULL DEFAULT true;
    ALTER TABLE org.subdivisions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    UPDATE org.subdivisions sd SET program_id = b.program_id
    FROM org.batches b WHERE b.id = sd.batch_id;

    IF NOT EXISTS (SELECT 1 FROM org.subdivisions WHERE program_id IS NULL) THEN
      ALTER TABLE org.subdivisions ALTER COLUMN program_id SET NOT NULL;
    END IF;
    ALTER TABLE org.subdivisions
      ADD CONSTRAINT fk_subdivisions_program FOREIGN KEY (program_id) REFERENCES org.programs(id) ON DELETE RESTRICT;
    -- This version creates subdivisions under a program, without a batch
    ALTER TABLE org.subdivisions ALTER COLUMN batch_id DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_subdivisions_program_code ON org.subdivisions (program_id, code);

    DROP TRIGGER IF EXISTS trg_subdivisions_updated_at ON org.subdivisions;
    CREATE TRIGGER trg_subdivisions_updated_at BEFORE UPDATE ON org.subdivisions
      FOR EACH ROW EXECUTE FUNCTION system.set_updated_at();
  END IF;
END $$;

-- Rows inserted by the earlier version name only the batch: derive the program
CREATE OR REPLACE FUNCTION org.legacy_subdivision_program() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.program_id IS NULL AND NEW.batch_id IS NOT NULL THEN
    SELECT program_id INTO NEW.program_id FROM org.batches WHERE id = NEW.batch_id;
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'subdivisions' AND column_name = 'batch_id') THEN
    DROP TRIGGER IF EXISTS trg_subdivisions_legacy_program ON org.subdivisions;
    CREATE TRIGGER trg_subdivisions_legacy_program BEFORE INSERT OR UPDATE ON org.subdivisions
      FOR EACH ROW EXECUTE FUNCTION org.legacy_subdivision_program();
  ELSE
    DROP FUNCTION IF EXISTS org.legacy_subdivision_program();
  END IF;
END $$;

-- ── Students: program_id (legacy: derived from the batch, or student_programs) ─
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'students' AND column_name = 'resume_verified')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'students' AND column_name = 'program_id') THEN
    ALTER TABLE org.students ADD COLUMN program_id UUID;
    ALTER TABLE org.students ADD COLUMN target_subdivision_id UUID REFERENCES org.subdivisions(id);

    UPDATE org.students s SET program_id = b.program_id
    FROM org.batches b WHERE b.id = s.batch_id;

    IF NOT EXISTS (SELECT 1 FROM org.students WHERE program_id IS NULL) THEN
      ALTER TABLE org.students ALTER COLUMN program_id SET NOT NULL;
    END IF;
    ALTER TABLE org.students
      ADD CONSTRAINT fk_students_program FOREIGN KEY (program_id) REFERENCES org.programs(id);
    -- Self-registered students may not have a roll number yet
    ALTER TABLE org.students ALTER COLUMN roll_number DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_students_program_batch ON org.students (program_id, batch_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION org.legacy_student_program() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.program_id IS NULL AND NEW.batch_id IS NOT NULL THEN
    SELECT program_id INTO NEW.program_id FROM org.batches WHERE id = NEW.batch_id;
  END IF;
  RETURN NEW;
END $$;

-- The earlier version reads enrolments from org.student_programs
CREATE OR REPLACE FUNCTION org.legacy_student_enrolment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.program_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org.student_programs WHERE student_id = NEW.id AND program_id = NEW.program_id
  ) THEN
    INSERT INTO org.student_programs (student_id, program_id) VALUES (NEW.id, NEW.program_id);
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'students' AND column_name = 'resume_verified') THEN
    DROP TRIGGER IF EXISTS trg_students_legacy_program ON org.students;
    CREATE TRIGGER trg_students_legacy_program BEFORE INSERT OR UPDATE ON org.students
      FOR EACH ROW EXECUTE FUNCTION org.legacy_student_program();
  ELSE
    DROP FUNCTION IF EXISTS org.legacy_student_program();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'org' AND table_name = 'student_programs') THEN
    DROP TRIGGER IF EXISTS trg_students_legacy_enrolment ON org.students;
    CREATE TRIGGER trg_students_legacy_enrolment AFTER INSERT ON org.students
      FOR EACH ROW EXECUTE FUNCTION org.legacy_student_enrolment();
  ELSE
    DROP FUNCTION IF EXISTS org.legacy_student_enrolment();
  END IF;
END $$;

-- ── Mentor assignments: mentor_user_id (legacy: mentor_id) ───────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'student_mentor_assignments' AND column_name = 'mentor_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'student_mentor_assignments' AND column_name = 'mentor_user_id') THEN
    ALTER TABLE org.student_mentor_assignments ADD COLUMN mentor_user_id UUID;
    ALTER TABLE org.student_mentor_assignments ADD COLUMN starts_at TIMESTAMPTZ;
    ALTER TABLE org.student_mentor_assignments ADD COLUMN ends_at   TIMESTAMPTZ;
    UPDATE org.student_mentor_assignments SET mentor_user_id = mentor_id, starts_at = assigned_at;
    ALTER TABLE org.student_mentor_assignments ALTER COLUMN mentor_user_id SET NOT NULL;
    ALTER TABLE org.student_mentor_assignments
      ADD CONSTRAINT fk_sma_mentor_user FOREIGN KEY (mentor_user_id) REFERENCES identity.users(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_sma_mentor_user ON org.student_mentor_assignments (mentor_user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION org.legacy_mentor_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.mentor_user_id IS DISTINCT FROM OLD.mentor_user_id THEN
    NEW.mentor_id := NEW.mentor_user_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.mentor_id IS DISTINCT FROM OLD.mentor_id THEN
    NEW.mentor_user_id := NEW.mentor_id;
  END IF;
  NEW.mentor_user_id := COALESCE(NEW.mentor_user_id, NEW.mentor_id);
  NEW.mentor_id      := COALESCE(NEW.mentor_id, NEW.mentor_user_id);
  NEW.starts_at      := COALESCE(NEW.starts_at, NEW.assigned_at, now());
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'student_mentor_assignments' AND column_name = 'mentor_id') THEN
    DROP TRIGGER IF EXISTS trg_sma_legacy_columns ON org.student_mentor_assignments;
    CREATE TRIGGER trg_sma_legacy_columns BEFORE INSERT OR UPDATE ON org.student_mentor_assignments
      FOR EACH ROW EXECUTE FUNCTION org.legacy_mentor_columns();
  ELSE
    DROP FUNCTION IF EXISTS org.legacy_mentor_columns();
  END IF;
END $$;

-- ── Trainer assignments: trainer_user_id + timestamps (legacy: trainer_id + dates) ─
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'trainer_subdivision_assignments' AND column_name = 'trainer_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'trainer_subdivision_assignments' AND column_name = 'trainer_user_id') THEN
    ALTER TABLE org.trainer_subdivision_assignments ADD COLUMN trainer_user_id UUID;
    ALTER TABLE org.trainer_subdivision_assignments ADD COLUMN starts_at TIMESTAMPTZ;
    ALTER TABLE org.trainer_subdivision_assignments ADD COLUMN ends_at   TIMESTAMPTZ;
    ALTER TABLE org.trainer_subdivision_assignments ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
    UPDATE org.trainer_subdivision_assignments
    SET trainer_user_id = trainer_id,
        starts_at = start_date::timestamptz,
        ends_at   = end_date::timestamptz,
        is_active = (end_date IS NULL OR end_date >= current_date);
    ALTER TABLE org.trainer_subdivision_assignments ALTER COLUMN trainer_user_id SET NOT NULL;
    ALTER TABLE org.trainer_subdivision_assignments
      ADD CONSTRAINT fk_tsa_trainer_user FOREIGN KEY (trainer_user_id) REFERENCES identity.users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tsa_trainer_user ON org.trainer_subdivision_assignments (trainer_user_id, subdivision_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION org.legacy_trainer_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.trainer_user_id IS DISTINCT FROM OLD.trainer_user_id THEN
    NEW.trainer_id := NEW.trainer_user_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.trainer_id IS DISTINCT FROM OLD.trainer_id THEN
    NEW.trainer_user_id := NEW.trainer_id;
  END IF;
  NEW.trainer_user_id := COALESCE(NEW.trainer_user_id, NEW.trainer_id);
  NEW.trainer_id      := COALESCE(NEW.trainer_id, NEW.trainer_user_id);
  NEW.start_date      := COALESCE(NEW.start_date, NEW.starts_at::date, current_date);
  NEW.starts_at       := COALESCE(NEW.starts_at, NEW.start_date::timestamptz);
  NEW.end_date        := COALESCE(NEW.end_date, NEW.ends_at::date);
  NEW.ends_at         := COALESCE(NEW.ends_at, NEW.end_date::timestamptz);
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'trainer_subdivision_assignments' AND column_name = 'trainer_id') THEN
    DROP TRIGGER IF EXISTS trg_tsa_legacy_columns ON org.trainer_subdivision_assignments;
    CREATE TRIGGER trg_tsa_legacy_columns BEFORE INSERT OR UPDATE ON org.trainer_subdivision_assignments
      FOR EACH ROW EXECUTE FUNCTION org.legacy_trainer_columns();
  ELSE
    DROP FUNCTION IF EXISTS org.legacy_trainer_columns();
  END IF;
END $$;

-- ── Users: institution scoping, names, activity flag ─────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'students' AND column_name = 'resume_verified')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'identity' AND table_name = 'users' AND column_name = 'institution_id') THEN
    ALTER TABLE identity.users ADD COLUMN institution_id UUID REFERENCES org.institutions(id);
    ALTER TABLE identity.users ADD COLUMN department_id  UUID REFERENCES org.departments(id);
    ALTER TABLE identity.users ADD COLUMN first_name     VARCHAR(100);
    ALTER TABLE identity.users ADD COLUMN last_name      VARCHAR(100);
    ALTER TABLE identity.users ADD COLUMN is_active      BOOLEAN NOT NULL DEFAULT true;

    UPDATE identity.users
    SET first_name = split_part(name, ' ', 1),
        last_name  = NULLIF(btrim(substr(name, length(split_part(name, ' ', 1)) + 1)), '');

    -- Students: their program's institution
    UPDATE identity.users u SET institution_id = p.institution_id
    FROM org.students s JOIN org.programs p ON p.id = s.program_id
    WHERE s.user_id = u.id AND u.institution_id IS NULL;
    -- Mentors: the institution of the students they mentor
    UPDATE identity.users u SET institution_id = p.institution_id
    FROM org.student_mentor_assignments sma
    JOIN org.students s ON s.id = sma.student_id
    JOIN org.programs p ON p.id = s.program_id
    WHERE sma.mentor_user_id = u.id AND u.institution_id IS NULL;
    -- Trainers: the institution of the subdivisions they teach
    UPDATE identity.users u SET institution_id = p.institution_id
    FROM org.trainer_subdivision_assignments tsa
    JOIN org.subdivisions sd ON sd.id = tsa.subdivision_id
    JOIN org.programs p ON p.id = sd.program_id
    WHERE tsa.trainer_user_id = u.id AND u.institution_id IS NULL;
    -- Staff who joined by invitation: the inviting institution
    UPDATE identity.users u SET institution_id = i.institution_id
    FROM identity.invites i
    WHERE i.accepted_by_user_id = u.id AND i.institution_id IS NOT NULL AND u.institution_id IS NULL;
    -- Remaining staff: the earlier version did not record an institution for them. When
    -- exactly one institution runs programs, that is the one they work for.
    UPDATE identity.users u SET institution_id = p.institution_id
    FROM (SELECT institution_id FROM org.programs GROUP BY institution_id) p
    WHERE u.institution_id IS NULL AND u.role <> 'PLATFORM_OWNER'
      AND (SELECT count(DISTINCT institution_id) FROM org.programs) = 1;
  END IF;
END $$;

-- ── Invites: varchar status (adds CANCELLED), inviter, updated_at ────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'identity' AND table_name = 'invites' AND column_name = 'status'
               AND udt_name = 'invite_status') THEN
    ALTER TABLE identity.invites ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE identity.invites ALTER COLUMN status TYPE VARCHAR(20) USING status::text;
    ALTER TABLE identity.invites ALTER COLUMN status SET DEFAULT 'PENDING';
    ALTER TABLE identity.invites ADD CONSTRAINT invites_status_check
      CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'));
    ALTER TABLE identity.invites ADD COLUMN IF NOT EXISTS invited_by_user_id UUID
      REFERENCES identity.users(id) ON DELETE SET NULL;
    ALTER TABLE identity.invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

-- ── Interview transcripts: question/answer per turn (legacy: transcript_text) ─
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'session' AND table_name = 'interview_transcripts' AND column_name = 'transcript_text')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'session' AND table_name = 'interview_transcripts' AND column_name = 'question') THEN
    ALTER TABLE session.interview_transcripts ADD COLUMN question   TEXT;
    ALTER TABLE session.interview_transcripts ADD COLUMN answer     TEXT;
    ALTER TABLE session.interview_transcripts ADD COLUMN difficulty VARCHAR(20);
    ALTER TABLE session.interview_transcripts ADD COLUMN stt_raw    TEXT;
    UPDATE session.interview_transcripts SET answer = transcript_text WHERE answer IS NULL;
  END IF;
END $$;

-- ── Assessment session states ────────────────────────────────────────────────
-- The earlier version only allowed INITIALIZED/ACTIVE/PAUSED/COMPLETED/TERMINATED.
-- The live interview also records STARTED, ABANDONED and CONCLUDED.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'session.assessment_sessions'::regclass
               AND conname = 'assessment_sessions_state_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%STARTED%') THEN
    ALTER TABLE session.assessment_sessions DROP CONSTRAINT assessment_sessions_state_check;
    ALTER TABLE session.assessment_sessions ADD CONSTRAINT assessment_sessions_state_check
      CHECK (state IN ('INITIALIZED', 'STARTED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CONCLUDED', 'ABANDONED', 'TERMINATED'));
  END IF;
END $$;

-- ── Columns the earlier version made NOT NULL but this version leaves optional ─
-- e.g. a mock interview has no listening score, so its performance snapshot stores
-- NULL there. Only the NOT NULL rule is lifted; existing values are untouched.
DO $$
DECLARE
  target TEXT;
  parts  TEXT[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'org' AND table_name = 'students' AND column_name = 'resume_verified') THEN
    FOREACH target IN ARRAY ARRAY[
      'assessment.assessment_attempts.started_at', 'assessment.assessment_attempts.status',
      'assessment.assessment_components.component_type', 'assessment.assessment_components.name',
      'assessment.assessment_components.weight', 'assessment.assessments.assessment_type',
      'assessment.assessments.name', 'credit.credit_policies.consume_amount',
      'credit.credit_policies.initial_credit_amount', 'credit.credit_policies.reward_ceiling',
      'credit.credit_policies.scope_type', 'credit.credit_transactions.amount',
      'credit.credit_transactions.balance_after', 'credit.credit_transactions.transaction_type',
      'evaluation.ai_runs.capability', 'evaluation.ai_runs.status',
      'evaluation.response_evaluations.evaluation_version', 'evaluation.responses.input_type',
      'evaluation.responses.submitted_at', 'knowledge.knowledge_chunks.chunk_index',
      'knowledge.knowledge_documents.title', 'performance.assessment_reports.scoring_version',
      'performance.performance_profiles.communication_score', 'performance.performance_profiles.listening_score',
      'performance.performance_profiles.overall_score', 'performance.performance_profiles.technical_score',
      'performance.performance_snapshots.communication_score', 'performance.performance_snapshots.listening_score',
      'performance.performance_snapshots.overall_score', 'performance.performance_snapshots.technical_score',
      'performance.skill_performances.score', 'placement.checklist_items.name',
      'placement.checklist_progress.status', 'placement.mentor_verifications.status',
      'placement.mentor_verifications.verification_type', 'placement.placement_eligibility.is_eligible',
      'session.assessment_sessions.current_sequence_no', 'session.assessment_sessions.state',
      'session.assessment_sessions.state_data', 'session.question_bank_items.difficulty',
      'session.question_bank_items.question_text', 'session.questions.difficulty',
      'session.questions.question_text', 'session.questions.question_type',
      'session.questions.question_version', 'session.questions.sequence_no'
    ] LOOP
      parts := string_to_array(target, '.');
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = parts[1] AND table_name = parts[2] AND column_name = parts[3]
                   AND is_nullable = 'NO') THEN
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL', parts[1], parts[2], parts[3]);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── Student skills (absent from the earlier version) ─────────────────────────
CREATE TABLE IF NOT EXISTS performance.student_skills (
  student_id        UUID    NOT NULL REFERENCES org.students(id) ON DELETE CASCADE,
  skill_id          UUID    NOT NULL REFERENCES performance.skills(id) ON DELETE CASCADE,
  proficiency_score NUMERIC,
  source            VARCHAR,
  updated_at        TIMESTAMPTZ,
  PRIMARY KEY (student_id, skill_id)
);
