import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { assertProjectOwnership } from '../lib/access.js';

/**
 * PDF-лорбук: выгрузка всех статей вики проекта в PDF.
 */
export async function wikiBookRoutes(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/export/wiki-book',
    async (req: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      app.requireAuth(req);
      if (!(await assertProjectOwnership(req.params.projectId, req.user!.id))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const pages = await prisma.wikiPage.findMany({
        where: { projectId: req.params.projectId },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
      });
      if (pages.length === 0) return reply.status(404).send({ error: 'No wiki pages' });

      const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

      // Build simple text-based PDF
      const lines: Array<{ text: string; size: number }> = [
        { text: 'Lore Book', size: 24 },
        { text: '', size: 10 },
      ];
      for (const page of pages) {
        lines.push({ text: page.title, size: 16 });
        if (page.category) lines.push({ text: `Category: ${page.category}`, size: 10 });
        for (const line of page.content.split('\n').slice(0, 5)) {
          lines.push({ text: line.slice(0, 80), size: 10 });
        }
        lines.push({ text: '---', size: 10 });
      }

      let content = '';
      let y = 720;
      for (const line of lines) {
        if (y < 50) break; // single page limit
        content += `BT /F1 ${line.size} Tf 72 ${y} Td (${esc(line.text)}) Tj ET\n`;
        y -= line.size + 8;
      }

      const objects: string[] = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];

      let pdf = '%PDF-1.4\n';
      const offsets: number[] = [];
      for (let i = 0; i < objects.length; i++) {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
      }
      const xrefStart = pdf.length;
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const off of offsets) {
        pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
      }
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

      return reply.type('application/pdf').send(Buffer.from(pdf, 'latin1'));
    },
  );
}
