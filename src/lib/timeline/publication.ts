export const TIMELINE_PUBLICATION_REQUIRED = 'Разбор хронологии доступен для главы со статусом «Опубликована».';

export function isTimelineReady(stage: string | null | undefined): boolean {
  return stage === 'published';
}

export function timelineInputChanged(message: string): boolean {
  return message === TIMELINE_PUBLICATION_REQUIRED || message.startsWith('Текст или настройки');
}
