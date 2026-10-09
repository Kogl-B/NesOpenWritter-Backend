-- Покрывающие индексы сортировок списков (R24): ORDER BY после фильтра по
-- projectId сегодня выполняется сортировкой heap-строк; на малых таблицах
-- плановик и так выбирает seq-scan, но с ростом (прод: тысячи записей)
-- составной индекс даст index-only scan без sort. Добавлены только для
-- четырёх регулярно запрашиваемых списков; IF NOT EXISTS — идемпотентно.
CREATE INDEX IF NOT EXISTS characters_project_updated_idx ON characters ("projectId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS items_project_updated_idx ON items ("projectId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS events_project_atnum_idx ON timeline_events ("projectId", "atNumeric", "createdAt");
CREATE INDEX IF NOT EXISTS locations_project_lod_name_idx ON locations ("projectId", "lodLevel", name);
