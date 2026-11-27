import type { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { writeNotices } from '../notify/deliver.js';
import { prisma } from '../prisma.js';
import { getProjectAccess } from '../access.js';
import { timelineInputChanged } from '../timeline/publication.js';
import { extractTimeline } from '../timeline/extraction.js';
import { AiHttpError } from './aiError.js';
import { completeSchema, continuityReserveCents, performComplete, refuseTextStart, validateComplete } from './completeWork.js';
import { continuityPurpose } from './continuity.js';
import { continuityHold, failContinuityJob, findContinuityRetry, reserveContinuityJob } from './continuityWallet.js';
import { performCover, performImage, refuseImageStart } from './imageWork.js';

export type AiJobKind = 'image' | 'text' | 'cover';

export interface AiJobView {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string;
}

interface Waiter {
  resolve: (view: AiJobView) => void;
  reject: (err: AiHttpError) => void;
}

const waiters = new Map<string, Waiter>();
const queued = new Set<string>();
let active = 0;
let pumping = false;
const LIMIT = 2;
const TIMELINE_DEBOUNCE_MS = 20_000;
const delayedTimelineJobs = new Map<string, NodeJS.Timeout>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

async function notify(input: {
  userId: string;
  jobId: string;
  title: string;
  body: string;
  href: string;
  failed?: boolean;
}): Promise<void> {
  const href = input.href.trim().slice(0, 2000);
  if (!href) return;
  await writeNotices([{
    userId: input.userId,
    kind: 'ai_result',
    title: clip(input.title, 180),
    body: clip(input.body, input.failed ? 160 : 20_000),
    href,
    eventKey: input.failed ? `ai:${input.jobId}:fail` : `ai:${input.jobId}`,
  }]);
}

function fail(err: unknown): AiHttpError {
  if (err instanceof AiHttpError) return err;
  if (err instanceof ZodError) return new AiHttpError(400, 'Запрос генерации составлен неверно');
  const status = typeof (err as { statusCode?: unknown })?.statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : 502;
  const message = err instanceof Error ? err.message : 'Генерация не удалась';
  return new AiHttpError(status >= 400 && status < 600 ? status : 502, message);
}

async function dispatch(job: {
  id: string;
  userId: string;
  projectId: string;
  kind: string;
  timelineChapterId: string | null;
  request: unknown;
  result: unknown;
}): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUnique({ where: { id: job.userId }, select: { email: true } });
  if (!user) throw new AiHttpError(404, 'Аккаунт не найден');
  if (job.kind === 'timeline') return extractTimeline(job, user.email);
  if (job.kind === 'text') return performComplete(
    job.userId, user.email, job.request, continuityHold(job.result) ? job.id : undefined,
  );
  if (job.kind === 'cover') return performCover(job.userId, job.projectId, job.request);
  if (job.kind === 'image') return { ...(await performImage(job.userId, job.request, job.projectId)) };
  throw new AiHttpError(400, 'Неизвестный вид генерации');
}

function noticeOf(job: { id: string; userId: string; projectId: string; kind: string; request: unknown }, result: Record<string, unknown>): {
  title: string;
  body: string;
  href: string;
} {
  const href = typeof result.href === 'string' ? result.href : '';
  const book = job.projectId ? `/projects/${job.projectId}` : '/account#notices';
  if (job.kind === 'timeline') {
    const count = Array.isArray(result.proposals) ? result.proposals.length : 0;
    return {
      title: 'Разбор хронологии завершён',
      body: count ? `Предложений к проверке: ${count}.` : 'Новых событий в этом фрагменте не найдено.',
      href: book,
    };
  }
  if (job.kind === 'text') {
    return {
      title: 'Текст ИИ готов',
      body: typeof result.text === 'string' ? result.text : 'Ответ сохранён в уведомлении.',
      href: book,
    };
  }
  if (job.kind === 'cover') {
    const polished = result.polished === true;
    const extra = typeof result.polishError === 'string' && result.polishError ? ` ${result.polishError}` : '';
    return {
      title: 'Обложка готова',
      body: polished ? 'Обложка нарисована и улучшена.' : `Обложка сохранена.${extra}`,
      href: book,
    };
  }
  const deliver = asRecord(asRecord(job.request)?.deliver);
  if (deliver?.type === 'row-photo') {
    return {
      title: 'Картинка готова',
      body: result.placed === false
        ? 'Сохранить в строку не удалось. Ссылка откроет картинку.'
        : 'Она записана в строку таблицы.',
      href: result.placed === false ? href : (job.projectId ? `/projects/${job.projectId}/world` : href),
    };
  }
  return {
    title: 'Картинка готова',
    body: 'Ссылка откроет картинку.',
    href: href || book,
  };
}

