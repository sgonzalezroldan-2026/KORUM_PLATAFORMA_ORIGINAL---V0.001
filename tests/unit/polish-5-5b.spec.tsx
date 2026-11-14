import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Field, FormAlert, QuietFieldErrors, SubmitButton } from '@/components/auth/auth-ui';
import { backupCodesText, BackupCodesActions } from '@/components/auth/backup-codes-actions';
import { planExpiredReminder } from '@/core/resize/expired-reminder';
import { RESIZE_MIN_WINDOW_DAYS } from '@/core/resize/resize-limits';
import { CAMPAIGN_TEMPLATES, REWARD_PRESET_SECTION, TEMPLATE_TEXT_KEYS, templatesFor, templateTextKey } from '@/core/studio/campaign-templates';
import { REWARD_PRESETS } from '@/core/studio/studio-draft';
import { evaluateSemanticLock } from '@/core/security/semantic-lock';
import { GATE_PIN_SET_RULE, RESIZE_LINK_EMAIL_RULE, RESIZE_LINK_IP_RULE } from '@/lib/rate-limit-rules';
import { RATE_LIMIT_PURGE_RULES } from '@/core/jobs/handlers/housekeeping';
import { indexNowUrls, isPublicHost } from '@/services/seo/indexnow.service';
import { SECRET_DEFINITIONS } from '@/services/settings/setting-definitions';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import { renderWithIntl } from '../utils/render-with-intl';

/**
 * Sprint 5.5b: accesibilidad de los formularios de acceso, códigos de respaldo, tope de PIN de portería, IndexNow, recordatorio de campañas vencidas, reenvío
 * del enlace de voto y textos de las plantillas por vertical.
 */

const NOW = new Date('2026-11-14T10:00:00Z');
const DAY = 86_400_000;

