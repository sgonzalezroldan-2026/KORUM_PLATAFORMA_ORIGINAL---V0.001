# Bitácora de sprints · KORUM

> Memoria compartida del proyecto. **Cada asistente (Claude o Gemini) la lee al empezar un sprint y añade una entrada al terminarlo** (Regla 04). Las entradas más recientes van arriba. No se borran entradas antiguas.

## Plantilla de entrada

```markdown
### Sprint X.Y — Título · AAAA-MM-DD · ESTADO (terminado / en curso / bloqueado)

- **Modelo y esfuerzo usados:** (p. ej. Claude Sonnet 5.5 · alto; auditoría Claude Opus 5.5 · alto)
- **Qué se ha hecho:** archivos creados o modificados y funcionalidad entregada.
- **Decisiones tomadas:** y por qué (si cambian un documento que manda, enlazarlo).
- **Pendiente / deuda:** lo que queda y en qué sprint se resuelve.
- **Puertas:** P1 ✅/❌ · P2 ✅/❌ · P3 ✅/❌ (auditores) · P4 ✅/❌ · P5 ✅/❌
- **Siguiente sprint:** X.Z · modelo recomendado: …
```

---

## Entradas

### Sprint 2.1 — Adaptador Paycomet, webhooks idempotentes, split transfer y reembolsos al origen · 2026-10-31 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Opus 5.5 (el asistente no puede leer el esfuerzo configurado). Auditoría: `fintech-escrow-auditor`, `antifraud-legal-guardian` y `qa-e2e-verifier` (este último, en Sonnet 5.5).
- **Qué se ha hecho:**
  - **`src/services/payments/`:** interfaz `PaymentProvider`, simulador `mock-paycomet.ts`, adaptador REST `paycomet.adapter.ts`, `provider-factory.ts`, `paycomet-notification.ts` (firma e identificador), `paycomet-webhook.service.ts`, `payment-events.service.ts`, `payment-reversals.ts` (devoluciones y contracargos), `split-transfer.service.ts` (liquidación) y `card-tokens.ts`.
  - **Otros archivos nuevos:** `src/app/api/webhooks/paycomet/route.ts`, `src/core/finance/campaign-window.ts`, `src/core/finance/payment-journals.ts` y `src/lib/encryption.ts` (AES-256-GCM).
  - **Esquema:** migraciones `20261030090600_payout_splits` y `20261030090700_payout_destination_refund_claim`.
  - **Tests:** `tests/unit/paycomet-escrow.spec.ts` y `tests/integration/payments.spec.ts`. `global-setup.ts` reinicia las secuencias para que las filas de los tests no choquen con los identificadores fijos de la semilla.
  - **Documentos:** skill `korum-escrow-payments`, CUMPLIMIENTO §2 (preguntas 9 y 10) y retención, PRD, `.env.example` y notas «Heredado del Sprint 2.1» en las fichas 2.2, 2.3, 2.4, 2.5, 3.4, 3.5, 4.4, 5.3 y 6.1.
- **Decisiones tomadas:**
  - **Mover dinero como máximo una vez:** se reserva la fila antes de llamar a Paycomet. Si el resultado es desconocido, no se reintenta a ciegas: espera a su notificación o a una persona (`resolveUnknownRefund`, `resolveUnknownSplit`).
  - **Una liquidación son varios repartos:** el split de Paycomet cita un cobro original, así que una liquidación son N repartos, cada uno con su ventana de 90 días.
  - **Cuenta destino fija al aprobar:** `destinationSplitId` se guarda con las firmas; un cambio posterior de cuenta no desvía el dinero.
  - **Cobro tardío:** si llega con la campaña cerrada o liquidada, se asienta y queda `REFUND_PENDING`.
  - **Firma inválida:** no se guarda el cuerpo; solo un recuento por hora y motivo (`rejected:<hora>:<motivo>`), con 90 días de retención en CUMPLIMIENTO.
  - **`GOAL_REACHED` a `FUNDRAISING`:** un contracargo que deja la iniciativa bajo la meta la devuelve a recaudar (PRD).
  - **`prisma/reset.ts`:** ahora siembra tras migrar, como ya decía la documentación. El cambio aún no se ha ejecutado.
  - **`env.ts`:** rechaza `PAYCOMET_MODE=live` junto con el modo demostración.
- **Suposiciones contra el simulador (bloquean los cobros reales, Sprint 6.1):**
  - Paycomet rechaza las devoluciones que exceden el cobro y aplica el tope de reparto por pedido.
  - Todo cobro confirmado trae `AuthCode`.
  - El formato de las notificaciones, el valor de fallo de `Response` y que `BankDateTime` esté en UTC.
  - **El adaptador real nunca se ha ejecutado contra el sandbox**, porque no hay credenciales.
