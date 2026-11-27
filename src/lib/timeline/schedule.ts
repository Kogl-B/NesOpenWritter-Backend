import type { FastifyBaseLogger } from 'fastify';
import { AiHttpError } from '../ai/aiError.js';
import { enqueueTimelineJob } from '../ai/jobs.js';
import { prisma } from '../prisma.js';
import { checkTimelineSize, timelineInput } from './extraction.js';

import { isTimelineReady, TIMELINE_PUBLICATION_REQUIRED } from './publication.js';

type TimelineSource = { userId: string; projectId: string; chapterId: string };

export async function scheduleTimelineAnalysis(input: TimelineSource & { automatic: boolean }) {
  const source = await timelineInput(prisma, input.projectId, input.chapterId);
  if (!source) return null;
  if (!isTimelineReady(source.chapter.stage)) {
    if (input.automatic) return null;
    throw new AiHttpError(409, TIMELINE_PUBLICATION_REQUIRED);
  }
  if (input.automatic && !source.settings.enabled) return null;
  if (input.automatic && !source.text) return null;
  if (!input.automatic) checkTimelineSize(source.text);
  return enqueueTimelineJob({ ...input, version: source.version });
}

export async function queueAutomaticTimelineAnalysis(input: TimelineSource, logger: FastifyBaseLogger) {
  try {
    await scheduleTimelineAnalysis({ ...input, automatic: true });
  } catch (error) {
    logger.error({ err: error, ...input }, 'could not queue timeline analysis');
  }
}