async function runClaimed(id: string): Promise<void> {
  const job = await prisma.aiJob.findUnique({ where: { id } });
  if (!job || job.status !== 'running') return;
  const paidContinuity = job.kind === 'text' && asRecord(job.request)?.purpose === continuityPurpose;
  let settled = false;
  try {
    const result = await dispatch(job);
    if (paidContinuity) {
      // Задача, квитанция и расчёт уже записаны вместе. Сбой уведомления их не меняет.
      waiters.get(id)?.resolve({ id, status: 'done', result, error: '' });
      settled = true;
      const note = noticeOf(job, result);
      await notify({ userId: job.userId, jobId: job.id, ...note }).catch((err) =>
        console.error('[ai-job] CONTINUITY_NOTICE_FAILED', { id, err }));
      return;
    }
    if (job.kind !== 'timeline' || (Array.isArray(result.proposals) && result.proposals.length > 0)) {
      const note = noticeOf(job, result);
      await notify({ userId: job.userId, jobId: job.id, ...note });
    }
    await prisma.aiJob.update({
      where: { id },
      data: { status: 'done', result: result as Prisma.InputJsonValue, error: '', finishedAt: new Date() },
    });
    waiters.get(id)?.resolve({ id, status: 'done', result, error: '' });
    settled = true;
  } catch (err) {
    const problem = fail(err);
    const href = job.projectId ? `/projects/${job.projectId}` : '/account#notices';
    try {
      if (paidContinuity) await failContinuityJob(id, job.userId, problem.message);
      if (!(job.kind === 'timeline' && problem.statusCode === 409 && timelineInputChanged(problem.message))) {
        await notify({
          userId: job.userId,
          jobId: job.id,
          title: 'Генерация не удалась',
          body: problem.message,
          href,
          failed: true,
        });
      }
      if (!paidContinuity) await prisma.aiJob.update({
        where: { id },
        data: { status: 'failed', error: problem.message.slice(0, 500), finishedAt: new Date() },
      });
    } catch (saveErr) {
      console.error('[ai-job] AI_JOB_FAILURE_WRITE_FAILED', { id, saveErr });
    }
    waiters.get(id)?.reject(problem);
    settled = true;
  } finally {
    if (!settled) waiters.get(id)?.reject(new AiHttpError(502, 'Генерация не удалась'));
    waiters.delete(id);
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (active < LIMIT && queued.size > 0) {
      const id = queued.values().next().value;
      if (!id) break;
      queued.delete(id);
      const claimed = await prisma.aiJob.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'running', startedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      active += 1;
      void runClaimed(id).finally(() => {
        active -= 1;
        void pump();
      });
    }
  } finally {
    pumping = false;
  }
}

function releaseTimelineJob(id: string, notBefore: number) {
  const timer = delayedTimelineJobs.get(id);
  const delay = notBefore - Date.now();
  if (delay > 0) {
    if (!timer) delayedTimelineJobs.set(id, setTimeout(() => releaseTimelineJob(id, 0), delay).unref());
    return;
  }
  if (timer) clearTimeout(timer);
  delayedTimelineJobs.delete(id);
  queued.add(id);
  void pump().catch((error) => console.error('[timeline] failed to start queued job', { jobId: id, error }));
}

