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
  /** Одна фраза: для кого этот тариф. */
  summary: string;
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
    summary: 'Чтобы открыть сервис и написать первую сцену.',
    features: [
      'Рукопись, персонажи, карта и хронология',
      '3 проекта и 50 МБ — короткий текст или проба',
      'Бесплатно и без срока',
    ],
  },
  {
    id: 'hobby',
    name: 'Хобби',
    priceByn: 5,
    projectLimit: 10,
    storageLimitMb: 150,
    summary: 'Для рассказа, цикла зарисовок или первой повести.',
    features: [
      '10 проектов и 150 МБ',
      'Связи персонажей, калькуляторы и вики',
      'Запас, если пишете для себя и не спешите',
    ],
  },
  {
    id: 'amateur',
    name: 'Любитель',
    priceByn: 15,
    projectLimit: 30,
    storageLimitMb: 500,
    summary: 'Для нескольких историй, которые ведутся одновременно.',
    features: [
      '30 проектов и 500 МБ',
      'Канбан, генераторы и доска расследований',
      'Места хватает на черновики и заметки мира',
    ],
  },
  {
    id: 'pro',
    name: 'Про',
    priceByn: 30,
    projectLimit: 75,
    storageLimitMb: 1000,
    summary: 'Для регулярной работы и подготовки текста к публикации.',
    features: [
      '75 проектов и 1 ГБ',
      'Экспорт книги и чтение рукописи целиком',
      'Роман с картой, хронологией и архивом',
    ],
  },
  {
    id: 'proplus',
    name: 'Про+',
    priceByn: 50,
    projectLimit: 150,
    storageLimitMb: 3000,
    summary: 'Для длинного цикла или общего мира на несколько книг.',
    features: [
      '150 проектов и 3 ГБ',
      'Экономика мира, расследования и большая вики',
      'Несколько связанных историй рядом',
    ],
  },
  {
    id: 'promax',
    name: 'Про макс',
    priceByn: 100,
    projectLimit: 500,
    storageLimitMb: 15360,
    summary: 'Для большого архива: много книг, карт и материалов.',
    features: [
      '500 проектов и 15 ГБ',
      'Все инструменты рукописи и мира',
      'Сюда помещается весь творческий архив',
    ],
  },
  {
    id: 'team',
    name: 'Команда',
    priceByn: null,
    projectLimit: null,
    storageLimitMb: null,
    summary: 'Для студии, редакции или соавторов с общими проектами.',
    features: [
      'Число проектов и место — по договорённости',
      'Роли: владелец, редактор и читатель',
      'Условия подбираются под вашу команду',
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
