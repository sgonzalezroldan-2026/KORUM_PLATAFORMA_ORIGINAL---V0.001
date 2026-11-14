import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { withE2eDb } from './auth-support';
import { trackConsoleErrors } from './helpers';
import { audited, consolePayload, entityArguments, fingerprint, invoke, invokeAnonymous, leaksIn, loadActions, MANIFEST, missingTargets, outboxOf, pageUrl, prepareVictim, reasonOf, resourceArguments, statusOf, type AuditRow } from './intrusion-support';
import { pdfFile, photoFile } from './journey-support';
import { registerEntityAndEnterPanel, type RegisteredEntity } from './panel-support';

/**
 * Sprint 5.6 · QA-SEC10 · Prueba de intrusión entre entidades (QA-SEC01 por HTTP y con sesión real). Quien dirige la entidad A, con su contraseña y su segundo factor,
 * ataca a la entidad B como lo haría alguien con las herramientas del navegador:
 *
 *  1. **Censo de acciones:** invoca TODAS las acciones de servidor del panel (las lee del manifiesto de la compilación, así que una acción nueva entra sola
 *     en la prueba, y sin argumentos preparados la prueba falla) cambiando su propia entidad por la de B. Cada una responde `FORBIDDEN` y deja su fila
 *     `tenant.access_denied` con la entidad de B.
 *  2. **Identificadores ajenos:** con su propia entidad en la dirección, llama a todas las acciones que reciben un identificador con los de B (campañas,
 *     ideas, firmas, comercios, liquidaciones, relevos, sesiones de portería, sorteos, consultas). La respuesta es exactamente la misma que para un
 *     identificador que no existe, y el intento queda registrado.
 *  3. **Páginas y ficheros:** abre las páginas del panel de B, sus documentos, sus facturas, su Modelo 182 y sus subidas, con la entidad de B y con la
 *     propia. Todo responde 403 o 404, igual que para algo que no existe.
 *  4. **La consola:** invoca todas las acciones del Super-Admin. Todas se niegan por no serlo, y consta.
 *  5. **Sin sesión:** las páginas y las acciones del panel y de la consola mandan a entrar sin ejecutarse; los ficheros y las subidas responden 403; la
 *     página de firma (fuera de la guardia a propósito: su enlace viaja en el fragmento) no enseña nada de lo que se firma y la portería pide su PIN.
 *
 * Ninguna respuesta trae un solo dato de B, y al final B no ha cambiado ni en una coma: ni sus tablas, ni lo que apunta a sus recursos, ni las cuentas de sus
 * firmantes, ni hay emails nuevos a su nombre. El censo necesita la compilación de producción (el manifiesto de acciones); con el servidor de desarrollo se omite.
 */

test.describe.configure({ timeout: 480_000 });

const PRODUCTION_BUILD = Boolean(process.env.CI) || process.env.E2E_ACTION_CENSUS === '1';
const PANEL_FILES = ['/panel/[orgSlug]/(gestion)/', '/panel/[orgSlug]/firmar/'];
/** Las dos acciones de la firma no reciben entidad que valga: dependen de un enlace de un solo uso, y sin él responden «enlace no válido». */
const SIGNING_ACTIONS = ['completeSignatureAction', 'previewSignatureAction'];

const denials = (audit: AuditRow[], organizationId: string | null) => audit.filter((row) => row.action === 'tenant.access_denied' && row.organizationId === organizationId);

