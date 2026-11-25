-- Supply the predecessor indexes for the historical DROP INDEX statements on fresh installs.
-- Skip databases that have already applied those statements, and keep their checksums intact.
DO $prepare$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name = '20261009232558_add_user_integration'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS characters_project_updated_idx ON characters ("projectId", "updatedAt" DESC);
  CREATE INDEX IF NOT EXISTS items_project_updated_idx ON items ("projectId", "updatedAt" DESC);
  CREATE INDEX IF NOT EXISTS events_project_atnum_idx ON timeline_events ("projectId", "atNumeric", "createdAt");
  CREATE INDEX IF NOT EXISTS locations_project_lod_name_idx ON locations ("projectId", "lodLevel", name);
END
$prepare$;
