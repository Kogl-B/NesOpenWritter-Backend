# NesOpenWritter-Backend

API для веб-версии **OpenWritter**: Fastify + Prisma + PostgreSQL. Деплоится на **Railway**.

Связан с фронтом [NesOpenWritter](https://github.com/Kogl-B/NesOpenWritter) (Vercel).
Общий план переноса: [фронт/docs/WEB_MIGRATION_PLAN.md](https://github.com/Kogl-B/NesOpenWritter/blob/main/docs/WEB_MIGRATION_PLAN.md).

## Стек

- Node 22+, TypeScript, ESM
- Fastify 5 (+ `@fastify/cors`, `@fastify/cookie`, `@fastify/sensible`)
- Prisma 6 + PostgreSQL 16
- Better-Auth (email+password, OAuth)
- Zod (валидация), pino (логирование)
- `@aws-sdk/client-s3` для Cloudflare R2 (presigned upload-URLs)

## Запуск локально

Требуется Node 22+ и `pnpm`.

```bash
pnpm install
cp .env.example .env                    # минимум: PORT и CORS_ORIGIN
pnpm dev                                 # tsx watch :8080
```

Без Postgres `/health` всё равно отвечает 200 — это намеренно для Этапа 0.

### Команды

```bash
pnpm dev                                 # hot-reload dev server
pnpm build                               # tsc → dist/
pnpm start                               # node dist/server.js
pnpm typecheck                           # tsc --noEmit
pnpm prisma:migrate:dev                  # локальная миграция
pnpm prisma:migrate:deploy               # prod-миграция (вызывается на Railway)
pnpm prisma:studio                       # GUI к БД
```

## Деплой

`railway.toml` уже настроен. Через CLI:

```bash
railway link                              # один раз, выбрать проект
railway up                                # деплой текущей ветки
```

Перед первым деплоем добавить Postgres-аддон в Railway-проект (`railway add` → PostgreSQL) — он автоматически инжектирует `DATABASE_URL`. Остальные переменные из `.env.example` нужно задать вручную в Railway UI.

## Структура

```
src/
├── config/        # env loader (zod-валидация)
├── plugins/       # Fastify-плагины (auth, errors, logging) — добавляются на Этапе 1
├── routes/        # HTTP-эндпоинты
├── services/      # бизнес-логика
├── lib/           # prisma.ts, r2.ts
└── server.ts      # точка входа
prisma/
└── schema.prisma  # User, Session, Account, Verification, Project (Этап 0)
```

## Состояние

- [x] Этап 0 — каркас Fastify + Prisma schema (auth + Project)
- [ ] Этап 1 — Better-Auth + CRUD проектов и персонажей
- [ ] Этап 2 — Items, Locations, Events, Chapters, Tags, связи
- [ ] Этап 3 — R2 presigned uploads, MapElements/MapDrawings
- [ ] Этап 4 — Manuscript (TipTap content), Kanban, Drafts
- [ ] Этап 5 — фронт-PWA (в репо фронта)
- [ ] Этап 6 — полировка
