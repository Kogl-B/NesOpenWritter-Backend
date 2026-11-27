-- Миграция add_user_integration удаляет индексы, которые раньше
-- устанавливали вручную. При чистом развёртывании они должны существовать.
-- Определения совпадают с covering_indexes_list_sorts, которая их восстанавливает.
CREATE INDEX IF NOT EXISTS characters_project_updated_idx ON characters ("projectId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS items_project_updated_idx ON items ("projectId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS events_project_atnum_idx ON timeline_events ("projectId", "atNumeric", "createdAt");
CREATE INDEX IF NOT EXISTS locations_project_lod_name_idx ON locations ("projectId", "lodLevel", name);
