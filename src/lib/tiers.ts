/**
 * Тарифы подписки — единый источник ограничений (проекты + место).
 * Базовая валюта цен — белорусский рубль (BYN); USD и RUB пересчитываются
 * по курсу НБ РБ (см. lib/currency.ts, обновление в 12:00 по Минску).
 * null-лимиты = безлимит (тариф «Команда», условия по договорённости).
 */
export type TierId =
  | 'test'
  | 'hobby'
  | 'amateur'
  | 'pro'
  | 'proplus'
  | 'promax'
  | 'team';

export interface TierDef {
  id: TierId;
  name: string;
  /** Цена в белорусских рублях за месяц; null — по договорённости. */
  priceByn: number | null;
  /** Максимум собственных проектов; null — безлимит. */
  projectLimit: number | null;
  /** Максимум занимаемого места в МБ; null — безлимит. */
  storageLimitMb: number | null;
  features: string[];
}

export const MB = 1024 * 1024;

export const TIERS: readonly TierDef[] = [
  {
    id: 'test',
    name: 'Тест',
    priceByn: 0,
    projectLimit: 3,
    storageLimitMb: 50,
    features: [
      'Все базовые инструменты: рукопись, архив, карта, хронология',
    ],
  },
  {
    id: 'hobby',
    name: 'Хобби',
    priceByn: 5,
    projectLimit: 10,
    storageLimitMb: 150,
    features: [
      'Для первых серьёзных историй и черновиков',
    ],
  },
  {
    id: 'amateur',
    name: 'Любитель',
    priceByn: 15,
    projectLimit: 30,
    storageLimitMb: 500,
    features: [
      'Канбан, генераторы, спринт-таймер',
    ],
  },
  {
    id: 'pro',
    name: 'Про',
    priceByn: 30,
    projectLimit: 75,
    storageLimitMb: 1000,
    features: [
      'Экспорт EPUB/DOCX/PDF, режим чтения',
      'Для пишущих регулярно и публикующихся',
    ],
  },
  {
    id: 'proplus',
    name: 'Про+',
    priceByn: 50,
    projectLimit: 150,
    storageLimitMb: 3000,
    features: [
      'Экономика мира, доска расследований, вики',
      'Длинные циклы и серии книг',
    ],
  },
  {
    id: 'promax',
    name: 'Про макс',
    priceByn: 100,
    projectLimit: 500,
    storageLimitMb: 15360,
    features: [
      'Все инструменты без ограничений тарифов',
      'Максимальный запас для большого творчества',
    ],
  },
  {
    id: 'team',
    name: 'Команда',
    priceByn: null,
    projectLimit: null,
    storageLimitMb: null,
    features: [
      'Проекты и место — по договорённости',
      'Совместная работа и роли',
      'Индивидуальные условия для студий и редакций',
    ],
  },
] as const;

export const DEFAULT_TIER: TierId = 'test';

export function isTierId(v: unknown): v is TierId {
  return typeof v === 'string' && TIERS.some((t) => t.id === v);
}

export function getTier(id: string | null | undefined): TierDef {
  return TIERS.find((t) => t.id === id) ?? TIERS[0]!;
}

/** Цена во всех валютах; null — по договорённости. USD/RUB — 2 знака. */
export function tierPrices(
  priceByn: number | null,
  bynPerUsd: number,
  bynPerRub: number
): { BYN: number; USD: number; RUB: number } | null {
  if (priceByn == null) return null;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    BYN: priceByn,
    USD: round2(priceByn / bynPerUsd),
    RUB: round2(priceByn / bynPerRub),
  };
}