describe('formularios de acceso (QA-X02, heredado del 3.2)', () => {
  it('el botón de envío dice «Enviando…» y marca aria-busy mientras espera, y queda deshabilitado', () => {
    const { unmount } = renderWithIntl(<SubmitButton busy={false}>Entrar</SubmitButton>);
    expect(screen.getByRole('button', { name: 'Entrar' })).not.toHaveAttribute('aria-busy');
    unmount();
    renderWithIntl(<SubmitButton busy>Entrar</SubmitButton>);
    const busy = screen.getByRole('button', { name: 'Enviando…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('type', 'submit');
  });

  it('con un resumen de errores, cada campo lleva su error vinculado sin anunciarlo por separado', () => {
    renderWithIntl(
      <QuietFieldErrors>
        <Field label="Nombre" error="Falta el nombre" />
      </QuietFieldErrors>
    );
    const input = screen.getByLabelText('Nombre');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Falta el nombre');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fuera del resumen, el error de un campo se sigue anunciando', () => {
    renderWithIntl(<Field label="Email" error="Email no válido" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Email no válido');
  });

  it('el resumen del alta no roba el foco cuando el formulario lo lleva al primer campo con error', () => {
    renderWithIntl(<FormAlert focusOnShow={false}>Revisa 2 campos</FormAlert>);
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveFocus();
    expect(alert).not.toHaveAttribute('tabindex');
  });
});

describe('códigos de respaldo: copiar, imprimir o descargar', () => {
  const codes = ['abcd-1234', 'efgh-5678'];

  beforeEach(() => {
    document.documentElement.classList.remove('korum-print-backup');
  });

  it('el texto lleva una cabecera y un código por línea', () => {
    expect(backupCodesText('Título', 'Intro', codes)).toBe('Título\nIntro\n\nabcd-1234\nefgh-5678\n');
  });

  it('copiar los pone en el portapapeles y lo anuncia', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithIntl(<BackupCodesActions codes={codes} />);
    await userEvent.click(screen.getByRole('button', { name: /Copiar los códigos/ }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('abcd-1234\nefgh-5678'));
    expect(screen.getByRole('status')).toHaveTextContent('Códigos copiados');
  });

  it('imprimir marca la página para que solo salga la hoja de códigos, y la desmarca al terminar', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderWithIntl(<BackupCodesActions codes={codes} />);
    fireEvent.click(screen.getByRole('button', { name: /Imprimirlos/ }));
    expect(print).toHaveBeenCalled();
    expect(document.documentElement.classList.contains('korum-print-backup')).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(document.documentElement.classList.contains('korum-print-backup')).toBe(false);
  });

  it('descargar crea un .txt en el navegador (no viaja a ningún servidor)', () => {
    const create = vi.fn(() => 'blob:korum');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderWithIntl(<BackupCodesActions codes={codes} />);
    fireEvent.click(screen.getByRole('button', { name: /Descargarlos/ }));
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:korum');
    expect(screen.getByRole('status')).toHaveTextContent('Fichero descargado');
  });
});

describe('tope de PIN de portería y del reenvío del enlace de voto', () => {
  it('se purgan con el resto de límites y no se pueden saltar con cifras absurdas', () => {
    for (const rule of [GATE_PIN_SET_RULE, RESIZE_LINK_IP_RULE, RESIZE_LINK_EMAIL_RULE]) expect(RATE_LIMIT_PURGE_RULES).toContain(rule);
    expect(GATE_PIN_SET_RULE.limit).toBe(10);
    expect(RESIZE_LINK_EMAIL_RULE.limit).toBe(3);
    expect(RESIZE_LINK_EMAIL_RULE.windowMs).toBe(24 * 3_600_000);
  });
});

describe('IndexNow (QA-SEO02)', () => {
  it('solo avisa desde una web pública con HTTPS', () => {
    expect(isPublicHost('https://korum.es')).toBe(true);
    expect(isPublicHost('https://www.korum.es/')).toBe(true);
    for (const url of ['http://korum.es', 'https://localhost:3000', 'http://localhost:3100', 'https://127.0.0.1', 'https://korum.local', 'https://demo.test', 'no-es-una-url', 'https://intranet']) expect(isPublicHost(url), url).toBe(false);
  });

  it('avisa de la ficha y de la portada de la entidad en los tres idiomas', () => {
    const urls = indexNowUrls('https://korum.es/', 'colegio-sol', 42);
    expect(urls).toContain('https://korum.es/colegio-sol/iniciativas/42');
    expect(urls).toContain('https://korum.es/ca/colegio-sol');
    expect(urls).toHaveLength(6);
    expect(urls.some((url) => url.endsWith('/colegio-sol/iniciativas/42') && !url.includes('/ca/') && !url.includes('/en/'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/ca/colegio-sol'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/en/colegio-sol/iniciativas/42'))).toBe(true);
  });

  it('la clave de la consola debe tener el formato del protocolo (se publica tal cual en /indexnow-key.txt)', () => {
    const pattern = SECRET_DEFINITIONS['seo.indexNowKey'].pattern;
    expect(pattern.test('a1b2c3d4e5f6')).toBe(true);
    expect(pattern.test('clave-con-guiones-123')).toBe(true);
    for (const bad of ['corta', 'con espacio 1234', 'con/barra/123', '<script>1234', 'x'.repeat(129)]) expect(pattern.test(bad), bad).toBe(false);
  });
});

describe('recordatorio escalado de una campaña vencida sin decidir (heredado del 4.4b)', () => {
  const base = { voteEligible: true, expiredAt: new Date(NOW.getTime() - 3 * DAY), now: NOW };

  it('el día del vencimiento no recuerda nada: ya salió el aviso de vencimiento', () => {
    expect(planExpiredReminder({ ...base, windowDaysLeft: 5, expiredAt: new Date(NOW.getTime() - 3_600_000) }).stage).toBeNull();
  });

  it('avisa de los últimos días para lanzar la votación mientras se puede', () => {
    const plan = planExpiredReminder({ ...base, windowDaysLeft: RESIZE_MIN_WINDOW_DAYS + 2 });
    expect(plan).toMatchObject({ stage: 'VOTE_CLOSING', canVote: true, voteDaysLeft: 2, alert: 'NONE' });
    expect(planExpiredReminder({ ...base, windowDaysLeft: RESIZE_MIN_WINDOW_DAYS + 10 }).stage).toBeNull();
  });

  it('sin votación posible, recuerda por etapas cada vez más urgentes y alerta al Super-Admin a 14 días (crítica a 7)', () => {
    const noVote = { ...base, voteEligible: false };
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 20 })).toMatchObject({ stage: null, alert: 'NONE', canVote: false });
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 14 })).toMatchObject({ stage: 'DAYS_14', alert: 'WARNING' });
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 9 })).toMatchObject({ stage: 'DAYS_14', alert: 'WARNING' });
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 7 })).toMatchObject({ stage: 'DAYS_7', alert: 'CRITICAL' });
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 2 })).toMatchObject({ stage: 'DAYS_3', alert: 'CRITICAL' });
    expect(planExpiredReminder({ ...noVote, windowDaysLeft: 0 })).toMatchObject({ stage: 'DAYS_1', alert: 'CRITICAL' });
  });

  it('con menos ventana de la que necesita una votación, ya no ofrece votar aunque la campaña pudiera', () => {
    expect(planExpiredReminder({ ...base, windowDaysLeft: RESIZE_MIN_WINDOW_DAYS - 1 })).toMatchObject({ canVote: false, voteDaysLeft: null });
  });

  it('sin rastro de cuándo venció (datos antiguos) recuerda igualmente', () => {
    expect(planExpiredReminder({ ...base, voteEligible: false, windowDaysLeft: 10, expiredAt: null }).stage).toBe('DAYS_14');
  });
});

