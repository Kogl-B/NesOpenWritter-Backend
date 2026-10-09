-- Полнотекстовый ускоритель глобального поиска (Ctrl+K): ILIKE '%...%' по
-- широким текстовым колонкам персонажей делал seq-scan по biography — 25ms
-- на 454 строках, и это была доминирующая стоимость /search. GIN trigram
-- индексы переводят все четыре OR-колонки в bitmap-OR index scan.
--
-- Остальные таблицы поиска (items/locations/events/chapters/tags) сканятся
-- за ≤2.5ms — индексы им не нужны и только добавили бы write-усиление.
--
-- DO-блок вместо прямого CREATE EXTENSION: на хостингах без права на
-- расширения (не-суперпользователь) миграция должна проходить, а не ронять
-- deploy; без расширения индексы просто не создаются (поиск деградирует
-- до seq-scan, как сейчас).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_trgm unavailable, skipping search indexes';
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS characters_name_trgm    ON characters USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS characters_short_trgm   ON characters USING gin ("shortName" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS characters_summary_trgm ON characters USING gin (summary gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS characters_bio_trgm     ON characters USING gin (biography gin_trgm_ops);
  END IF;
END
$$;
