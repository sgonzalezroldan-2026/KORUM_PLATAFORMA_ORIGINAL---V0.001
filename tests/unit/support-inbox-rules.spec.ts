import { describe, expect, it } from 'vitest';
import { answerTicketSchema, ENTITY_TOPICS, entityMessageSchema, planTicketAnswer, REPLY_MAX, REPLY_MIN } from '@/core/support/support-inbox-rules';

const CODE = 'TCK-7K3M9Q';

describe('Sprint 4.4c · reglas de la bandeja de soporte del centro', () => {
  describe('contestar una consulta', () => {
    it('contestar una consulta abierta la pasa a «en curso» y guarda el texto limpio', () => {
      const parsed = answerTicketSchema.parse({ ticketCode: CODE, reply: '  Gracias por avisar.\r\n\r\n\r\n\r\nLo miramos esta semana.  ' });
      expect(parsed.reply).toBe('Gracias por avisar.\n\nLo miramos esta semana.');
      expect(planTicketAnswer({ status: 'OPEN', hasReply: false }, { reply: parsed.reply })).toEqual({ ok: true, nextStatus: 'IN_PROGRESS', reply: parsed.reply });
    });

    it('contestar y resolver a la vez deja la consulta resuelta', () => {
      expect(planTicketAnswer({ status: 'OPEN', hasReply: false }, { reply: 'Hecho, ya está arreglado.', status: 'RESOLVED' })).toMatchObject({ ok: true, nextStatus: 'RESOLVED' });
      expect(planTicketAnswer({ status: 'IN_PROGRESS', hasReply: false }, { reply: 'Hecho, ya está arreglado.', status: 'RESOLVED' })).toMatchObject({ ok: true, nextStatus: 'RESOLVED' });
    });

    it('el estado solo avanza: una consulta resuelta no se toca y «en curso» sobre «en curso» no es un cambio', () => {
      expect(planTicketAnswer({ status: 'RESOLVED', hasReply: true }, { status: 'IN_PROGRESS' })).toEqual({ ok: false, reason: 'ALREADY_RESOLVED' });
      expect(planTicketAnswer({ status: 'RESOLVED', hasReply: false }, { reply: 'Otra respuesta distinta.' })).toEqual({ ok: false, reason: 'ALREADY_RESOLVED' });
      expect(planTicketAnswer({ status: 'IN_PROGRESS', hasReply: false }, { status: 'IN_PROGRESS' })).toEqual({ ok: false, reason: 'NOTHING_TO_CHANGE' });
    });

    it('una consulta se contesta una sola vez, pero se puede resolver después', () => {
      expect(planTicketAnswer({ status: 'IN_PROGRESS', hasReply: true }, { reply: 'Una segunda respuesta.' })).toEqual({ ok: false, reason: 'ALREADY_REPLIED' });
      expect(planTicketAnswer({ status: 'IN_PROGRESS', hasReply: true }, { status: 'RESOLVED' })).toEqual({ ok: true, nextStatus: 'RESOLVED', reply: null });
    });

    it('se puede resolver o poner en curso sin contestar', () => {
      expect(planTicketAnswer({ status: 'OPEN', hasReply: false }, { status: 'RESOLVED' })).toEqual({ ok: true, nextStatus: 'RESOLVED', reply: null });
      expect(planTicketAnswer({ status: 'OPEN', hasReply: false }, { status: 'IN_PROGRESS' })).toEqual({ ok: true, nextStatus: 'IN_PROGRESS', reply: null });
    });

    it('rechaza lo que no sea un código real, un estado inventado, campos de más o una petición vacía', () => {
      expect(answerTicketSchema.safeParse({ ticketCode: 'TCK-901', reply: 'Gracias por avisar.' }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: 'TCK-0O1I1L', reply: 'Gracias por avisar.' }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, status: 'OPEN' }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, status: 'DELETED' }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: 'Gracias por avisar.', organizationId: 'otra-entidad' }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: '   \n  ' }).success).toBe(false);
    });

    it('la respuesta tiene un mínimo y un máximo, y el campo vacío del formulario es «no lo toco»', () => {
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: 'a'.repeat(REPLY_MIN - 1) }).success).toBe(false);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: 'a'.repeat(REPLY_MIN) }).success).toBe(true);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: 'a'.repeat(REPLY_MAX) }).success).toBe(true);
      expect(answerTicketSchema.safeParse({ ticketCode: CODE, reply: 'a'.repeat(REPLY_MAX + 1) }).success).toBe(false);
      expect(answerTicketSchema.parse({ ticketCode: CODE, reply: '', status: 'RESOLVED' })).toEqual({ ticketCode: CODE, status: 'RESOLVED' });
    });

    it('no admite caracteres invisibles ni de dirección de texto en la respuesta', () => {
      const parsed = answerTicketSchema.parse({ ticketCode: CODE, reply: 'Hola​, gracias‮ por escribir.' });
      expect(parsed.reply).not.toMatch(/[​‮]/);
    });
  });

  describe('lo que la entidad escribe a KORUM', () => {
    it('admite los cuatro temas de la entidad y ninguno más (tampoco la rectificación de datos de una persona)', () => {
      expect([...ENTITY_TOPICS]).toEqual(['INITIATIVE', 'PAYMENT', 'ACCOUNT', 'OTHER']);
      for (const topic of ENTITY_TOPICS) expect(entityMessageSchema.safeParse({ topic, subject: 'Una duda de la liquidación', message: 'Necesitamos saber cuándo llega el dinero a la cuenta.' }).success).toBe(true);
      expect(entityMessageSchema.safeParse({ topic: 'RECTIFICATION', subject: 'Una duda de la liquidación', message: 'Necesitamos saber cuándo llega el dinero a la cuenta.' }).success).toBe(false);
    });

    it('exige asunto y mensaje con su mínimo, y no deja pasar campos que fijan la bandeja ni la entidad', () => {
      const base = { topic: 'PAYMENT', subject: 'Una duda de la liquidación', message: 'Necesitamos saber cuándo llega el dinero a la cuenta.' };
      expect(entityMessageSchema.safeParse({ ...base, subject: 'hola' }).success).toBe(false);
      expect(entityMessageSchema.safeParse({ ...base, message: 'muy corto' }).success).toBe(false);
      expect(entityMessageSchema.safeParse({ ...base, target: 'ORGANIZATION' }).success).toBe(false);
      expect(entityMessageSchema.safeParse({ ...base, organizationId: 'otra' }).success).toBe(false);
      expect(entityMessageSchema.safeParse({ ...base, fromOrganization: false }).success).toBe(false);
    });
  });
});