- **Pendiente / deuda:**
  - **Riesgos aceptados:** un `AuthCode` falso en la primera escritura (resolver antes de cobrar dinero real) y la contención en la fila de rechazados hasta el límite de peticiones del 2.4.
  - **Sin verificar:** la concurrencia real solo se ha revisado leyendo el código, porque la base local tiene una sola conexión; la CI con PostgreSQL real aún no se ha visto. Los webhooks se serializan por iniciativa y no se ha medido si un pico agota el tiempo de la transacción de Prisma.
  - **QA parcial:** en `QA-P04`, el aviso de `SPLIT_WINDOW_GUARD` solo existe como cálculo; la tarea programada llega en el 2.4. En `QA-P02`, el caso sin saldo que retirar queda como diseño hasta Mi Hucha.
  - **Sprint 2.3:** pases y `ticketsSold`. **Sprint 3.5:** `SPONSORSHIP` falla a propósito en el webhook.
  - **Sprint 2.4:** la comisión de pasarela sale de `GlobalConfig` hasta la conciliación, y el corte de la renovación anual de cupos debe ser posterior al 21 de agosto.
  - **Deudas del 1.3 movidas:** reparto del Matching de la semilla al 3.4, bolsa sin `Contribution` al 2.4/3.5 y factura del proveedor al 2.4.
  - **Decisión del promotor antes del Sprint 5.2:** el «Retorno» de 💎 incluye dinero que KORUM se queda de todos modos (fee de comercios) y omite la pasarela recuperada, así que puede dar falsos positivos.
  - **Modelos por tipo de agente:** el promotor pidió revisarlos al acabar este sprint; no se ha cambiado ninguno.
- **Incidencias:**
  - La base local de PGlite puede quedarse colgada tras una suite de integración con muchos fallos: hace falta reiniciarla (`npm run db:dev`). Los datos no se pierden.
  - QA dejó en la base local una fila `rejected:…:BAD_SIGNATURE` de su petición real con firma falsa. Es inofensiva.
- **Puertas:**
  - **P1 ✅** invariantes, `typecheck` y `lint` a 0.
  - **P2 ✅** 284/284 unitarias y 149/149 de integración.
  - **P3 ✅** financiera aprobada; seguridad aprobada con condiciones, aplicadas; QA aprobado. Mutaciones de QA: 5 de 6 detectadas; la sexta (identificador con `MethodId` o `ErrorID`) se escapaba y se cubrió con una prueba nueva, comprobada con esa misma mutación.
  - **P4 ✅** el sprint no tiene interfaz: `test:e2e` 41 pasan y 3 omitidas a propósito, y peticiones reales al endpoint (401 con firma falsa, 413 con cuerpo de 70 KB, con y sin tamaño declarado).
  - **P5 ✅** puertas repetidas tras cada corrección. Tras el último añadido, que solo toca una prueba unitaria, se repitieron P1 y las unitarias, no integración ni E2E.
- **Siguiente sprint:** 2.2 · modelo recomendado: **Claude Opus 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría Claude Opus 5.5 · alto.
- **Traspaso a otra sesión (decisión del promotor):** el Sprint 2.2 se hace en una sesión nueva, sin arrastrar este contexto. Los modelos por tipo de agente se tratan en una sesión aparte y dedicada; hasta entonces no se ha cambiado ninguno (mapa en `scripts/sync-ai-context.mjs`, `CLAUDE_MODEL_BY_AGENT`; la fuente de los agentes está en `.agents/agents/`). Antes de empezar el 2.2, leer la ficha (con la nota «Heredado del Sprint 2.1») y las «Pendiente / deuda» de arriba. `.vscode/settings.json` (exclusión de Tailwind sobre `prototype/`) quedó fuera de los commits a propósito.

### Paso previo al Sprint 2.1 — Cupos de la semilla y alerta de Auto-Impulso · 2026-10-30 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Opus 5.5 (el asistente no puede leer el esfuerzo configurado). Auditoría aprobada por `fintech-escrow-auditor` y `qa-e2e-verifier`.
- **Qué se ha hecho:**
  - **Semilla:** `seed_data.json` y `seed-base.ts` reservan cupos exentos, beca de medalla y mantenimiento con su instantánea y su curso. Las iniciativas #3 y #4 y la factura pasan a cursos anteriores para que los cupos cuadren sin tocar importes.
  - **`seed-verify.ts`:** `verifyQuotas` comprueba las reservas activas, que el KYB sea anterior a la publicación y que lo exento de cada curso no supere el límite.
  - **`bi-analytics.service.ts`:** la alerta 💎 usa `collectedNetRevenueCents`. Cifras fijadas en tests: #1 20.290, #2 5.840, #5 16.513 y #7 23.700 céntimos.
  - **Documentos:** Regla 02 §10, skill TCO §5, QA-FIN05, QA-A02, ficha 5.1 y `fintech-escrow-auditor`.
- **Decisiones tomadas:**
  - **Cupos (el promotor delegó la decisión):** se corrigen los datos de la semilla, no los importes de las iniciativas.
  - **Alerta 💎 (decisión del promotor):** se calcula solo con lo ya cobrado, más la comisión de tramos y el mantenimiento, que se liquidan al completar la meta. Nunca con aportaciones proyectadas ni entradas sin vender, que ya no llegarían si KORUM completa la meta.
  - **Base local:** reiniciada con autorización del promotor; la semilla concilia 3.018 asientos.
- **Pendiente / deuda:** `completedThisYear` es un contador de demostración, y `medalGrantUsedInTitle` no se gestiona al cancelar una campaña.
- **Puertas:** P1 ✅ · P2 ✅ · P3 ✅ (aprobado) · P4 no aplica (sin interfaz) · P5 ✅.