/** Непринятые задачи продолжаются после перезапуска. Прерванный вызов модели повторно не списывается. */
export async function startAiJobs(): Promise<void> {
  const restartMessage = 'Сервер перезапустился во время генерации. Запустите её ещё раз.';
  const runningContinuity = await prisma.aiJob.findMany({
    where: { status: 'running', kind: 'text', request: { path: ['purpose'], equals: continuityPurpose } },
    select: { id: true, userId: true },
  });
  for (const row of runningContinuity) await failContinuityJob(row.id, row.userId, restartMessage);
  await prisma.aiJob.updateMany({
    where: { status: 'running', NOT: { kind: 'text', request: { path: ['purpose'], equals: continuityPurpose } } },
    data: {
      status: 'failed',
      error: restartMessage,
      finishedAt: new Date(),
    },
  });
  const waiting = await prisma.aiJob.findMany({
    where: { status: 'queued' },
    select: { id: true, kind: true, request: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of waiting) {
    if (row.kind === 'timeline' && asRecord(row.request)?.automatic === true) {
      releaseTimelineJob(row.id, row.createdAt.getTime() + TIMELINE_DEBOUNCE_MS);
    } else {
      queued.add(row.id);
    }
  }
  void pump();
}

async function waitForReplay(userId: string, id: string): Promise<AiJobView> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const job = await readAiJob(userId, id);
    if (!job) throw new AiHttpError(404, 'Проверка не найдена.');
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new AiHttpError(409, job.error);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new AiHttpError(503, 'Проверка ещё выполняется.');
}

export async function enqueueAiJob(input: {
  userId: string;
  email: string;
  kind: AiJobKind;
  projectId: string;
  request: Record<string, unknown>;
}): Promise<{ id: string; done: Promise<AiJobView> }> {
  let row: { id: string };
  if (input.kind === 'text' && input.request.purpose === continuityPurpose) {
    const normalized = completeSchema.parse(input.request);
    const issue = validateComplete(normalized);
    if (issue) throw new AiHttpError(400, issue);
    if (normalized.projectId !== input.projectId) throw new AiHttpError(400, 'Проект проверки не совпадает.');
    const role = await getProjectAccess(input.projectId, input.userId);
    if (!role || role === 'viewer') throw new AiHttpError(404, 'Книга не найдена');
    const matching = await findContinuityRetry(input.userId, normalized);
    if (matching) return { id: matching.id, done: waitForReplay(input.userId, matching.id) };
    const provider = await refuseTextStart(input.userId, input.email, false);
    const reserved = await reserveContinuityJob(input.userId, input.projectId, normalized, continuityReserveCents(normalized, provider));
    if (reserved.existing) return { id: reserved.id, done: waitForReplay(input.userId, reserved.id) };
    row = reserved;
  } else {
    if (input.kind === 'text') await refuseTextStart(input.userId, input.email);
    else await refuseImageStart(input.userId);
    const request = JSON.parse(JSON.stringify(input.request)) as Prisma.InputJsonValue;
    row = await prisma.aiJob.create({
      data: { userId: input.userId, projectId: input.projectId, kind: input.kind, status: 'queued', request },
      select: { id: true },
    });
  }
  const done = new Promise<AiJobView>((resolve, reject) => {
    waiters.set(row.id, { resolve, reject });
  });
  queued.add(row.id);
  void pump();
  return { id: row.id, done };
}

/** Один разбор текста и настроек на сцену, независимо от автора запроса. */
export async function enqueueTimelineJob(input: {
  userId: string;
  projectId: string;
  chapterId: string;
  version: string;
  automatic: boolean;
}): Promise<{ id: string; status: string }> {
  const timelineKey = `${input.chapterId}:${input.version}`;
  const request = { version: input.version, automatic: input.automatic };
  await prisma.aiJob.createMany({
    skipDuplicates: true,
    data: {
      timelineKey,
      timelineChapterId: input.chapterId,
      kind: 'timeline',
      status: 'queued',
      userId: input.userId,
      projectId: input.projectId,
      request,
    },
  });
  const row = await prisma.aiJob.findUniqueOrThrow({
    where: { timelineKey }, select: { id: true, status: true, createdAt: true, error: true },
  });
  if (row.status === 'failed' && (!input.automatic || timelineInputChanged(row.error))) {
    const retry = await prisma.aiJob.updateMany({
      where: { id: row.id, status: 'failed' },
      data: { status: 'queued', request, userId: input.userId, error: '', startedAt: null, finishedAt: null },
    });
    if (retry.count) row.status = 'queued';
  }
  if (row.status === 'queued') {
    releaseTimelineJob(row.id, input.automatic ? row.createdAt.getTime() + TIMELINE_DEBOUNCE_MS : 0);
  }
  return { id: row.id, status: row.status };
}

export async function readAiJob(userId: string, id: string): Promise<AiJobView | null> {
  const row = await prisma.aiJob.findFirst({
    where: { id, userId },
    select: { id: true, status: true, result: true, error: true },
  });
  if (!row) return null;
  const hold = row.status === 'queued' || row.status === 'running' ? continuityHold(row.result) : undefined;
  return {
    id: row.id,
    status: row.status,
    result: hold ? { billing: { reservedCents: hold.cents } } : asRecord(row.result),
    error: row.error,
  };
}
