-- org.resumes.version must be set: two NULL versions for one student would both pass
-- the (student_id, version) unique index, since SQL unique indexes treat NULLs as distinct.
-- Already applied to the shared Supabase database by the earlier version of this file.

-- Any NULL version gets the next free number for that student (never a duplicate)
WITH numbered AS (
  SELECT r.id,
         COALESCE((SELECT MAX(version) FROM org.resumes x WHERE x.student_id = r.student_id), 0)
           + ROW_NUMBER() OVER (PARTITION BY r.student_id ORDER BY r.created_at) AS next_version
  FROM org.resumes r
  WHERE r.version IS NULL
)
UPDATE org.resumes r SET version = n.next_version
FROM numbered n WHERE n.id = r.id;

ALTER TABLE org.resumes ALTER COLUMN version SET NOT NULL;