### Sprint 1.4 — Motor TCO dual, tope anual de mantenimiento y BI real frente a proyectado · 2026-10-30 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Opus 5.5 (el asistente no puede leer el esfuerzo configurado). Auditoría: `fintech-escrow-auditor` (Opus) y `qa-e2e-verifier` (Sonnet).
- **Qué se ha hecho:**
  - **`tco.service.ts`:** tramos `FLAT` y `MARGINAL`, pizarras de presupuesto y de taquilla, desglose público de 4 líneas y tope anual de mantenimiento.
  - **`pricing-health.ts`:** `evaluatePricingHealth`, que nunca lanza, y la lógica de aceptación de avisos por huella. Añade dos códigos a los de la skill: `RULE_VALUE_INVALID` y `BRACKET_THRESHOLDS_INVALID`.
  - **`bi-analytics.service.ts`:** las 6 fuentes proyectadas al 100 %, con la tasa de activación real; alertas 💎 y 🚨; ingresos reales desde los saldos del libro mayor.
  - **Tests nuevos:** `tco-bi-fuzz` (fuzzing 1.000× en cada modo), `bi-analytics` y `pricing-health`; ampliado `seed` con el cruce `ingresos − gastos === activo − pasivo` por entidad.
  - **Documentos corregidos:** skill TCO (§3, §4 y §5 pasan a texto con referencia al código, porque las copias del código se habían desviado), Regla 02 §10, QA-FIN05, QA-FIN06, QA-A02, DECISIONES §6.1, fichas de los Sprints 5.1 y 5.3, y dos agentes.
- **Decisiones tomadas:**
  - **Cuadre de las 6 fuentes:** `Σ 6 fuentes − costes === netRevenueCents`. La iniciativa 8 tiene 0 de fuentes y −62,50 € de neto, así que la redacción anterior era imposible de cumplir.
  - **Umbrales cruzados o iguales (decisión del constructor, reversible):** no se bloquean; el tramo 2 queda vacío y por encima de `t1` se aplica la tarifa `t3`. Si están cruzados, aviso `CRITICAL`.
  - **Datos imposibles:** decimales, negativos o valores no numéricos se rechazarán al guardar en el Sprint 5.3, porque el motor se niega a calcular con ellos. No contradice «ninguna regla se bloquea»: no son reglas de precios elegidas.
  - **Lo ya cobrado nunca se pierde:** una iniciativa que absorbe la pasarela o de taquilla no proyecta aportación voluntaria, pero conserva la real.
  - **Taquilla en `INC`:** nunca se retiene más que el precio, y un cobro de 0 no tiene pasarela ni margen. La fórmula de la skill inventaba ingresos en eventos gratis.
  - **Desglose público:** si el coste real supera la meta, lanza `PublicBreakdownMismatchError` en vez de publicar un desglose que no cuadra.
  - **Cupos de las campañas sembradas (el promotor delegó la decisión):** se corrigen sin tocar importes de las iniciativas, en un paso aparte antes del Sprint 2.1 (ver Pendiente).
- **Auditoría (Puerta 3):**
  - **Financiera:** rechazada a la primera, aprobada en la reauditoría. Sin descuadres en 300.000 casos propios. Corregidos:
    - la salud de precios lanzaba con umbrales cruzados;
    - la pasarela se contaba dos veces en taquilla que absorbe;
    - las tarifas de pasarela y de gestión no se validaban;
    - pruebas sin cifras fijadas, que por eso no vieron lo anterior;
    - documentos sin actualizar;
    - margen inventado en `INC` y donación media inflada por patrocinios.
  - **QA:** aprobada. En total, 28 alteraciones del motor; 25 detectadas a la primera. De las otras 3, 2 no cambian el resultado y 1 era un hueco real (`maintFeeCents`), ya cubierto.
  - **Lanzar dos auditores a la vez provocó arranques fallidos de la integración:** `global-setup` borra `korum_test` en cada arranque. Las suites de integración se ejecutan de una en una. Si `globalSetup` falla, Vitest muestra `No test files found` y `code.charCodeAt is not a function`, que ocultan el error real.
- **Pendiente / deuda:**
  - **Siguiente paso, antes del Sprint 2.1: coherencia de los cupos sembrados** (la deuda del 1.3). Sin tocar metas, comisiones ni recaudado:
    - CERVANTES: exento y beca restantes a 0, y `medalGrantUsedInTitle` con el título de la iniciativa 1. Sus 3 usos del exento pasan a 3 cursos distintos: iniciativa 3 a `2025-2026`; iniciativa 4 a `2024-2025`, con fechas de 2025.
    - MEDITERRANEO: exento restante a 1.000 €, y `defaultExemptAppliedCents` de la iniciativa 8 a 0, porque está exenta por categoría y no consume cupo.
    - SANJOSE y CLUBKORUM ya cuadran.
    - Instantáneas `quotaReserved*` en las campañas sembradas y comprobación en `seed-verify`.
    - Rehacer la base local exige `db:reset`, con autorización expresa del promotor.
  - **Sprint 5.1 (requiere visto bueno del promotor, cambia la Regla 02 §10):** la alerta 💎 cuenta aportaciones proyectadas y entradas sin vender que no llegarían si KORUM completa la meta. Recomendación: calcularla solo con lo cobrado. Hoy no cambia ninguna alerta de la semilla: 2,56 €, 3,94 € y 4,04 € de parte proyectada en las iniciativas 1, 5 y 7, y 1,60 € de margen de entradas sin vender en la 2. Tiene que estar resuelta antes del botón de ejecución del Sprint 5.2.
  - **Sprint 5.1, al llamar al motor:** pasar `maintFeeCents − maintShortfallCents` y sacar el número y la suma de la garantía de la misma consulta, porque una muestra incoherente lanza.
  - **Sprints 5.1 y 5.3:** los textos `admin.pricingHealth.*` y la parte visible de QA-FIN06 (aviso atenuado y guardado). El texto de `TICKET_FEE_BELOW_GATEWAY_COST` no debe decir «pierdes» con margen 0.
  - **Metas de la semilla:** 6 de las 8 están redondeadas a mano y su pasarela no coincide con la estimación del motor (en las iniciativas 3 y 4 queda 4,00 € por debajo). No se cambian: los costes reales se asientan cobro a cobro.
  - **`tco.service.ts` tiene 294 líneas:** cualquier ampliación obliga a partirlo antes.
  - **E2E:** `primitives.spec.ts:52` (tooltip a 1000 ms) falló una vez en modo desarrollo y pasó en la repetición completa y en 8 repeticiones seguidas. Fallo de temporización sin relación con este sprint; si reaparece, darle más margen.
  - **Tests redundantes:** `bi-analytics.spec.ts` conserva dos comprobaciones de la identidad del neto que ya no aportan; son inofensivas.