describe('plantillas y premios del reto por vertical (heredado del 4.3)', () => {
  const catalogs = { es, ca, en } as const;
  type Texts = Record<string, Record<string, string> | undefined>;

  it('cada vertical tiene su catálogo, con «Instrumentos» en las culturales y el marcador en los clubes (EXPERIENCIA §11)', () => {
    expect(templatesFor('CULTURAL').map((template) => template.key)).toContain('instruments');
    expect(templatesFor('SPORTS_CLUB').map((template) => template.key)).toContain('scoreboard');
    expect(templatesFor('SCHOOL').map((template) => template.key)).not.toContain('instruments');
    for (const vertical of ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'] as const) expect(templatesFor(vertical).map((template) => template.key)).toContain('solidarity');
  });

  it('un club y una entidad cultural no reciben textos de colegio («fin de curso»)', () => {
    for (const vertical of ['SPORTS_CLUB', 'CULTURAL'] as const) {
      for (const template of templatesFor(vertical)) {
        const texts = (es.panel.studio.templates as Texts)[templateTextKey(template, vertical)]!;
        expect(`${texts.name} ${texts.title} ${texts.description}`, `${vertical}:${template.key}`).not.toMatch(/fin de curso|alumn|aulas|niños y niñas/i);
      }
    }
  });

  it('todas las claves de texto (también las variantes) existen en los tres idiomas y las exentas pasan el candado semántico', () => {
    const exempt = new Set(['Comunidad y Viajes', 'Solidaridad y Becas']);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of TEMPLATE_TEXT_KEYS) {
        const texts = (catalog.panel.studio.templates as Texts)[key];
        for (const field of ['name', 'summary', 'title', 'description']) expect(texts?.[field]?.trim(), `${locale}:${key}.${field}`).toBeTruthy();
      }
      for (const template of CAMPAIGN_TEMPLATES) {
        if (template.category === null || !exempt.has(template.category)) continue;
        for (const vertical of template.verticals) {
          const texts = (catalog.panel.studio.templates as Texts)[templateTextKey(template, vertical)]!;
          expect(evaluateSemanticLock(`${texts.title} ${texts.description}`).isBlocked, `${locale}:${vertical}:${template.key}`).toBe(false);
        }
      }
    }
  });

  it('los premios del reto tienen texto propio en cada vertical y en los tres idiomas', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const section of Object.values(REWARD_PRESET_SECTION)) {
        const presets = (catalog.panel.studio as unknown as Record<string, Record<string, string> | undefined>)[section];
        for (const key of REWARD_PRESETS) expect(presets?.[key]?.trim(), `${locale}:${section}.${key}`).toBeTruthy();
      }
    }
    expect(es.panel.studio.rewardPresetsClub.cinema).not.toBe(es.panel.studio.rewardPresets.cinema);
  });
});
