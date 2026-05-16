# NesOpenWritter — backend

API-сервис для OpenWritter. Планируемый стек: **Fastify + Prisma + PostgreSQL**, деплой на Railway.

Каталог зарезервирован для будущей реализации (см. [`../docs/WEB_MIGRATION_PLAN.md`](../docs/WEB_MIGRATION_PLAN.md), [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)).

## Планируемая структура

```
backend/
├── src/
│   ├── routes/      # Fastify-роуты
│   ├── services/    # бизнес-логика
│   ├── db/          # Prisma client, миграции
│   └── lib/         # auth, logger, утилиты
├── prisma/          # schema.prisma + migrations
├── package.json
└── tsconfig.json
```

## Связанные репозитории

| Репо | Назначение |
|---|---|
| [NesOpenWritter-Backend](https://github.com/Kogl-B/NesOpenWritter-Backend) | Прежний отдельный репо бэкенда (будет смёрджен сюда) |
| `@kogl-b/openwritter-shared` | Общие TS-типы и Zod-схемы (GitHub Packages) |