- **Puertas:**
  - P1 ✅: invariantes, `typecheck` y `lint` a 0.
  - P2 ✅: 239 unitarias y 96 de integración.
  - P3 ✅: financiero y QA aprobados.
  - P4 ✅: el sprint no tiene interfaz. No regresión con 41 E2E en verde y 3 omitidos, con el fallo puntual anotado arriba.
  - P5 ✅: todas las puertas repetidas desde la 1 tras las correcciones.
- **Siguiente sprint:** primero, el paso corto de cupos sembrados. Después, 2.1 · modelo recomendado: **Claude Opus 5.5 · esfuerzo extra alto** (auditoría Claude Opus 5.5 · alto). Adaptador Paycomet, webhooks, split transfer y reembolsos, contra el simulador.

### Sprint 1.3 — Semilla completa y repositorios con aislamiento entre entidades · 2026-10-30 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Sonnet 5.5 (el asistente no puede leer el esfuerzo configurado). Auditoría: `antifraud-legal-guardian` (Opus), `fintech-escrow-auditor` (Opus) y `qa-e2e-verifier` (Sonnet).
- **Qué se ha hecho:**
  - **Semilla** (`src/seed/*`, `prisma/seed.ts`, `prisma/reset.ts`): vuelca `src/mocks/seed_data.json` en la base:
    - 4 entidades con titular legal y 2 firmantes distintos, reglas globales y medallas;
    - 8 iniciativas, 5 comercios, 3 ideas con auditoría y chat, facturas y soporte;
    - 1.505 cobros deterministas, 112 pases QR firmados y 3.018 asientos (debe = haber);
    - 2 liquidaciones con doble firma: una ejecutada y otra esperando la 2ª firma.
    - Es idempotente (`npm run db:seed`, unos 20–30 s en la base local) y termina conciliando el libro mayor con la semilla al céntimo.
  - **Carga masiva** (`ledger-bulk.ts`): 2 sentencias SQL por lote dentro de una transacción. Valida cada asiento en memoria y, si el asiento ya existía, comprueba que tiene el mismo contenido (`assertSamePayload`): una semilla vieja se detiene con una pista para usar `db:reset`.
  - **Conciliación** (`seed-verify.ts`): cruza fuentes distintas, sin repetir la lógica del planificador:
    - la base contra el JSON;
    - la tabla de aportaciones contra el libro;
    - el IVA, calculado desde los comercios;
    - la garantía voluntaria;
    - `ORG_PAYABLE` a cero y pasarela sin negativos;
    - firmas, reparto e IBAN de cada liquidación;
    - que ningún asiento ni apunte de una iniciativa esté a nombre de otra entidad.
  - **Guardia** (`seed-guard.ts`): `db:seed` y `db:reset` se niegan con `PAYCOMET_MODE=live`, en producción sin entorno de demostración, con bases no locales sin `NEXT_PUBLIC_DEMO_MODE=true` y con URL que cambien el servidor con `?host=`. Comprueba `DATABASE_URL` y `DIRECT_URL`, porque el reinicio de Prisma actúa sobre `DIRECT_URL`.
  - **Repositorios** (`src/repositories/*`): `authorizeTenant` / `authorizeSuperadmin` con decisión pura (`decideTenantAccess`).
    - La sesión de portería queda limitada a su evento y el Super-Admin falla cerrado si no se puede auditar.
    - Los accesos fuera de la entidad y las sondas de identificadores inexistentes se registran en `AuditLog` con respuesta 404 uniforme.
    - Los identificadores del cliente se acotan, el `User-Agent` se reduce a la familia del navegador y las vistas usan `select` explícito, sin datos personales.
    - Las lecturas públicas solo devuelven campos públicos.
  - **Libro mayor** (migraciones `ledger_trigger_performance`, `ledger_guards_hardening` y `ledger_entry_journal_index`):
    - triggers con SQL estático;
    - restaura el trigger de cuadre por apunte, que una auditoría demostró necesario;
    - `search_path` con `pg_temp` al final en las 6 funciones;
    - guarda de `AuditLog` que solo admite anonimizar IP y navegador;
    - índice por `journalId` en los apuntes.
  - **Escáner** (`verify-invariants.mjs`): evalúa el estado final de cada guarda y de cada función `korum_*` recorriendo las migraciones en orden. Probado en negativo con migraciones temporales. ESLint prohíbe importar `@/seed/*` y `@/mocks/*` desde la aplicación.
  - **Tests nuevos:** `seed-plan`, `seed-guard` y `tenant-guard` (unitarios); `seed`, `ledger-bulk` y `tenant-isolation` (integración); ampliados `ledger` y `ledger-guards`.
  - **Entorno y datos del prototipo:**
    - `prisma.config.ts` trata los valores vacíos de `DIRECT_URL` y `SHADOW_DATABASE_URL` como no definidos.
    - Se corrigieron datos de `seed_data.json`: correos a `.example`, un CIF con dígito de control inválido, el comercio 2 pasa de la iniciativa 2 (taquilla) a la 1, las iniciativas 6 y 8 cierran dentro de los 60 días y las ideas 502 y 503 tienen su mensaje de chat.
