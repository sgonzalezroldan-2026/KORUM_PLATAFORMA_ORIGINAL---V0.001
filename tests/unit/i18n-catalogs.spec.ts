import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/types/korum.types';
import { LOCALES, routing } from '@/i18n/routing';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

type Catalog = { [key: string]: CatalogNode | undefined };
type CatalogNode = string | CatalogNode[] | Catalog;
const CATALOGS: Record<string, Catalog> = { es, ca, en };

/** Aplana un catálogo a `ruta.de.la.clave → texto`. */
function flatten(catalog: CatalogNode, prefix = ''): Record<string, string> {
  return Object.entries(catalog).reduce<Record<string, string>>((flat, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) return flat;
    return typeof value === 'string' ? { ...flat, [path]: value } : { ...flat, ...flatten(value, path) };
  }, {});
}

/** Nombres de variable ICU: `{nombre}` y `{nombre, plural, …}`; el texto de las ramas de un plural no cuenta. */
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1]).sort();

describe('QA-C05 · catálogos de traducción', () => {
  const flat = Object.fromEntries(Object.entries(CATALOGS).map(([locale, catalog]) => [locale, flatten(catalog)]));
  const spanishKeys = Object.keys(flat.es!).sort();

  it('los tres idiomas tienen exactamente las mismas claves', () => {
    expect(Object.keys(flat.ca!).sort()).toEqual(spanishKeys);
    expect(Object.keys(flat.en!).sort()).toEqual(spanishKeys);
  });

  it('ninguna traducción está vacía', () => {
    for (const [locale, entries] of Object.entries(flat)) {
      for (const [key, text] of Object.entries(entries)) {
        expect(text.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('las variables {nombre} coinciden en los tres idiomas', () => {
    for (const key of spanishKeys) {
      const expected = placeholders(flat.es![key]!);
      expect(placeholders(flat.ca![key]!), `ca:${key}`).toEqual(expected);
      expect(placeholders(flat.en![key]!), `en:${key}`).toEqual(expected);
    }
  });

  it('cada idioma traduce los 9 estados de iniciativa', () => {
    for (const locale of ['es', 'ca', 'en']) {
      const statuses = Object.keys(flat[locale]!).filter((key) => key.startsWith('status.initiative.'));
      expect(statuses, locale).toHaveLength(9);
    }
  });

  it('en catalán y en inglés no quedan textos copiados del castellano salvo nombres propios o palabras idénticas', () => {
    // «Avisos» se escribe igual en castellano y en catalán; los nombres de idioma y de marca no se traducen.
    // En la exportación de datos (Sprint 2.5): «Sí», «No», «Idea», «Iniciativa», «NIF», «Completada» y «Fallida» son iguales en catalán.
    const SAME_IN_CATALAN = new Set([
      // Buzón de ideas y logros (Sprint 3.6): «Compartir», «Foto» y «Publicar foto» se escriben igual en catalán.
      'portal.ideas.card.share', 'portal.ideas.card.shareAria', 'panel.achievements.fileLabel', 'panel.achievements.upload',
      // Comercios amigos (Sprint 4.2b): «Plata», «Factura rectificativa» y «Rectifica la factura» se escriben igual en catalán.
      'email.sponsor.level.PLATA', 'panel.sponsors.level.PLATA', 'portal.sponsorDocs.rectificativa.title', 'portal.sponsorDocs.rectificativa.rectifies',
      'ui.toast.region', 'privacy.export.yes', 'privacy.export.no', 'privacy.export.fields.idea', 'privacy.export.fields.initiative', 'privacy.export.fields.taxId', 'privacy.export.statuses.COMPLETED', 'privacy.export.statuses.FAILED', 'calculator.objective.scoreboard', 'nav.menu',
      // Acceso, alta y paneles (Sprint 3.2): «Entrar», «Verificar», «Continuar», «Forma jurídica», «AMPA / AFA», «Hola», «Consola», «Crítica».
      'auth.login.enter', 'auth.secondFactor.verify', 'registration.continue', 'registration.fields.legalForm', 'registration.legalForm.PARENTS_ASSOCIATION', 'panel.welcome', 'admin.headerTitle', 'admin.severity.CRITICAL', 'demo.console',
      // Portal público (Sprint 3.3): «Matching 2x» y «WhatsApp» son nombres propios; el resto son frases que en catalán se escriben igual.
      'portal.card.matching', 'portal.card.percent', 'portal.card.price', 'portal.card.raisedOf', 'portal.card.stage', 'portal.detail.breakdown.exact', 'portal.detail.goal', 'portal.detail.ticketsAvailable',
      'portal.detail.ticketsOf', 'portal.filter.stage', 'portal.filter.toggle', 'portal.meta.initiativeTitle', 'portal.share.emailSubject', 'portal.share.whatsapp',
      // Checkout (Sprint 3.4): «NIF o NIE», «Aportar a…», «Total», «Imprimir» y «Bizum» se escriben igual en catalán.
      'portal.checkout.fiscal.taxId', 'portal.checkout.metaTitle', 'portal.checkout.summary.total', 'portal.pass.print', 'portal.simulator.methods.BIZUM',
      // Patrocinio de comercios (Sprint 3.5): «Compartir», «Plata», «Factura de KORUM», «Total», «Iniciativa», «Número»… y el cupón de ejemplo se escriben igual en catalán.
      'portal.checkout.sponsor.fields.promoCodePlaceholder', 'portal.result.sponsor.factura', 'portal.result.sponsor.level.PLATA', 'portal.sponsorDocs.factura.number', 'portal.sponsorDocs.factura.title', 'portal.sponsorDocs.factura.total',
      'portal.sponsorDocs.factura.vat', 'portal.sponsorDocs.justificante.initiative', 'portal.sponsorDocs.justificante.taxId', 'portal.sponsorDocs.level.PLATA', 'portal.sponsors.share', 'portal.sponsors.shareCard',
      // Mi cuenta (Sprint 3.7): «Completada», «Idioma», «Permisos», «Iniciativa», «Confirmar», «Números: …» y los patrones sin texto se escriben igual en catalán.
      'account.contributions.line', 'account.contributions.status.COMPLETED', 'account.contributions.status.FAILED', 'account.documents.line', 'account.documents.sheet.initiative',
      'account.language.title', 'account.passes.numbers', 'account.passes.where', 'account.privacy.consents.title', 'account.privacy.requests.status.COMPLETED', 'account.reauth.confirm',
      'account.sections.language', 'privacy.export.requestStatuses.COMPLETED',
      // Mi Hucha (Sprint 3.8): «Activa», «En pausa», «Pausar», «Mes», «… al mes», «Aportar cada mes a…» y los patrones sin texto se escriben igual en catalán.
      'privacy.export.pledgeStatuses.ACTIVE', 'privacy.export.pledgeStatuses.PAUSED', 'email.pledge.month', 'email.pledge.monthValue', 'hucha.start.titleFor', 'hucha.form.perMonth',
      'hucha.pledge.monthly', 'hucha.pledge.status.ACTIVE', 'hucha.pledge.status.PAUSED', 'hucha.pledge.progressValue', 'hucha.pledge.pause', 'hucha.pledge.historyLine',
      // Mi cuenta y soporte (Sprint 3.9): «KORUM» es un nombre propio.
      'account.proposals.fromKorum', 'account.support.toKorum',
      // Aprobaciones (Sprint 4.2a): «Desestimar», «Verificada», «Enviar», «Convertida en iniciativa», «Desestimada» y «KORUM» se escriben igual en catalán.
      'panel.approvals.actions.reject', 'panel.approvals.audit.statusVerified', 'panel.approvals.chat.fromKorum', 'panel.approvals.chat.send', 'panel.approvals.phases.CONVERTED', 'panel.approvals.phases.REJECTED', 'panel.approvals.reject.confirm',
      // Panel de la entidad (Sprint 4.1): «Filtrar», «Taquilla o rifa», «fase actual», «Fases de…», «Medalla…», «Plata» y «{raised} de {goal}» se escriben igual en catalán.
      'panel.dashboard.card.formatTicketing', 'panel.dashboard.card.raised', 'panel.dashboard.filter.toggle', 'panel.dashboard.stepState.current', 'panel.dashboard.timeline.stepsLabel',
      'panel.medals.kit.title', 'panel.medals.level', 'panel.medals.names.silver',
      // Ajustes de la entidad (Sprint 4.2c): «Plata (€)», «Falta», «CIF del titular», «Forma jurídica: …» y «el CIF del titular» se escriben igual en catalán.
      'panel.settings.general.sponsors.tier.silver', 'panel.settings.kyb.documents.missing', 'panel.settings.kyb.identity.cif', 'panel.settings.kyb.identity.legalForm', 'panel.settings.kyb.submit.missingCif',
      // Equipo, grupos y marca (Sprint 4.2e): «Lila», «Turquesa», «Foto de portada», «Portada retirada.» y el patrón «{seat}: {name}» se escriben igual en catalán.
      'panel.settings.brand.accent.names.lilac', 'panel.settings.brand.accent.names.turquoise', 'panel.settings.brand.banner.label', 'panel.settings.brand.banner.removed', 'panel.settings.team.form.seatOther',
      // Renovación de comercios (Sprint 4.2d): «Plata», «Bizum» y «Total» se escriben igual en catalán.
      'portal.sponsorRenewal.levels.PLATA', 'portal.sponsorRenewal.methods.BIZUM', 'portal.sponsorRenewal.total',
      // «de {name}» (nombre accesible de la ficha) se escribe igual en catalán.
      'panel.sponsors.detail.summaryFor',
      // Fondo de actividades (Sprint 4.2f): «Retirada», «Enviada el…» y el patrón «{role}: {name}, el {date}» se escriben igual en catalán.
      'panel.fund.history.cancelReason.WITHDRAWN', 'panel.fund.history.executedOn', 'panel.fund.history.status.CANCELLED', 'panel.fund.receipt.executedAt', 'panel.fund.receipt.signatureLine',
      // Invitación a renovar (Sprint 4.2f): «caduca» se escribe igual en catalán.
      'email.sponsor.renewalInvite.verbFuture']);
    const SAME_IN_ENGLISH = new Set(['privacy.export.no', 'privacy.export.fields.idea', 'registration.fields.email',
      // Equipo y marca (Sprint 4.2e): un patrón sin texto traducible y «Coral», igual en inglés.
      'panel.settings.team.form.seatOther', 'panel.settings.brand.accent.names.coral',
      // Portal público (Sprint 3.3): nombres propios y patrones sin texto traducible.
      'portal.card.matching', 'portal.detail.ticketsOf', 'portal.meta.initiativeTitle', 'portal.share.email', 'portal.share.emailSubject', 'portal.share.whatsapp',
      // Checkout (Sprint 3.4): «Total» y «Bizum» son iguales en inglés.
      'portal.checkout.summary.total', 'portal.simulator.methods.BIZUM',
      // Patrocinio de comercios (Sprint 3.5): el cupón de ejemplo es un código.
      'portal.checkout.sponsor.fields.promoCodePlaceholder',
      // Mi cuenta (Sprint 3.7): patrones sin texto traducible.
      'account.contributions.line', 'account.documents.line', 'account.passes.where',
      // Mi cuenta y soporte (Sprint 3.9): «KORUM» es un nombre propio.
      'account.proposals.fromKorum', 'account.support.toKorum',
      // Aprobaciones (Sprint 4.2a): «KORUM» es un nombre propio.
      'panel.approvals.chat.fromKorum',
      // Renovación de comercios (Sprint 4.2d): «Bizum» y «Total» son iguales en inglés.
      'portal.sponsorRenewal.methods.BIZUM', 'portal.sponsorRenewal.total']);
    const sameByNature = (locale: string, key: string) =>
      key.startsWith('languageSwitcher.') || key === 'brand.name' || (locale === 'ca' ? SAME_IN_CATALAN : SAME_IN_ENGLISH).has(key);
    const sameAsSpanish = (locale: string) => spanishKeys.filter((key) => flat[locale]![key] === flat.es![key] && !sameByNature(locale, key));
    expect(sameAsSpanish('ca')).toEqual([]);
    expect(sameAsSpanish('en')).toEqual([]);
  });

  /** La única mención admitida de «Banco de España» es la redacción aprobada de Paycomet (Regla 03 §4); referida a KORUM sigue prohibida. */
  const APPROVED_PAYCOMET_PHRASE = /autorizada por el Banco de España/g;

  it('no hay vocabulario prohibido en los textos públicos (propina, banco, escrow)', () => {
    for (const [locale, entries] of Object.entries(flat)) {
      for (const [key, text] of Object.entries(entries)) {
        expect(text.replace(APPROVED_PAYCOMET_PHRASE, ''), `${locale}:${key}`).not.toMatch(/\bpropinas?\b|\bbanco\b|\bescrow\b|\btip\b/i);
      }
    }
  });
});

describe('idiomas del enrutado', () => {
  it('el enrutado y los contratos de tipos usan los mismos idiomas y el mismo idioma por defecto', () => {
    expect([...LOCALES]).toEqual([...SUPPORTED_LOCALES]);
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(routing.localePrefix).toBe('as-needed');
  });
});