test.describe('Sprint 5.6 · intrusión entre entidades', () => {
  test('quien dirige la entidad A no lee ni cambia nada de la entidad B: acciones, identificadores, páginas, ficheros y consola', async ({ page, browser, isMobile }) => {
    const errors = trackConsoleErrors(page);
    // La entidad B (víctima) se da de alta en su propio navegador; la entidad A (atacante) queda con la sesión abierta y el segundo factor superado.
    const victimContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const victimEntity: RegisteredEntity = await registerEntityAndEnterPanel(await victimContext.newPage(), isMobile);
    await victimContext.close();
    const attacker = await registerEntityAndEnterPanel(page, isMobile);
    const attackerId = await withE2eDb((db) => db.query(`SELECT id FROM "Organization" WHERE slug = $1`, [attacker.slug])).then((result) => String(result.rows[0].id));
    const victim = await prepareVictim(victimEntity);
    const victimAddresses = [victimEntity.director, victimEntity.cosigner, 'comercio-b@comercios.example', 'familia-b@familias.example'];
    const before = await fingerprint(victim.organizationId);
    const outboxBefore = await outboxOf(victim.organizationId, victimAddresses);
    const params = { orgSlug: attacker.slug, id: String(victim.campaignId), gateCode: 'abcdefghij' };
    const origin = new URL(page.url()).origin;
    const call = <T>(run: () => Promise<T>) => audited(attacker.director, run);

    if (PRODUCTION_BUILD) {
      expect(existsSync(MANIFEST), 'manifiesto de acciones de la compilación').toBe(true);
      const panelActions = loadActions().filter((action) => PANEL_FILES.some((folder) => action.file.includes(folder)));
      const byName = new Map(panelActions.map((action) => [action.name, action]));
      const forVictim = { ...entityArguments(victimEntity.slug), ...resourceArguments(victimEntity.slug, victim) };
      const urlOf = (name: string) => {
        const pages = byName.get(name)!.pages;
        return pageUrl(pages.find((candidate) => !candidate.includes('[id]')) ?? pages[0]!, params);
      };

      // ───────────── 1. Censo: todas las acciones del panel, con la entidad B en los argumentos ─────────────
      await test.step('censo de acciones del panel con la entidad de otra persona', async () => {
        // Cada acción del manifiesto tiene sus argumentos preparados, y no sobra ninguno: una acción nueva (o una que desaparece) obliga a revisar la prueba.
        expect(panelActions.map((action) => action.name).sort()).toEqual(Object.keys(forVictim).sort());
        expect(panelActions.length).toBeGreaterThanOrEqual(45);
        // Control: la misma llamada con la entidad propia sí llega a la acción y funciona. Lo que sigue se niega por la entidad, no por cómo se llama.
        const own = await invoke(page, urlOf('resendInvitationAction'), byName.get('resendInvitationAction')!.id, [attacker.slug]);
        expect(['SENT', 'NOT_NEEDED']).toContain(statusOf(own.result));

        for (const action of panelActions) {
          const { outcome, audit } = await call(() => invoke(page, urlOf(action.name), action.id, forVictim[action.name]!));
          const label = `${action.name} con la entidad B (devolvió ${JSON.stringify(outcome.result)})`;
          expect.soft(outcome.http, label).toBe(200);
          expect.soft(leaksIn(outcome.body, victim), `${label}: datos de B en la respuesta`).toEqual([]);
          if (SIGNING_ACTIONS.includes(action.name)) {
            expect.soft(reasonOf(outcome.result), label).toBe('INVALID_LINK');
            continue;
          }
          // Se niega por lo que es (otra entidad), no por un dato mal formado, y cada intento deja su fila con la entidad atacada y lo que se intentó.
          expect.soft(reasonOf(outcome.result), label).toBe('FORBIDDEN');
          const denied = denials(audit, victim.organizationId);
          expect.soft(denied.length, `${label}: filas tenant.access_denied con la entidad B`).toBeGreaterThanOrEqual(1);
          expect.soft(denied.every((row) => row.metadata.reason === 'NOT_A_MEMBER' && typeof row.metadata.attempted === 'string'), `${label}: motivo registrado ${JSON.stringify(denied.map((row) => row.metadata.reason))}`).toBe(true);
        }
      });

      // ───────────── 2. Identificadores de B con la entidad propia en la dirección ─────────────
      await test.step('recursos de otra entidad pedidos por su identificador desde la entidad propia', async () => {
        const foreign = resourceArguments(attacker.slug, victim);
        const missing = resourceArguments(attacker.slug, missingTargets());
        // Todas las acciones del panel que no son «solo la entidad» reciben un identificador: están todas aquí.
        expect(Object.keys(foreign).sort()).toEqual(panelActions.map((action) => action.name).filter((name) => !(name in entityArguments(''))).sort());
        for (const name of Object.keys(foreign)) {
          const action = byName.get(name)!;
          const theirs = await call(() => invoke(page, urlOf(name), action.id, foreign[name]!));
          const nothing = await call(() => invoke(page, urlOf(name), action.id, missing[name]!));
          const label = `${name} con un identificador de B (devolvió ${JSON.stringify(theirs.outcome.result)}; con uno inexistente, ${JSON.stringify(nothing.outcome.result)})`;
          // La respuesta a lo de otra entidad es la misma que a lo que no existe: ni el estado ni el motivo dejan adivinar que existe.
          expect.soft(theirs.outcome.result, label).toEqual(nothing.outcome.result);
          expect.soft(theirs.outcome.http, label).toBe(nothing.outcome.http);
          expect.soft(statusOf(theirs.outcome.result), label).toBe('ERROR');
          expect.soft(['NOT_FOUND', 'FORBIDDEN'], label).toContain(reasonOf(theirs.outcome.result));
          expect.soft(leaksIn(theirs.outcome.body, victim), `${label}: datos de B en la respuesta`).toEqual([]);
          // Cada intento deja UNA fila a nombre de quien ataca y en su propia entidad (en la de B no se escribe nada): «recurso de otra entidad», con la
          // dueña real guardada solo para la investigación, y «recurso inexistente» para el identificador inventado. Las consultas de soporte se piden por
          // su código público, no por un número: su servicio anota los dos casos igual, como «no es una consulta de esta entidad».
          const rows = (audit: AuditRow[]) => audit.map((row) => [row.action, row.organizationId, row.metadata.ownerOrganizationId ?? row.metadata.reason ?? null]);
          const byCode = name === 'answerTicketAction';
          expect.soft(rows(theirs.audit), `${label}: rastro del intento`).toEqual([byCode ? ['tenant.access_denied', attackerId, 'NOT_AN_ORGANIZATION_TICKET'] : ['tenant.resource_outside_tenant', attackerId, victim.organizationId]]);
          expect.soft(rows(nothing.audit), `${label}: rastro del identificador inexistente`).toEqual([byCode ? ['tenant.access_denied', attackerId, 'NOT_AN_ORGANIZATION_TICKET'] : ['tenant.resource_not_found', attackerId, null]]);
        }
      });

      // La portería no se abre con una cuenta de firmante: solo con el PIN de ese evento. Las acciones del lector y del sorteo, con el evento de B.
      await test.step('portería de un evento de otra entidad sin su PIN', async () => {
        // Todas las acciones de la portería que reciben el evento (las que la compilación expone: las que usa alguna pantalla); entrar y salir van aparte, con el PIN.
        const gate = loadActions().filter((action) => action.file.includes('/panel/[orgSlug]/porteria/') && !/^(enterGate|leaveGate)Action$/.test(action.name));
        expect(gate.map((action) => action.name).sort()).toEqual(['drawRaffleAction', 'gateSummaryAction', 'loadGateListAction', 'loadRaffleActAction', 'scanPassAction', 'syncScansAction']);
        const inputs: Record<string, unknown[]> = {
          scanPassAction: [victim.eventId, { payload: 'KORUM1.00000000-0000-4000-8000-000000000000.AAAA', people: 1 }],
          syncScansAction: [victim.eventId, { scans: [] }],
          drawRaffleAction: [victim.raffleId, { winnersCount: 1, idempotencyKey: randomUUID() }],
          loadRaffleActAction: [victim.raffleId, 1]
        };
        for (const action of gate) {
          const outcome = await invoke(page, pageUrl(action.pages[0]!, params), action.id, inputs[action.name] ?? [victim.eventId]);
          expect.soft(outcome.result, action.name).toEqual({ status: 'ERROR', reason: 'NO_SESSION' });
          expect.soft(leaksIn(outcome.body, victim), `${action.name}: datos de B en la respuesta`).toEqual([]);
        }
      });
    }

    // ───────────── 3. Páginas, documentos y subidas de B ─────────────
    await test.step('páginas del panel, documentos, facturas, Modelo 182 y subidas de otra entidad', async () => {
      const clean = (body: string, what: string) => expect.soft(leaksIn(body, victim), `${what}: datos de B en la respuesta`).toEqual([]);
      for (const section of ['', '/aprobaciones', '/estudio', `/estudio?iniciativa=${victim.draftId}`, `/estudio/${victim.campaignId}/cartel`, '/liquidaciones', '/logros', '/taquilla', '/vencidas', '/fondo', '/soporte', '/ajustes']) {
        const response = await page.request.get(`/panel/${victimEntity.slug}${section}`);
        expect.soft(response.status(), `/panel/{B}${section}`).toBe(403);
        clean(await response.text(), `/panel/{B}${section}`);
      }
      // Con la entidad propia en la dirección, lo de B no existe.
      for (const route of [`/panel/${attacker.slug}/estudio?iniciativa=${victim.draftId}`, `/panel/${attacker.slug}/estudio/${victim.campaignId}/cartel`]) {
        const response = await page.request.get(route);
        // El panel pinta primero su esqueleto de carga (la respuesta ya ha salido con 200) y después la página de «no encontrado»: lo que importa es que es
        // la misma que para un identificador inventado y que no trae nada de B.
        expect.soft([200, 404], route).toContain(response.status());
        const html = await response.text();
        clean(html, route);
        expect.soft(html, route).toContain('NEXT_HTTP_ERROR_FALLBACK;404');
      }
      // La consola es solo del Super-Admin.
      for (const route of ['/admin', '/admin/entidades', `/admin/entidades/${victim.organizationId}`, '/admin/reglas', '/admin/soporte', '/admin/ajustes']) {
        const response = await page.request.get(route);
        expect.soft(response.status(), route).toBe(403);
        clean(await response.text(), route);
      }

      // Descargas: con la entidad de B en la petición, 403; con la propia y el identificador de B, el mismo 404 (y el mismo cuerpo) que si no existiera.
      const sameSite = { origin, 'sec-fetch-site': 'same-origin' };
      const none = missingTargets();
      const downloads: Array<{ what: string; theirs: string; ownWithTheirs: string; ownWithMissing: string }> = [
        {
          what: 'documento del titular',
          theirs: `/api/panel/documentos/${victim.documentId}?orgSlug=${victimEntity.slug}`,
          ownWithTheirs: `/api/panel/documentos/${victim.documentId}?orgSlug=${attacker.slug}`,
          ownWithMissing: `/api/panel/documentos/${none.campaignId}?orgSlug=${attacker.slug}`
        },
        {
          what: 'factura de la liquidación',
          theirs: `/api/panel/liquidaciones/factura/${victim.invoiceFileId}?orgSlug=${victimEntity.slug}`,
          ownWithTheirs: `/api/panel/liquidaciones/factura/${victim.invoiceFileId}?orgSlug=${attacker.slug}`,
          ownWithMissing: `/api/panel/liquidaciones/factura/${'y'.repeat(24)}?orgSlug=${attacker.slug}`
        },
        {
          what: 'justificante del Fondo',
          theirs: `/api/panel/fondo/${victim.fundPayoutId}/justificante?org=${victimEntity.slug}&lang=es`,
          ownWithTheirs: `/api/panel/fondo/${victim.fundPayoutId}/justificante?org=${attacker.slug}&lang=es`,
          ownWithMissing: `/api/panel/fondo/${none.fundPayoutId}/justificante?org=${attacker.slug}&lang=es`
        }
      ];
      for (const download of downloads) {
        const [theirs, ownWithTheirs, ownWithMissing] = await Promise.all([download.theirs, download.ownWithTheirs, download.ownWithMissing].map((route) => page.request.get(route, { maxRedirects: 0, headers: sameSite })));
        expect.soft([theirs!.status(), ownWithTheirs!.status(), ownWithMissing!.status()], download.what).toEqual([403, 404, 404]);
        expect.soft(await ownWithTheirs!.text(), download.what).toBe(await ownWithMissing!.text());
        for (const response of [theirs!, ownWithTheirs!]) {
          expect.soft(response.headers()['location'], download.what).toBeUndefined();
          clean(await response.text(), download.what);
        }
      }
      const medal = await page.request.get(`/api/panel/medalla?orgSlug=${victimEntity.slug}&nivel=plata&tipo=informe&locale=es`, { maxRedirects: 0, headers: sameSite });
      expect.soft(medal.status(), 'informe de medalla').toBe(403);
      const model = await page.request.post('/api/panel/modelo-182', { headers: sameSite, data: { orgSlug: victimEntity.slug, fiscalYear: 2026, contactPhone: '934128890' } });
      expect.soft(model.status(), 'Modelo 182').toBe(403);
      clean(await model.text(), 'Modelo 182');

      // Subidas: con la entidad de B, 403; con la propia y un recurso de B, lo mismo que con uno que no existe. Ninguna deja un fichero ni cambia nada (la huella final).
      // Ficheros válidos (un PDF y una foto de verdad): lo que detiene la subida es de quién es el recurso, no que el fichero esté mal.
      const pdf = pdfFile('intruso');
      const png = await photoFile('intruso', { r: 90, g: 90, b: 90 });
      const upload = (route: string, file: typeof pdf, slug: string, initiativeId: number, sponsorId: number) =>
        // «Sin menores reconocibles» va confirmado como lo espera cada ruta (`true` en la imagen de campaña, `on` en las fotos del logro).
        page.request.post(route.replace('{slug}', slug).replace('{initiative}', String(initiativeId)).replace('{sponsor}', String(sponsorId)), {
          headers: sameSite,
          multipart: { file, intent: 'photo', orgSlug: slug, initiativeId: String(initiativeId), sponsorId: String(sponsorId), slot: 'BEFORE', noMinors: route.includes('campana-imagen') ? 'true' : 'on' }
        });
      const uploads: Array<{ route: string; file: typeof pdf; initiativeId: number; byResource: boolean }> = [
        { route: '/api/panel/documentos?orgSlug={slug}&kind=STATUTES', file: pdf, initiativeId: victim.campaignId, byResource: false },
        { route: '/api/panel/marca?orgSlug={slug}&kind=logo', file: png, initiativeId: victim.campaignId, byResource: false },
        { route: '/api/panel/liquidaciones/factura?orgSlug={slug}&initiativeId={initiative}', file: pdf, initiativeId: victim.payoutCampaignId, byResource: true },
        { route: '/api/panel/logros', file: png, initiativeId: victim.payoutCampaignId, byResource: true },
        { route: '/api/panel/campana-imagen?orgSlug={slug}&initiativeId={initiative}', file: png, initiativeId: victim.campaignId, byResource: true },
        { route: '/api/panel/comercios/logo?orgSlug={slug}&sponsorId={sponsor}', file: png, initiativeId: victim.campaignId, byResource: true }
      ];
      for (const attempt of uploads) {
        const theirs = await upload(attempt.route, attempt.file, victimEntity.slug, attempt.initiativeId, victim.sponsorId);
        expect.soft(theirs.status(), `${attempt.route} con la entidad B`).toBe(403);
        clean(await theirs.text(), attempt.route);
        if (!attempt.byResource) continue;
        const ownWithTheirs = await upload(attempt.route, attempt.file, attacker.slug, attempt.initiativeId, victim.sponsorId);
        const ownWithMissing = await upload(attempt.route, attempt.file, attacker.slug, none.campaignId, none.sponsorId);
        expect.soft(ownWithTheirs.status(), `${attempt.route} con la entidad propia y un recurso de B`).toBe(404);
        expect.soft([ownWithTheirs.status(), await ownWithTheirs.text()], attempt.route).toEqual([ownWithMissing.status(), await ownWithMissing.text()]);
        clean(await ownWithTheirs.text(), attempt.route);
      }
    });

    if (PRODUCTION_BUILD) {
      // ───────────── 4. La consola: todas las acciones del Super-Admin ─────────────
      const consoleActions = loadActions().filter((action) => action.file.includes('/(superadmin)/admin/'));
      await test.step('censo de acciones de la consola del Super-Admin desde una cuenta de entidad', async () => {
        expect(consoleActions.length).toBeGreaterThanOrEqual(30);
        for (const action of consoleActions) {
          const { outcome, audit } = await call(() => invoke(page, pageUrl(action.pages[0]!, { ...params, id: victim.organizationId }), action.id, [consolePayload(action.name, victim)]));
          const label = `${action.name} sin ser Super-Admin (devolvió ${JSON.stringify(outcome.result)})`;
          expect.soft(outcome.http, label).toBe(200);
          // Se niega por quién la pide, no porque el dato esté mal formado: con el dato bien formado tampoco pasa…
          expect.soft(['FORBIDDEN', 'REAUTH_REQUIRED'], label).toContain(reasonOf(outcome.result));
          // …y la auditoría dice por qué: la cuenta no es de Super-Admin (no «un Super-Admin que debe volver a verificarse»).
          const reasons = audit.filter((row) => row.action === 'tenant.access_denied').map((row) => String(row.metadata.reason));
          expect.soft(reasons.length, `${label}: filas tenant.access_denied`).toBeGreaterThanOrEqual(1);
          expect.soft(reasons.every((reason) => reason === 'NOT_SUPERADMIN' || reason === 'SUPERADMIN_ONLY'), `${label}: motivo registrado ${JSON.stringify(reasons)}`).toBe(true);
          expect.soft(leaksIn(outcome.body, victim), `${label}: datos de B en la respuesta`).toEqual([]);
        }
      });
    }

    // ───────────── 5. Sin sesión: ni páginas, ni ficheros, ni acciones ─────────────
    await test.step('lo mismo sin sesión: páginas, ficheros, subidas y acciones', async () => {
      const anonymous = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
      const sameSite = { origin, 'sec-fetch-site': 'same-origin' };
      const clean = (body: string, what: string) => expect.soft(leaksIn(body, victim), `${what} sin sesión: datos de B en la respuesta`).toEqual([]);
      // El panel y la consola mandan a entrar, con la ruta de vuelta y sin pintar nada.
      for (const route of [...['', '/aprobaciones', '/estudio', '/liquidaciones', '/logros', '/taquilla', '/vencidas', '/fondo', '/soporte', '/ajustes'].map((section) => `/panel/${victimEntity.slug}${section}`), '/admin', `/admin/entidades/${victim.organizationId}`, '/admin/ajustes']) {
        const response = await anonymous.request.get(route, { maxRedirects: 0 });
        expect.soft([response.status(), /\/login\?next=/.test(response.headers()['location'] ?? '')], `${route} sin sesión`).toEqual([307, true]);
        clean(await response.text(), route);
      }
      // La página de firma queda fuera de esa guardia a propósito: el enlace viaja en el fragmento (`#t=…`) y una redirección lo perdería. Sin sesión solo
      // lleva el nombre de la entidad (que es público, el de su portal) y la invitación a entrar: nada de lo que se firma.
      const signPage = await anonymous.request.get(`/panel/${victimEntity.slug}/firmar`, { maxRedirects: 0 });
      expect.soft(signPage.status(), 'página de firma sin sesión').toBe(200);
      expect.soft(leaksIn(await signPage.text(), victim).filter((needle) => needle !== victimEntity.name), 'página de firma sin sesión: datos de B').toEqual([]);
      // Descargas, Modelo 182 y subidas: 403 sin sesión, sin redirección a ningún fichero.
      for (const route of [
        `/api/panel/documentos/${victim.documentId}?orgSlug=${victimEntity.slug}`,
        `/api/panel/liquidaciones/factura/${victim.invoiceFileId}?orgSlug=${victimEntity.slug}`,
        `/api/panel/fondo/${victim.fundPayoutId}/justificante?org=${victimEntity.slug}&lang=es`,
        `/api/panel/medalla?orgSlug=${victimEntity.slug}&nivel=plata&tipo=informe&locale=es`
      ]) {
        const response = await anonymous.request.get(route, { maxRedirects: 0, headers: sameSite });
        expect.soft([response.status(), response.headers()['location']], `${route} sin sesión`).toEqual([403, undefined]);
        clean(await response.text(), route);
      }
      const model = await anonymous.request.post('/api/panel/modelo-182', { headers: sameSite, data: { orgSlug: victimEntity.slug, fiscalYear: 2026, contactPhone: '934128890' } });
      expect.soft(model.status(), 'Modelo 182 sin sesión').toBe(403);
      const photo = await photoFile('intruso', { r: 90, g: 90, b: 90 });
      for (const route of [
        `/api/panel/documentos?orgSlug=${victimEntity.slug}&kind=STATUTES`,
        `/api/panel/marca?orgSlug=${victimEntity.slug}&kind=logo`,
        '/api/panel/liquidaciones/factura',
        '/api/panel/logros',
        `/api/panel/campana-imagen?orgSlug=${victimEntity.slug}&initiativeId=${victim.campaignId}`,
        '/api/panel/comercios/logo'
      ]) {
        const response = await anonymous.request.post(route, {
          headers: sameSite,
          multipart: { file: route.includes('documentos') || route.includes('factura') ? pdfFile('intruso') : photo, intent: 'photo', orgSlug: victimEntity.slug, initiativeId: String(victim.campaignId), sponsorId: String(victim.sponsorId), slot: 'BEFORE', noMinors: 'on' }
        });
        expect.soft(response.status(), `${route} sin sesión`).toBe(403);
        clean(await response.text(), route);
      }

      if (PRODUCTION_BUILD) {
        // Las acciones de gestión del panel y las de la consola: sin sesión mandan a entrar antes de ejecutar nada; la acción ni siquiera se alcanza.
        const forVictim = { ...entityArguments(victimEntity.slug), ...resourceArguments(victimEntity.slug, victim) };
        const targets = [
          ...loadActions()
            .filter((action) => PANEL_FILES.some((folder) => action.file.includes(folder)))
            .map((action) => ({ action, args: forVictim[action.name]! })),
          ...loadActions()
            .filter((action) => action.file.includes('/(superadmin)/admin/'))
            .map((action) => ({ action, args: [consolePayload(action.name, victim)] }))
        ];
        expect(targets.length).toBeGreaterThanOrEqual(75);
        for (const { action, args } of targets) {
          const outcome = await invokeAnonymous(anonymous.request, origin, pageUrl(action.pages[0]!, { ...params, orgSlug: victimEntity.slug, id: victim.organizationId }), action.id, args);
          clean(outcome.body, action.name);
          // Las dos de la firma se alcanzan (su página está fuera de la guardia), pero sin sesión solo dicen que hay que entrar: ni miran el enlace.
          if (SIGNING_ACTIONS.includes(action.name)) expect.soft([outcome.http, /^1:(.*)$/m.exec(outcome.body)?.[1]], `${action.name} sin sesión`).toEqual([200, '{"status":"LOGIN_REQUIRED"}']);
          else expect.soft([outcome.http, /\/login(\?|$)/.test(outcome.location)], `${action.name} sin sesión respondió ${outcome.http} → ${outcome.location}`).toEqual([307, true]);
        }
        // La portería no pide cuenta, pide el PIN del evento: sin él, sus acciones no hacen nada.
        for (const action of loadActions().filter((candidate) => candidate.file.includes('/panel/[orgSlug]/porteria/') && !/^(enterGate|leaveGate)Action$/.test(candidate.name))) {
          const outcome = await invokeAnonymous(anonymous.request, origin, pageUrl(action.pages[0]!, { ...params, orgSlug: victimEntity.slug }), action.id, [victim.eventId, { payload: 'KORUM1.00000000-0000-4000-8000-000000000000.AAAA', people: 1, scans: [], winnersCount: 1, idempotencyKey: randomUUID() }]);
          expect.soft([outcome.http, /^1:(.*)$/m.exec(outcome.body)?.[1]], `${action.name} sin sesión ni PIN`).toEqual([200, '{"status":"ERROR","reason":"NO_SESSION"}']);
          clean(outcome.body, action.name);
        }
      }
      await anonymous.close();
    });

    // ───────────── Nada de B ha cambiado ─────────────
    expect(await fingerprint(victim.organizationId)).toEqual(before);
    expect(await outboxOf(victim.organizationId, victimAddresses)).toEqual(outboxBefore);
    // El panel propio sigue funcionando después de todo.
    await page.goto(`/panel/${attacker.slug}`);
    await expect(page.getByRole('navigation', { name: 'Secciones del panel' })).toBeVisible();
    expect(errors.filter((message) => !/status of 40[034]/.test(message))).toEqual([]);
  });
});