- **Decisiones tomadas:**
  - **IVA del 21 % sobre el fee de patrocinios**, asentado en `TAX_PAYABLE_VAT`. Es **provisional hasta la asesoría fiscal**. La comisión por tramos de las entidades (FAC-2026-0014, 40,32 € de IVA) no se asienta: su factura es un documento informativo.
  - **Las liquidaciones de la semilla van a la cuenta de la entidad**, no a un proveedor. Supuesto provisional hasta la respuesta de **Paycomet** sobre pagar a terceros.
  - **Sin reservas de cupo en las campañas sembradas:** los cupos de las entidades vienen del prototipo y no equivalen a «límite − reservado».
  - La bolsa Matching 2x se cobra justo antes de la primera donación con bonus.
  - Prisma bloquea `migrate reset` cuando lo lanza una IA y exige la autorización expresa de la persona (variable `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`). Se pidió y se obtuvo una sola vez, para la base local, que solo tenía datos de demostración.
  - Los E2E en modo CI (`next start`) necesitan compilar con `NEXT_PUBLIC_DEMO_MODE=true`, como hace el CI; si no, la galería `/dev/ui` no existe en la compilación.
- **Auditoría (Puerta 3):** los tres auditores aprobaron tras varias rondas.
  - **Antifraude:**
    - corregidos portería, Super-Admin, `User-Agent`, correos reales, tiempos al enumerar identificadores y `limit` con `NaN`;
    - último bloqueante: la guardia de `db:reset` ignoraba `DIRECT_URL` (corregido y probado con el comando real).
  - **Financiero:**
    - corregidos el trigger de cuadre por apunte, los tres ataques con `SET CONSTRAINTS` y tablas temporales, el IVA, los cupos inventados, `ledger-bulk` sin comparar contenido y las comprobaciones tautológicas;
    - su reserva D queda como deuda.
  - **QA:** corregidos el índice por `journalId`, el `?host=`, la limpieza de `seed.spec.ts` y el criterio QA-C04.
- **Pendiente / deuda:**
  - **Bloquean el paso a cobros reales** (tareas aplazadas):
    - el IVA de patrocinios y de la comisión por tramos, que sigue pendiente de la asesoría fiscal;
    - el destino de las liquidaciones, que sigue pendiente de Paycomet.
  - **Cupos de las campañas sembradas.** Cancelar o reembolsar una campaña sembrada no devuelve cupo a la entidad (Regla 02 §2). Hay que corregir los cupos del JSON y añadir las instantáneas antes del sprint de cancelaciones. **Cambia cifras del prototipo, así que necesita tu visto bueno.**
  - **Bolsa Matching 2x de la semilla.** Las donaciones 0155–0158 de la iniciativa 1 llegan con la bolsa pagada y no se emparejan, y la 0159 recibe 38 € sobre 40 € aunque quedan al menos 100 € en la bolsa. Rehacer el reparto con el motor real del checkout (Sprint 2.1). La bolsa tampoco tiene `Contribution`, así que `MASS_REFUND` no podría devolverla.
  - **Facturas de liquidación (Sprint 2.4):** la liquidación ejecutada no lleva `PROVIDER_INVOICE`, y la skill §8 la exige también cuando el destino es la entidad.
  - **Sprint 3.2 (obligatorio):** `loadUserActor` no considera la 2FA. Sin ella, la sesión no debe recibir los roles `DIRECTOR`, `COSIGNER` ni Super-Admin. Además, el acceso anónimo se audita como `USER`.
  - **Sprint 6.1:** aplicar el rol `korum_app` (`prisma/sql/runtime-role.sql`) y hacer que la semilla se niegue si la base ya contiene entidades que no son de la semilla (un túnel SSH aparece como `localhost`).
  - **Sprints 2.5 y 3.7:** la supresión RGPD debe anonimizar al usuario, porque los apuntes tienen clave foránea `RESTRICT`. `DATA_RETENTION_PURGE` debe filtrar por `occurredAt` y tener en cuenta que `korum_app` puede poner a NULL `ipHash` y `userAgent`.
  - **Repositorios:** la prueba `_proof` de `assertInitiativeInOrganization` no va atada al `organizationId`. Atarla cuando más repositorios dependan de ella.
  - **Semilla:** la carga no es atómica entre tablas. Al volver a ejecutarla converge y `verifySeed` lo detecta.
  - **Concurrencia real:** solo la demuestra la CI con PostgreSQL 16, que aún no se ha ejecutado (no hay repositorio remoto). La base local es PGlite.
