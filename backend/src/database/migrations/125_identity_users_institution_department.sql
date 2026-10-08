-- identity.users.institution_id / department_id scope every admin view. Databases built
-- by the earlier version of the migrations lacked them; on this schema they already exist
-- and only the indexes are new. Already applied to the shared Supabase database.

ALTER TABLE identity.users
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES org.institutions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id  UUID REFERENCES org.departments(id)  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_institution_id ON identity.users (institution_id);
CREATE INDEX IF NOT EXISTS idx_users_department_id  ON identity.users (department_id);
