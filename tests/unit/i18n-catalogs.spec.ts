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

  it('catalán e inglés usan siempre el apóstrofo tipográfico (’), nunca el recto (Sprint 5.5)', () => {
    // Antes convivían «d'una» y «d’una», y «families'». El recto, además, es el carácter de escape de ICU: ningún texto lo usa así.
    for (const locale of ['ca', 'en']) {
      for (const [key, text] of Object.entries(flat[locale]!)) {
        expect(text, `${locale}:${key}`).not.toContain("'");
      }
    }
  });

  it('en inglés el porcentaje va pegado a la cifra: 100%, nunca 100 % (Sprint 5.5)', () => {
    // En castellano y catalán conviven las dos formas porque los textos oficiales de la Regla 03 §3 escriben «100%» y no se tocan sin aprobación.
    for (const [key, text] of Object.entries(flat.en!)) expect(text, `en:${key}`).not.toMatch(/(\d|\}) %/);
  });

  it('en castellano y catalán, entre la cifra y «%» va un espacio duro: «100 %» no se parte en dos líneas (Sprint 5.5)', () => {
    for (const locale of ['es', 'ca']) {
      for (const [key, text] of Object.entries(flat[locale]!)) expect(text, `${locale}:${key}`).not.toMatch(/(d|}) %/);
    }
  });

  it('sin espacios dobles dentro de un texto (Sprint 5.5)', () => {
    // Un espacio al principio o al final sí puede ser a propósito: hay fragmentos que se añaden tras otro texto (« (se abre en una pestaña nueva)»).
    for (const [locale, entries] of Object.entries(flat)) {
      for (const [key, text] of Object.entries(entries)) expect(text, `${locale}:${key}`).not.toMatch(/\S {2,}\S/);
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
      // Equipo que firma (Sprint 5.2): «Cofirma» se escribe igual en catalán (el término que usa la propia sección).
      'admin.org360.seats.role.COSIGNER', 'email.signer.handover.seat.COSIGNER', 'panel.approvals.doubleCheck.roles.COSIGNER', 'panel.settings.team.seat.COSIGNER', 'panel.signers.role.COSIGNER',
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
      'email.sponsor.renewalInvite.verbFuture',
      // Liquidaciones (Sprint 4.4a): «Liquidar», «Factura adjunta», «Enviada» y «Enviada el…» se escriben igual en catalán.
      'panel.dashboard.card.settle', 'panel.payouts.form.invoiceReady', 'panel.payouts.history.executed', 'panel.payouts.history.status.EXECUTED',
      // Estudio de edición (Sprint 4.3): «Infantil», «ESO», «Plata», «Sí, publicar», «Taquilla o rifa», «Meta pública final exacta» y los patrones sin texto traducible se escriben igual en catalán.
      'panel.studio.board.atZero', 'panel.studio.board.goalLabel', 'panel.studio.board.medal.2', 'panel.studio.confirm.yes', 'panel.studio.format.TICKETING', 'panel.studio.poster.withKorum', 'panel.studio.stages.eso', 'panel.studio.stages.infantil', 'panel.studio.discard.yes',
      // Portería móvil (Sprint 4.5): «Pantalla completa», «Entra» y «Rifa» se escriben igual en catalán; los dos patrones no tienen texto traducible.
      'gate.raffle.fullscreen', 'gate.raffle.roundButton', 'gate.scanner.result.accepted', 'panel.gate.kind.raffle', 'panel.gate.pin.digits',
      // Ronda extra del sorteo (Sprint 4.6): «ronda» se escribe igual en catalán.
      'panel.gate.raffle.extraTitle', 'panel.gate.raffle.prepare', 'panel.gate.raffle.round', 'panel.gate.raffle.roundExtra',
      // BI de la consola (Sprint 5.1): «Meta», «Iniciativa», «Medalla» y «Plata» se escriben igual en catalán; los porcentajes y los patrones no tienen texto traducible.
      'admin.metaTitle', 'admin.kpi.potentialGoal', 'admin.kpi.percent', 'admin.orgs.col.medal', 'admin.orgs.col.goal', 'admin.orgs.medal.2', 'admin.orgs.sponsorsValue', 'admin.orgs.noValue', 'admin.initiatives.percent', 'admin.initiatives.col.title', 'admin.initiatives.col.goal',
      // Consola (Sprint 5.2): «Medalla», «Plata», «CIF», «Forma jurídica», «Titular legal», «Número», «Rectificativa», «Total», «Falta» y las unidades se escriben igual en catalán.
      'admin.entities.col.medal', 'admin.entities.medal.2', 'admin.entities.noValue', 'admin.org360.holder.cif', 'admin.org360.holder.legalForm', 'admin.org360.holder.ley49No', 'admin.org360.holder.ley49Verified', 'admin.org360.holder.title', 'admin.org360.invoices.number', 'admin.org360.invoices.rectification', 'admin.org360.invoices.total', 'admin.org360.kyb.cif', 'admin.org360.kyb.missing', 'admin.org360.legalForm.PARENTS_ASSOCIATION', 'admin.org360.medal.2', 'admin.org360.nav.titular', 'admin.org360.tariffs.unitEur', 'admin.org360.tariffs.unitPct', 'admin.popup.percent', 'admin.popup.previousItem',
      // Motor de reglas y soporte de la consola (Sprint 5.3): «Ajustar», «Meta», «No consta», «Sobre una iniciativa», las unidades y el patrón «De {origen} · {fecha}» se escriben igual en catalán.
      'admin.pricingHealth.adjust', 'admin.rules.exempt.columns.goal', 'admin.rules.unit.eur', 'admin.rules.unit.pct', 'admin.splits.unknown', 'admin.splits.save', 'admin.support.from', 'admin.support.topic.INITIATIVE',
      // Ajustes de la plataforma (Sprint 5.4): «Mi Hucha», «Brevo», «Terminal», «JET ID», «NIF o CIF», «Historial», «Sistema», «Cada», «Desactivada», «simulador», «IP pública del servidor», «Revisa: …», «Caduca el …», «valor: …» y los patrones sin texto traducible se escriben igual en catalán.
      'admin.settings.nav.hucha', 'admin.settings.nav.historial', 'admin.settings.sections.hucha.title', 'admin.settings.rejectedFields', 'admin.settings.fields.paycomet_terminalId.label', 'admin.settings.fields.paycomet_jetId.label', 'admin.settings.fields.paycomet_serverIp.label', 'admin.settings.fields.email_provider.options.brevo', 'admin.settings.fields.hucha_mode.options.DISABLED', 'admin.settings.payments.modes.mock', 'admin.settings.limits.colWindow', 'admin.settings.company.fields.taxId', 'admin.settings.legal.openAria', 'admin.settings.team.expires', 'admin.settings.security.pendingRow', 'admin.settings.history.system', 'admin.settings.history.detail.value', 'admin.settings.history.detail.status.SIMULATED', 'admin.settings.history.targets.legal']);
    const SAME_IN_ENGLISH = new Set(['privacy.export.no',
      // Consola (Sprint 5.2): el guion, «Total» y las unidades son iguales en inglés.
      'admin.entities.noValue', 'admin.org360.invoices.total', 'admin.org360.tariffs.unitEur', 'admin.org360.tariffs.unitPct', 'privacy.export.fields.idea', 'registration.fields.email',
      // BI de la consola (Sprint 5.1): el guion de «sin valor» es igual en inglés.
      'admin.orgs.noValue',
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
      'portal.sponsorRenewal.methods.BIZUM', 'portal.sponsorRenewal.total',
      // Estudio de edición (Sprint 4.3): el patrón «{entity} × KORUM» no tiene texto traducible.
      'panel.studio.poster.withKorum',
      // Portería móvil (Sprint 4.5): patrones sin texto traducible.
      'gate.raffle.roundButton', 'panel.gate.pin.digits',
      // Motor de reglas (Sprint 5.3): las unidades son iguales en inglés.
      'admin.rules.unit.eur', 'admin.rules.unit.pct',
      // Ajustes de la plataforma (Sprint 5.4): «Mi Hucha» y «Brevo» son nombres propios, «Terminal», «JET ID», «NIF o CIF» y «Sistema» se escriben igual en inglés (o son siglas) y {table}: {count} es un patrón.
      'admin.settings.nav.email', 'admin.settings.history.targets.documents.cookies', 'admin.settings.nav.hucha', 'admin.settings.sections.hucha.title', 'admin.settings.fields.paycomet_terminalId.label', 'admin.settings.fields.paycomet_jetId.label', 'admin.settings.fields.email_provider.options.brevo', 'admin.settings.security.pendingRow', 'admin.settings.history.targets.legal']);
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