- **Puertas:**
  - P1 ✅: invariantes (94 archivos, 6 migraciones), `db:validate`, `typecheck` y `lint` a 0.
  - P2 ✅: 154 unitarias y 91 de integración, estables en dos ejecuciones seguidas. `db:seed` repetido sobre la base local sin duplicados.
  - P3 ✅: los tres auditores aprobaron.
  - P4 ✅: el sprint no tiene interfaz. La no regresión pasa con 41 E2E en verde (y 3 omitidos) sobre la compilación de producción.
  - P5 ✅: todas las puertas repetidas desde la 1 tras cada corrección. `npm audit`: 0 vulnerabilidades.
- **Siguiente sprint:** 1.4 · modelo recomendado: **Claude Opus 5.5 · esfuerzo alto** (auditoría Claude Opus 5.5 · alto). Motor TCO dual (`FLAT` y `MARGINAL`) y `evaluatePricingHealth`, con fuzzing 1.000×.

### Sprint 1.2 — Libro mayor de doble partida, cliente Prisma y cupos reversibles · 2026-10-30 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Opus 5.5 (esfuerzo recomendado extra alto; el asistente no puede leer el configurado). Auditoría: `fintech-escrow-auditor` (Opus) y `qa-e2e-verifier` (Sonnet).
- **Qué se ha hecho:**
  - **Migraciones** en `prisma/migrations/`:
    - `init`: se genera desde el esquema.
    - `ledger_immutability`: impide `UPDATE`/`DELETE`/`TRUNCATE` en asientos, apuntes y auditoría; comprueba el cuadre al confirmar; `CHECK amountCents > 0`, solo EUR y enlace de los contra-asientos.
    - `ledger_append_guard`: ningún apunte puede añadirse a un asiento ya registrado; claves foráneas en las dimensiones; instantánea de cupos y curso.
  - **Cliente y servicios:**
    - `src/lib/prisma.ts`: adaptador `pg`, cliente perezoso y extensión `korum-append-only`. `src/lib/db.ts`: tipo `Db`, `inTransaction`.
    - `money.ts`: `parseEurosToCents` y `bpsOf`, exactos con `BigInt`.
    - `ledger-accounts.ts`: plan de cuentas con naturaleza y dimensiones obligatorias. `ledger-validation.ts`: validación pura.
    - `ledger.service.ts`: `postJournal` idempotente y `reverseJournal`. `ledger-balances.ts`: saldos por cuenta y dimensión, y balance de sumas.
    - `quota-reservation.ts`: reserva y liberación de cupos (QA-FIN01).
  - **Pruebas:**
    - `tests/integration/` contra PostgreSQL real en un esquema aislado `korum_test`, que se recrea en cada ejecución. 42 pruebas: QA-C03, QA-FIN01 y todos los ataques de la auditoría.
    - Base local sin Docker: `npm run db:dev`. CI con un servicio `postgres:16`.
  - **Escáner:** comprueba que ninguna migración borra ni desactiva los triggers del libro mayor.
  - **Producción:** `prisma/sql/runtime-role.sql` crea un rol de ejecución sin privilegios, que se aplicará en el Sprint 6.1.
- **Decisiones tomadas:**
  - `formatCents`/`eurosToCents` de la ficha pasan a `formatCents`/`parseEurosToCents`.
  - Los saldos se separan en `ledger-balances.ts` para no superar 300 líneas.
  - La renovación anual de cupos (`Organization.quotaPeriod`) queda para el Sprint 2.4.
  - En local las pruebas usan 1 conexión porque PGlite (la base de `npm run db:dev`) mezcla mensajes de protocolo con varias.
- **Auditoría (Puerta 3):**
  - **Financiera:** rechazado a la primera, aprobado en la reauditoría. Los apuntes podían añadirse a un asiento ya confirmado: el auditor sumó 1.000 € a una hucha con SQL directo. Corregido con el sello de transacción.
  - **Defectos ya corregidos y probados:**
    - la reserva de cupos podía quedar marcada sin descuento si quien llamaba capturaba el error;
    - la liberación usaba el presupuesto actual en vez de lo reservado;
    - la idempotencia no comparaba las referencias de origen;
    - había una carrera en los contra-asientos;
    - los apuntes no tenían claves foráneas.
  - **QA:** aprobado; sus hallazgos coincidían con los anteriores.
- **Pendiente / deuda:**
  - **La concurrencia real solo la demuestra la CI con PostgreSQL 16, que aún no se ha ejecutado** (no hay repositorio remoto). Hasta entonces, QA-C03 queda verificado en funcionalidad pero no en «concurrencia real».
  - El rol `korum_app` bloquea el paso a producción (casilla de [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §8).
  - La supresión RGPD (Sprints 2.5 y 3.7) debe anonimizar al usuario y no borrarlo: los apuntes tienen clave foránea `RESTRICT` hacia `User`.
  - `amountCents` es `Int`: máximo 21.474.836,47 € por apunte.
- **Puertas:**
  - P1 ✅: invariantes con 3 migraciones vigiladas, esquema, `typecheck` y `lint` a 0.
  - P2 ✅: 104 unitarias y 42 de integración, estables en 3 ejecuciones seguidas.
  - P3 ✅: financiera y QA aprobadas.
  - P4 ✅: el sprint no tiene interfaz; la no regresión del 1.1 pasa con 41 E2E en verde.
  - P5 ✅: todas las puertas repetidas tras cada corrección.
- **Siguiente sprint:** 1.3 · modelo recomendado: **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto) · auditoría Claude Opus 5.5 · alto. Semilla completa con sus asientos y repositorios con aislamiento entre entidades.

### Sprint 1.1 — Proyecto Next.js, idiomas, primitivas de marca y arnés QA · 2026-10-29 · terminado

- **Modelo y esfuerzo usados:** constructor Claude Sonnet 5.5 (esfuerzo recomendado: alto; el asistente no puede leer el nivel configurado en la sesión). Auditoría: subagentes `ux-school-director-reviewer` y `qa-e2e-verifier` en Claude Sonnet 5.5.
- **Qué se ha hecho:**
  - **Proyecto:** `package.json` con versiones exactas (ver motivos en [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §2), `tsconfig` estricto, `next.config.ts` con cabeceras de seguridad, `postcss`, ESLint (con la regla `react/jsx-no-literals`: ningún texto visible fuera de `messages/`), Vitest, Playwright (`desktop` 1440×900 y `mobile` 430×932, con axe), `docker-compose.yml` (PostgreSQL 16), `prisma.config.ts`, CI (`.github/workflows/ci.yml`) y Dependabot, `README.md`, servidor MCP de Prisma en `.mcp.json` y `.agents/mcp_config.json`.
  - **Entorno:** `src/config/env.ts` (Zod) + `src/instrumentation-node.ts`: el servidor **se detiene** al arrancar si falta una variable crítica, con un mensaje que las nombra todas. `npm run setup:env` genera `.env.local` con los secretos.
  - **Idiomas:** `next-intl` con `es` (sin prefijo), `ca` y `en`; catálogos con las mismas claves (comprobado por test); **la URL decide el idioma** (sin redirección por el navegador ni cookie).
  - **Diseño:** `globals.css` con los tokens de marca en `@theme` de Tailwind 4 y las clases `.korum-paper-dots`, `.korum-court-grid`, `.korum-notebook-sheet`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.korum-stamp-badge`, `.varsity-patch` y `.mobile-stack`.
  - **Marca provisional:** `KorumMarkSvg` (SVG puro, apto para `next/og`), `KorumMark`, `KorumLogo` e `icon.svg`, dibujados a partir de `korum-logo.jpg`, sin año ni subtítulo.
  - **Primitivas:** `CurrencyText` + `formatCents` (importes exactos en `es`/`ca`/`en`), `TrustBadge`, `DelayedTooltip` (1000 ms; WCAG 1.4.13), `ToastProvider`, `SortableTh` + `useSortableRows`, `StatusBadge` (9 estados), `LanguageSwitcher`, `EmptyState`, `Skeleton` y `LoadingRegion`; páginas base (`/`, 404 localizado, error) y galería interna `/dev/ui` (solo en desarrollo y en el entorno de demostración).
- **Decisiones tomadas:**
  - Prisma 7.10.1 (la 8 está en candidata), TypeScript 6.0.3 (la 7 no es compatible aún con `typescript-eslint`), ESLint 9.39.5 (los plugins de Next no llegan a la 10), Node ≥ 24.
  - **No hay `loading.tsx` en la raíz de `[locale]`:** hacía *streaming* y las URL inexistentes devolvían 200 (soft-404); además, con traducciones de servidor volvía dinámica toda la ruta. Reglas anotadas en la skill de interfaz.
  - `formatCents` se adelanta del Sprint 1.2 al 1.1 (lo necesita `CurrencyText`).
  - Sin `preload` en HSTS hasta la preproducción.
- **Pendiente / deuda:**
  - ESLint 9 figura como «sin soporte» en npm: subir a la 10 cuando `eslint-config-next` lo permita. TypeScript 7 igual.
  - `LanguageSwitcher` no conserva los parámetros de búsqueda (aún no hay filtros en la URL). El `<title>` del 404 es el de la portada (Next no admite metadata localizada en `not-found`).
  - El logotipo es provisional (el laurel es una aproximación); se sustituye por el vectorial definitivo cuando exista.
  - `docker compose` no se ha podido probar en esta máquina (no hay Docker); el servidor MCP de Prisma tampoco se ha ejercitado.
  - El esfuerzo de IA configurado en la sesión no es legible por el asistente: se pregunta al usuario cuando importa.
- **Puertas:** P1 ✅ (invariantes, esquema Prisma, `typecheck` y `lint` a 0; `npm audit` de producción: 0 vulnerabilidades) · P2 ✅ (83/83 unitarias) · P3 ✅ (QA: aprobado con reservas, sin bloqueantes, 2 importantes corregidas; UX: rechazado a la primera por el tooltip —WCAG 1.4.13—, **aprobado tras la corrección**) · P4 ✅ (41 pruebas de navegador pasan en escritorio y móvil con axe, tanto contra `next dev` como contra la compilación de producción; 3 omitidas a propósito: el retardo con ratón no aplica a táctil; más exploración manual a 1440, 430, 360 y 320 px por los auditores) · P5 ✅ (todas las puertas repetidas tras cada corrección).
- **Siguiente sprint:** 1.2 · modelo recomendado: **Claude Opus 5.5 · esfuerzo extra alto** (alternativa: Gemini Argon · alto) · auditoría Claude Opus 5.5 · alto. Es el libro mayor de doble partida: dinero, inmutabilidad y migración con triggers.

### Sprint 0.8 — Decisiones del promotor tras la revisión · 2026-10-29 · terminado

- **Modelo usado:** Claude Sonnet 5.5 (Claude Code).
- **Qué se ha hecho:**
  - **Gestiones externas aplazadas:** nueva sección «Tareas externas aplazadas» en el plan (Paycomet, abogado, asesoría fiscal, proveedor Veri\*factu, `REGULATED_WALLET`), con qué se hace mientras tanto y dónde bloquean (Sprints 6.1 y 6.2). Anotado en el documento legal (§2, §9 y decisiones 11–13), el business case, la Regla 04 y las dependencias `⛓️` de los sprints 2.1, 4.4, 5.6 y 6.1.
  - **Logotipo y sello:** cerrados como descartados. El logotipo de referencia es la lámina `public/brand/korum-logo.jpg`; los SVG antiguos y el sello de custodia viven en `public/brand/_old/fase2_propuestas_descartadas/`. La skill de marca, su especificación SVG y la skill de interfaz se corrigen (el inventario citaba archivos que ya no existían) y el escáner comprueba ahora que todo archivo de `public/brand/` citado existe.
  - **Tramos, fee de Mi Hucha y comisiones configurables:** `GlobalConfig` gana `bracketMode` (`FLAT`/`MARGINAL`), `t1MaxCents`, `t2MaxCents` y `topupFeeBps`; tipos y semilla actualizados; `calculateBracketFeeCents` y la nueva **salud de precios** (`evaluatePricingHealth`, avisos `❗`/`⚠️` con «Ajustar» y «Aceptar y registrar») documentadas en la skill TCO §2.1 y en [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6.1; sprints 1.4, 5.1 y 5.3 y criterios `QA-FIN06` y `QA-A04` actualizados.
- **Decisiones tomadas:** los valores por defecto (`FLAT`, fee de Hucha `0,25 € + 0 %`) siguen siendo los del prototipo; con ellos la consola ya mostrará los avisos `HUCHA_FEE_BELOW_GATEWAY_COST` y `BRACKET_CLIFF`, a propósito, para que el Super-Admin decida con la cifra delante.
- **Pendiente / deuda:** el esquema se reformatea con `prisma format` en el Sprint 1.1 (cuando Prisma esté instalado); el lema opcional del logotipo queda abierto sin urgencia.
- **Puertas:** P1 ✅ (escáner de invariantes en verde). P2–P5 no aplican.

### Sprint 0.7 — Revisión documental para Claude y Gemini · 2026-10-29 · terminado

- **Modelo usado:** Claude Opus 5.5 (Claude Code).
- **Qué se ha hecho:**
  - **Marca unificada** en *Escudo Varsity Heritage*: eliminados los restos de la propuesta bancaria descartada en el contexto maestro, las skills y los agentes.
  - **Referencias al prototipo** convertidas en anclas estables con línea verificada automáticamente; cifras desfasadas eliminadas; duplicado de la matriz QA eliminado.
  - **Esquema de datos** corregido: libro mayor de doble partida real, organizaciones que se archivan en lugar de borrarse, estados como enum, titular legal de los fondos, KYB por estados, cifrado de NIF, tokens y secretos, modelos de autenticación (Better Auth), dispositivos, auditoría, webhooks, bandeja de salida, tareas programadas, ficheros, consentimientos y solicitudes RGPD, PIN de portería por evento, ventana de 90 días de Paycomet.
  - **Rol `COSIGNER`** en lugar del rol específico del AFA, con etiqueta de cargo por entidad.
  - **Documentos nuevos:** decisiones técnicas, cumplimiento legal y privacidad, experiencia de producto, guía de IA, glosario y esta bitácora.
  - **SEO:** skill `korum-seo-discoverability` y subagente `korum-seo-discoverability-specialist`.
  - **Plan** reorganizado (sprints nuevos de operación, privacidad, notificaciones, ajustes de la consola, pulido y piloto) con modelo de IA y esfuerzo recomendados en cada sprint.
  - **Claude Code:** `CLAUDE.md` con importaciones, `.claude/skills` y `.claude/agents` generados por `scripts/sync-ai-context.mjs`, `.mcp.json`; Antigravity: `GEMINI.md` y `.agents/mcp_config.json` actualizados.
  - **Escáner de invariantes** ampliado: coherencia de marca y roles, anclas del prototipo, línea `🤖` en cada sprint y sincronía de `.claude/`.
  - **Repositorio git** creado con el estado original como primer commit.
- **Decisiones tomadas:** ver [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §8 y [DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md).
- **Pendiente para el promotor:**
  1. Respuestas por escrito de Paycomet (8 preguntas, legal §2).
  2. Abogado y asesoría fiscal (legal §9).
  3. Revisar dos propuestas: el nuevo texto de la aportación voluntaria (Regla 03 §3) y la devolución del 100 % incluida la aportación voluntaria (legal §8, decisión 9).
  4. Decidir el subtítulo multi-vertical del logotipo y el texto del sello (skill de marca §5) y el efecto escalón de los tramos (business case §5).
  5. Elegir el proveedor de facturación Veri\*factu antes del Sprint 2.3.
- **Puertas:** P1 ✅ (escáner de invariantes en verde). P2–P5 no aplican (sin código de aplicación todavía).
- **Siguiente sprint:** 1.1 · modelo recomendado: **Claude Sonnet 5.5 · esfuerzo alto** (alternativa: Gemini Argon · alto).
