# Decisiones técnicas · KORUM v8.5

> Documento que manda en stack, proveedores, infraestructura y ajustes de la consola. Decisiones tomadas en octubre de 2026 con estos criterios: **datos en la Unión Europea**, **el menor número de proveedores posible**, **todo proveedor detrás de un adaptador** (para poder cambiarlo sin reescribir la app) y **toda configuración operativa editable desde la consola del Super-Admin**.

---

## 1. Principios

1. **Datos personales y financieros en la UE.** Base de datos, ficheros, email, errores y analítica con alojamiento en la UE o con contrato de encargado del tratamiento y garantías equivalentes.
2. **Un proveedor por necesidad**, y siempre detrás de una interfaz propia (`PaymentProvider`, `EmailProvider`, `StorageProvider`, `InvoicingProvider`).
3. **Configurable sin programar.** Credenciales, remitentes, modos de funcionamiento, textos legales y políticas se cambian desde `/admin/ajustes`. Solo las claves que protegen la propia consola viven en variables de entorno ([Regla 01](../.agents/rules/01-arquitectura-y-codigo.md) §5).
4. **Nada se pierde ni se duplica.** Webhooks idempotentes, bandeja de salida para notificaciones, cola de tareas con reintentos y libro mayor inmutable.
5. **Versiones al día.** En el Sprint 1.1 se instala la última versión estable de cada pieza y se fija sin rangos abiertos.

---

## 2. Stack de la aplicación

| Pieza | Decisión | Por qué | Alternativa descartada |
| :--- | :--- | :--- | :--- |
| Framework | **Next.js 16** (App Router, Server Components, Server Actions) | Una sola base para web pública, paneles y API; `next/og` para tarjetas sociales; excelente SEO. Versión estable verificada: 16.4 (oct. 2026). | — |
| UI | **React 19** + **Tailwind CSS 4** (configuración en CSS con `@theme`) | Rápido de construir y coherente con el sistema de diseño. | `tailwind.config.ts` (formato antiguo) |
| Base de datos | **PostgreSQL 16+** | Transacciones fuertes, ideal para dinero. | — |
| ORM | **Prisma ORM 7** (`prisma.config.ts` + adaptador `@prisma/adapter-pg`) | Tipado de extremo a extremo y migraciones. En la v7 la URL de conexión va en `prisma.config.ts` y la CLI ya no carga `.env` sola. | — |
| Autenticación | **Better Auth** (enlace mágico, OTP por email, contraseña, 2FA TOTP, passkeys, límite de intentos en base de datos) | Librería TypeScript completa; el equipo de Auth.js (NextAuth) se integró en Better Auth en 2025 y recomienda Better Auth para proyectos nuevos. Datos en nuestra propia base de datos. | Auth.js (solo mantenimiento), Supabase Auth (ata la lógica de roles a otro sistema), Clerk (datos fuera, coste por usuario) |
| Idiomas | **next-intl** (`es`, `ca`, `en`) con rutas por idioma | Estándar en App Router, mensajes ICU y SEO multi-idioma. | — |
| Validación | **Zod** | Mismo esquema para formularios, Server Actions, webhooks y entorno. | — |
| Emails | **React Email** (plantillas) + adaptador `EmailProvider` | Plantillas en React, en 3 idiomas, con vista previa local. | — |
| QR | `qrcode` (generar) + `BarcodeDetector` con librería de lectura de respaldo (leer) | Safari en iOS no soporta `BarcodeDetector`. | — |
| PDF | `@react-pdf/renderer` | Certificados, justificantes, actas de sorteo y cartel A4 desde componentes React. | Navegador sin cabeza (pesado en serverless) |
| Tests | **Vitest** + **Playwright** + **@axe-core/playwright** | Unitarios, extremo a extremo y accesibilidad en la misma suite. | — |
| Calidad | ESLint, TypeScript estricto, `verify-invariants.mjs`, Dependabot | Puerta 1 automática y dependencias al día. | — |

**Versiones fijadas en el Sprint 1.1 (29-10-2026, sin rangos abiertos en `package.json`) y por qué no son siempre «la última»:**

| Pieza | Fijada | Motivo |
| :--- | :--- | :--- |
| Node.js | `>=24.11.0` (LTS) | Prisma 7 exige ≥ 20.19/22.12/24; la CI usa 24. En local funciona con la 26. |
| Next.js / React / Tailwind / next-intl / Zod / Vitest / Playwright | las últimas estables (16.4.3 / 19.3.1 / 4.3.3 / 4.14.9 / 4.6.7 / 5.0.5 / 1.64.1) | — |
| **Prisma** | **7.10.1** | La etiqueta `latest` de `prisma` apunta a una 8.0 en candidata (*rc*), no estable; `@prisma/client` sigue en 7.10.1. Se reevalúa cuando la 8 sea estable. |
| **TypeScript** | **6.0.3** | La 7.0 (compilador nativo) aún no es compatible con `typescript-eslint` (`typescript <6.1`), que usa `eslint-config-next`. |
| **ESLint** | **9.39.5** (marcada «sin soporte» por ESLint) | Los plugins de `eslint-config-next` (`react`, `jsx-a11y`, `import`) aún declaran compatibilidad solo hasta ESLint 9. Es deuda conocida: se sube a la 10 cuando salgan sus versiones compatibles. |
| Servidor MCP de Playwright | `@playwright/mcp@0.0.83` | Fijado para que Claude y Gemini usen lo mismo y no cambie bajo los pies. |

La detección de idioma por el navegador y la cookie de idioma están **desactivadas a propósito** (`localeDetection: false`, `localeCookie: false`): la URL decide el idioma, para SEO, enlaces compartidos y privacidad.

---

## 3. Infraestructura

| Necesidad | Decisión | Detalle |
| :--- | :--- | :--- |
| Alojamiento de la app | **Vercel** | Funciones en Frankfurt (`fra1`); entornos `preview` (cada rama) y `production`; cron integrados que llaman a `/api/cron/*`. Contrato de encargado del tratamiento con cláusulas para transferencias. |
| Base de datos | **Supabase PostgreSQL** en Frankfurt | Conexión por *pooler* (`DATABASE_URL`) para la app y directa (`DIRECT_URL`) para migraciones; copias diarias y recuperación a un punto en el tiempo en el plan de pago. Solo se usa como PostgreSQL + almacenamiento (no su autenticación). |
| Ficheros | **Supabase Storage** (mismo proyecto, UE) | Cubo **público** (logos, portadas, Antes/Después ya publicadas) y **privado** (KYB, facturas, certificados, Modelo 182) con URL firmadas de corta duración. |
| Tareas programadas | **Vercel Cron → `/api/cron/[job]`** + tabla `Job` | Cada ejecución procesa un lote, con bloqueo, reintentos y registro. Sin servidores extra ni colas externas. |
| Límites de intentos | Tabla `RateLimit` en PostgreSQL | Suficiente para el volumen previsto; si algún día no basta, se cambia por Redis detrás de la misma función. |
| Errores | **Sentry** (región de datos UE) | Con limpieza de datos personales antes de enviar y alertas por email. |
| Analítica | **Plausible** (UE, sin cookies) | Visitas y embudos sin banner de cookies. Las métricas de negocio salen de nuestra base de datos. |
| Código y CI | **GitHub** + GitHub Actions | Cada cambio pasa P1, P2 y los E2E antes de desplegarse. |
| Desarrollo local | PostgreSQL con `npm run db:dev` (Prisma Postgres local, sin Docker) o Docker + `PAYCOMET_MODE=mock` + vista previa de emails | Todo funciona sin conexión a servicios externos. Las pruebas de integración usan el esquema aislado `korum_test`. La base de `npm run db:dev` es PGlite (un único proceso: comparte el `search_path` entre conexiones y no admite concurrencia real), así que la concurrencia real y el rendimiento definitivo se miden en la CI con PostgreSQL 16. |
| Datos de demostración (semilla) | `npm run db:seed` y `npm run db:reset` (`src/seed/*`, `prisma/seed.ts`, `prisma/reset.ts`) | Determinista (mismo reparto en cada ejecución), idempotente y con carga masiva de asientos (~25 s) que sigue validando cada asiento y comprobando que los ya existentes tienen el mismo contenido. Termina conciliando el libro mayor con la semilla al céntimo. **Guardia (`seed-guard`):** ni la semilla ni el reinicio se ejecutan con `PAYCOMET_MODE=live`, en producción sin entorno de demostración, ni contra una base que no sea local salvo con `NEXT_PUBLIC_DEMO_MODE=true`. Se comprueban `DATABASE_URL` **y** `DIRECT_URL` (el reinicio de Prisma actúa sobre `DIRECT_URL` si está definida): basta que una sea remota para negarse. Supuestos provisionales hasta cerrar las tareas aplazadas: IVA del 21 % sobre el fee de patrocinios (asesoría fiscal) y liquidación a la cuenta de la entidad, no a un proveedor (Paycomet). Los cupos de las entidades no llevan reservas de campaña: los valores del prototipo no equivalen a «límite − reservado». |

---

## 4. Proveedores externos

| Necesidad | Decisión | Estado |
| :--- | :--- | :--- |
| Pagos, retención y devoluciones | **Paycomet** (entidad de pago autorizada por el Banco de España; grupo Banco Sabadell) | Elegido. Pendiente de confirmar por escrito los puntos de [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §2. Restricción conocida: el *split transfer* debe hacerse en 90 días desde el cobro. |
| Monedero de Mi Hucha (solo modo `REGULATED_WALLET`) | **Paycomet** si ofrece monederos de usuario; si no, un proveedor de monederos autorizado como entidad de dinero electrónico (p. ej. **Mangopay**, el modelo de Wallapop) | Se lanza en modo `PLEDGE`, que no necesita monedero. |
| Email transaccional | **Brevo** (empresa europea, envío por API) detrás de `EmailProvider` | Elegido por residencia en la UE. Cambiable desde la consola a otro proveedor por API o a SMTP. |
| Facturación Veri\*factu | **Proveedor de facturación homologado con API** detrás de `InvoicingProvider` (evaluar, p. ej., Verifacti o B2Brouter) | A elegir antes del Sprint 2.3. Construir un sistema propio homologado (huella, envío a la AEAT, certificado, declaración responsable) no compensa. Obligatoriedad según el BOE vigente: 1 de enero de 2027 para sociedades (hay un aplazamiento anunciado no aprobado en oct. 2026). |
| Dominio y DNS | Registrador europeo con DNS gestionable | SPF, DKIM y DMARC para el email desde el primer día. |

---

## 5. Seguridad

- **Cifrado de secretos y datos sensibles:** AES-256-GCM con `ENCRYPTION_KEY` y versión de clave (`keyVersion`) para poder rotarla. Se cifran: secretos de la consola, tokens de Paycomet, NIF. Lo que hay que buscar (NIF, IP, huellas) se guarda además como HMAC con `DATA_HMAC_SECRET`.
- **Contraseñas y PIN:** hash lento (el de Better Auth para contraseñas; scrypt para el PIN de portería).
- **Cabeceras:** CSP estricta con *nonce*, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (cámara solo en la portería).
- **Sesiones:** cookies `HttpOnly`, `Secure`, `SameSite=Lax`; 2FA obligatoria para firmantes y Super-Admin; reautenticación para acciones sensibles.
- **Límites de intentos:** acceso, OTP, PIN de portería, checkout, firma de ideas y formularios de soporte.
- **Registro de auditoría** append-only para firmas, liquidaciones, cambios de ajustes, accesos denegados y acciones del Super-Admin.
- **Libro mayor blindado en tres capas:** (1) `postJournal` valida cada asiento; (2) la extensión `korum-append-only` del cliente impide editar, borrar o crear apuntes sueltos; (3) la base de datos, con triggers, impide `UPDATE`/`DELETE`/`TRUNCATE`, comprueba el cuadre al confirmar y no deja añadir apuntes a un asiento ya registrado.
- **Triggers rápidos:** las funciones de los triggers usan SQL estático con `SET search_path FROM CURRENT` (atadas al esquema donde se crean) en lugar de SQL dinámico; el cuadre se comprueba una vez por asiento (trigger diferido del asiento) porque los apuntes solo nacen en la transacción de su asiento. Cargar 3.000 asientos pasó de minutos a segundos sin perder ninguna garantía.
- **Rol de ejecución sin privilegios** (`prisma/sql/runtime-role.sql`): la aplicación se conecta como `korum_app`, que no es propietario ni superusuario, así que no puede desactivar triggers ni modificar el libro mayor; las migraciones usan la conexión directa del propietario. Se aplica en la preproducción (§8).
- **Dependencias:** Dependabot y `npm audit` en CI.

---

## 6. Ajustes editables desde la consola del Super-Admin (`/admin/ajustes`)

Se guardan en `PlatformSetting` (no secretos) y `PlatformSecret` (cifrados). Todo cambio exige 2FA reciente y queda en `AuditLog`.

| Clave | Tipo | Por defecto | Notas |
| :--- | :--- | :--- | :--- |
| `paycomet.apiKey` | secreto | — | Respaldo: `PAYCOMET_API_KEY` |
| `paycomet.webhookSecret` | secreto | — | Respaldo: `PAYCOMET_WEBHOOK_SECRET` |
| `paycomet.merchantCode`, `paycomet.terminalId`, `paycomet.jetId` | texto | — | `jetId` es público (formulario de tarjeta) |
| `paycomet.serverIp` | texto | — | IP pública del servidor que llama a Paycomet (devoluciones). Obligatoria con `sandbox` y `live`; ver §7.1 |
| `email.provider` | `brevo` · `smtp` · otro adaptador | `brevo` | |
| `email.apiKey` / `email.smtp.password` | secreto | — | Respaldo: `EMAIL_API_KEY` |
| `email.fromAddress`, `email.fromName`, `email.replyTo` | texto | `hola@{dominio}` · `KORUM` | |
| `invoicing.provider`, `invoicing.issuerNif`, `invoicing.issuerName`, `invoicing.series` | texto | — | Respaldo del NIF: `VERIFACTU_ISSUER_NIF` |
| `invoicing.apiKey` | secreto | — | |
| `hucha.mode` | `DISABLED` · `PLEDGE` · `REGULATED_WALLET` | `PLEDGE` | `REGULATED_WALLET` solo se puede activar si `hucha.walletProvider` está configurado |
| `hucha.walletProvider` + `hucha.walletApiKey` | texto + secreto | — | |
| `autoBoost.publicDisclosureDefault` | `SHOW` · `HIDE` | `SHOW` | Valor preseleccionado al ejecutar un Auto-Impulso; la decisión final se toma en cada ejecución |
| `seo.aiCrawlers` | JSON (listas de bots de búsqueda y de entrenamiento con su política) | ver skill de SEO | |
| `seo.verification.google`, `seo.verification.bing` | texto | — | |
| `seo.indexNowKey` | secreto | — | |
| `legal.{terminos,privacidad,cookies,aviso-legal}.{es,ca,en}` | Markdown versionado | — | Cada versión con fecha; los consentimientos guardan la versión aceptada |
| `platform.company` | JSON (razón social, NIF, domicilio, email de soporte y de privacidad) | — | Aparece en el aviso legal, los emails y las facturas |
| `limits.*` | números | ver Regla 01 y skills | Intentos de PIN, OTP, checkout |
| `pricing.acknowledgements` | JSON (lista de `{ code, fingerprint, acknowledgedById, acknowledgedAt, note }`) | `[]` | Avisos de salud de precios aceptados a propósito por el Super-Admin (§6.1) |

### 6.1 Reglas económicas editables y avisos de salud de precios

Las reglas de precio viven en `GlobalConfig` y se editan en el motor de reglas del Super-Admin (`/admin`, Sprint 5.3), no en el código:

| Regla | Campos | Por defecto |
| :--- | :--- | :--- |
| Comisión por tramos | `bracketMode` (`FLAT` · `MARGINAL`), `t1MaxCents`, `t2MaxCents`, `t1Bps`, `t2Bps`, `t3Bps`, `exemptLimitCents` | `FLAT`, 5.000 €, 15.000 €, 5 % / 4 % / 3 %, 1.000 € |
| Fee de Mi Hucha por cargo | `topupFeeCents` (fijo) + `topupFeeBps` (porcentaje) | 0,25 € + 0 % |
| Gastos de gestión digital (taquilla) | `ticketFeeFixedCents` + `ticketFeeBps` | 0,45 € + 2 % |
| Fee de gestión publicitaria (comercios) | `sponsorFeeBps` | 15 % |
| Coste de pasarela de referencia | `gatewayPctBps` + `gatewayFixedCents` | 1 % + 0,09 € |
| Mantenimiento | `maintActive`, `maintPerInitCents`, `maintAnnualCapCents` | apagado, 49 €, 147 € |

**Decisión del promotor:** ninguna de estas reglas se bloquea. Si la combinación elegida pierde dinero o es incoherente, la consola **avisa con una exclamación y una explicación** (`evaluatePricingHealth`, [skill TCO §2.1](../.agents/skills/korum-tco-calculator/SKILL.md)) y decide el Super-Admin: **ajustar** el valor o **aceptar y registrar** la pérdida con una nota (queda en `pricing.acknowledgements` y en `AuditLog`). Con los valores por defecto ya saltan dos avisos: el fee fijo de Mi Hucha (pierde dinero en cargos de más de 16 €) y el efecto escalón de los tramos en modo `FLAT`; ambos son decisiones abiertas a propósito, no errores. También se avisa de unos umbrales cruzados, sin bloquear ni romper el cálculo: el tramo 2 queda vacío. **Un dato imposible no es una regla de precios:** decimales, negativos o valores no numéricos se rechazan al guardar (Zod, Sprint 5.3), porque el motor se niega a calcular con ellos; mientras se edita, la consola avisa con `RULE_VALUE_INVALID`.

Los avisos se calculan al cargar la consola y en vivo mientras se edita un campo; nunca en el servidor del checkout, para que una regla mal configurada no pueda romper un cobro.

**Solo variables de entorno** (nunca en la consola, porque protegen la consola misma o los datos cifrados, o son infraestructura): `DATABASE_URL`, `DIRECT_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION`, `DATA_HMAC_SECRET`, `QR_HMAC_SECRET`, `CRON_SECRET`, `PAYCOMET_MODE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, `SUPERADMIN_BOOTSTRAP_EMAIL`, `NEXT_PUBLIC_DEMO_MODE`. Plantilla en [.env.example](../.env.example).

---

## 7. Tareas programadas

| Tarea (`JobType`) | Frecuencia objetivo (Pro) | Hoy en el plan gratuito | Qué hace |
| :--- | :--- | :--- | :--- |
| `CAMPAIGN_EXPIRY` | Cada hora | Diaria | Pasa a `EXPIRED` las campañas vencidas sin meta y avisa a los firmantes |
| `MASS_REFUND` | Cada 10 min | Diaria | Reembolsa por lotes todo `REFUND_PENDING` y las donaciones y entradas de iniciativas en `REFUNDING` o `CANCELLED`; al terminar, `REFUNDED` y cupos de vuelta |
| `TICKET_HOLD_RELEASE` | Cada 10 min | Diaria | Libera las plazas reservadas cuyo pago no llegó |
| `INVOICE_SUBMIT` | Cada 10 min | Diaria | Envía en orden las facturas pendientes a Veri\*factu y avisa de las que llevan más de 1 h en `SENT` |
| `MONTHLY_TOPUP` | Diaria | Diaria | **Sprint 2.4: solo detecta** las aportaciones mensuales vencidas y abre una alerta. El cobro llega con Mi Hucha (3.7) |
| `SPONSOR_RENEWAL_NOTICE` | Diaria | Diaria | Preaviso por email a 30 días del vencimiento de comercios con renovación automática |
| `SPONSOR_RENEWAL_CHARGE` | Diaria | Diaria | **Sprint 2.4: solo detecta** renovaciones vencidas y abre una alerta. El cobro llega con el Sprint 3.5 |
| `CREDIT_POOL_EXPIRY` | Diaria | Diaria | **Sprint 2.4: solo detecta** bolsas de patrocinio pasadas de 85 días desde su cobro y abre una alerta. El reembolso al comercio llega con el Sprint 3.5 |
| `SPLIT_WINDOW_GUARD` | Diaria | Diaria | Avisa cuando faltan 15 días para la ventana de 90 días de Paycomet |
| `PSP_RECONCILIATION` | Diaria (madrugada) | Diaria | Concilia los cobros de Paycomet con los de KORUM, uno a uno |
| `QUOTA_RENEWAL` | Diaria | Diaria | Renueva los cupos anuales de cada entidad desde el 22 de agosto |
| `MODEL182_REMINDER` | 2 de enero | 2 de enero | Recuerda a las entidades con Ley 49/2002 que descarguen su Modelo 182 |
| `OPS_HOUSEKEEPING` | Diaria | Diaria | Purga contadores de intentos caducados, notificaciones rechazadas de más de 90 días y desafíos de firma antiguos |
| `DATA_RETENTION_PURGE` | Semanal | Semanal | Aplica los plazos de conservación. **Sin manejador hasta el Sprint 2.5** |
| `OUTBOX_DISPATCH` | Cada minuto | Diaria | Envía las notificaciones pendientes. **Sin manejador hasta el Sprint 2.6** |

### 7.1 Cómo se ejecutan (Sprint 2.4)

- **Vercel Cron llama por `GET`** a `/api/cron/<tarea>` con `Authorization: Bearer <CRON_SECRET>`. Sin el secreto (o con otro, o con `CRON_SECRET` ausente o corto) responde `401` **antes** de tocar la base de datos. Una tarea desconocida o sin manejador responde `404`. El calendario vive en `vercel.json` y un test comprueba que coincide con `src/core/jobs/job-schedule.ts` y con los manejadores registrados.
- **Plan de Vercel (decisión del promotor, 04-11-2026): se usa el plan gratuito (Hobby) hasta que la aplicación escale.** Ese plan solo admite tareas **una vez al día**, con ±59 min de imprecisión, y rechaza el despliegue si una expresión corre más a menudo. Por eso `cron` (lo desplegado en `vercel.json`) es hoy diario para todas las tareas y `proCron` guarda la frecuencia buscada (`JOB_SPECS`, `VERCEL_PLAN = 'hobby'`). Un test impide desplegar una expresión que corra más de una vez al día mientras el plan sea Hobby. **Pasar a Pro** = poner `VERCEL_PLAN = 'pro'`, copiar cada `proCron` en `cron` y en `vercel.json`; no cambia nada más.
- **Qué cambia con una llamada al día**: (1) cada ejecución **vacía los lotes** hasta que no quede nada, se acabe el tiempo (240 s) o llegue a 40 lotes (`drainBatches`); (2) los reintentos de una tarea fallida y las esperas entre intentos de una devolución rechazada solo se atienden en la llamada siguiente (5 intentos = al menos 5 días); (3) una campaña vencida se cierra con hasta un día de retraso, así que **el cobro debe rechazar por sí mismo las aportaciones posteriores a `closesAt`** (Sprint 3.4) sin esperar a `CAMPAIGN_EXPIRY`; (4) los emails y las facturas Veri\*factu no salen cada pocos minutos: **el envío del recibo o de las entradas tras un pago debe lanzarse en el propio flujo del cobro** (Sprint 2.6) y la tarea diaria queda como red de seguridad. Las reservas de entradas caducadas sí se liberan al reservar, sin esperar a la tarea. (5) **Facturas Veri\*factu:** el registro debe enviarse poco después de emitirse; hay que lanzar el envío en el propio flujo de emisión (con `submitInvoice`, que ya reserva `PENDING → SENT`) y dejar la tarea diaria como respaldo; la asesoría fiscal confirma el plazo (ficha 6.1). **Condiciones de uso:** el plan Hobby de Vercel está pensado para uso personal y no comercial según sus condiciones; **hay que pasar a Pro antes del primer cobro real**, no solo cuando la aplicación escale.
- **Una ejecución por hueco de tiempo.** La clave del `Job` es `<TIPO>:<inicio del hueco UTC>` (hueco de 10 min, 1 h, 1 día o 1 semana según la tarea). Llamar dos veces dentro del mismo hueco no repite el trabajo. Cada lote trata `batchSize` registros; la llamada repite lotes mientras queden (ver «Qué cambia con una llamada al día»).
- **Dos servidores a la vez no ejecutan lo mismo**: la ejecución se reclama con una actualización condicional y quien reclama firma con un testigo propio. Una ejecución «en marcha» más de 15 minutos se da por perdida (caída) y se puede reclamar.
- **Reintentos con espera creciente**: tras el fallo número *n* espera `min(60 s · 2^(n-1), 6 h)` (1, 2, 4, 8 y 16 min; tope de 6 h). Con `maxAttempts` (5) agotados el `Job` queda `FAILED` y se abre una alerta crítica `JOB_FAILED`. El reintento de un hueco anterior se recoge aunque ya haya empezado otro.
- **Alertas de operación (`OpsAlert`)**: es lo que leerá la consola del Super-Admin (Sprint 5). Una alerta por problema (`dedupeKey`): repetirlo cuenta una ocurrencia más, no abre otra; y las que describen un estado (facturas atascadas, ventanas por vencer, devoluciones sin resolver) se cierran solas cuando el problema desaparece. El detalle nunca lleva datos personales. `AuditLog` no vale para esto: es inmutable y no tiene estado «abierta/resuelta».
- **Devoluciones rechazadas**: `MASS_REFUND` usa la propia alerta `REFUND_REJECTED` como contador. Cada rechazo definitivo de Paycomet suma una ocurrencia y la espera siguiente es `10 min · 2^(n-1)` (10, 20, 40 y 80 min entre los 5 intentos, unas 2,5 horas), siempre múltiplo del intervalo de la tarea (con una espera menor que los 10 minutos entre ejecuciones, no esperaría nada). Con 5 fallos se deja en la consola sin volver a intentarlo hasta que una persona la reactive (`reactivateRejectedRefund`, auditada). Los fallos propios (IP del servidor sin configurar, que se comprueba antes de empezar) **no** gastan intentos de nadie: hacen fallar la tarea, que se reintenta con su propia espera. El fallo interno de una aportación concreta sí cuenta como intento suyo (una aportación rota se aparta tras 5 y no hace fallar la tarea para siempre); la tarea solo falla si ninguna avanzó, lo que apunta a un problema general. El plazo de 240 s es de toda la llamada, no de cada ejecución. Un resultado desconocido no se reintenta nunca: queda en `REFUND_STUCK` hasta que una persona lo resuelva con `resolveUnknownRefund`. La tarea deja de empezar devoluciones a los 240 s (la función de Vercel vive 300 s). Al cerrar una iniciativa `REFUNDED`, si en su hucha queda dinero (patrocinio o Auto-Impulso, que esta tarea no devuelve) abre `ESCROW_LEFTOVER`.
- **IP de las devoluciones**: la API de Paycomet pide la «IP de la aplicación del negocio». Se lee del ajuste de la consola `paycomet.serverIp`; en el simulador basta `127.0.0.1`, y con `sandbox` o `live` sin configurar la tarea falla a propósito.
- **Conciliación**: se compara cobro a cobro (importe y `AuthCode`) desde la última conciliación buena (marca `reconciliation.lastWindowEnd` en `PlatformSetting`) y, como mínimo, las últimas 48 h; tras una caída larga recupera hasta 14 días. Se ignoran las últimas 3 horas. Usa `POST /v1/payments/search` de Paycomet (operación 1, resultado correcto, tope de 10.000 por consulta): si una consulta alcanza el tope, se parte el rango por la mitad hasta que cabe, y si un tramo mínimo sigue truncado la tarea falla en vez de conciliar con datos recortados. La marca solo avanza si la conciliación termina bien. Se **asume UTC** en las fechas de Paycomet, como en sus notificaciones (la especificación no dice la zona horaria; de ahí el margen de 3 h), y está **sin probar contra el sandbox real**. Además comprueba que `PSP_CLEARING` no sea negativo y que `Initiative.raisedCents` coincida con el libro mayor. **Solo concilia cobros**: las devoluciones y los repartos no se consultan a Paycomet todavía (ficha 6.1).
- **Ficheros** (`src/services/storage/`): Supabase Storage por su API REST (sin SDK, tras la interfaz `StorageProvider`). El tipo de cada fichero sale de sus primeros bytes y debe coincidir con el declarado y con la extensión; no se admite SVG ni HTML. Públicos (imágenes) y privados (PDF, imágenes y el Modelo 182) van a cubos distintos y los privados se sirven con `Cache-Control: private, no-store`. Los documentos que la ley obliga a conservar (KYB, facturas, certificados, Modelo 182) **exigen `retainUntil`** al subirse. Abrir un privado (`getFileUrl`) pasa por la guardia de entidades: solo `DIRECTOR` y `COSIGNER` de **su** entidad o el Super-Admin, con registro de lo denegado; quien no es de la entidad recibe `404`, y un privado sin entidad solo lo abre el Super-Admin. La URL firmada vive 5 minutos (tope 15). Sin credenciales y fuera de producción se usa un almacén en memoria. **Pendiente:** las imágenes públicas conservan sus metadatos EXIF (ubicación, modelo del móvil); hay que reescribirlas sin ellos antes de publicarlas (Sprints 3.6 y 4.4).
- **Observabilidad**: `@sentry/node` (no `@sentry/nextjs`, cuyo complemento de compilación arrastra paquetes con vulnerabilidades conocidas), solo en servidor y solo errores. Antes de enviar se elimina la petición, el usuario, las migas de pan, los datos extra, el nombre de la transacción (lleva la dirección real) y las variables de la pila, y `redactText` (`src/lib/redact.ts`) limpia emails, NIF/NIE/CIF, IBAN, teléfonos, tarjetas, IPv4/IPv6, JWT y cadenas largas aleatorias dentro de los textos. Los patrones están acotados y el texto se recorta a 4.000 caracteres antes de limpiarlo (un mensaje enorme no puede bloquear el servidor: con el patrón anterior, 50.000 caracteres tardaban 2,6 s). Los nombres y direcciones no tienen patrón: **no se ponen datos de personas en los mensajes de error**. El mismo limpiador se aplica a `Job.lastError` y a la alerta.

---

## 8. Lista de preproducción (Sprint 6.1 · `QA-OPS03`)

- [ ] Entornos `preview` y `production` separados, con bases de datos distintas.
- [ ] Copias de seguridad diarias + recuperación a un punto en el tiempo, **probadas con una restauración real**.
- [ ] Rol `korum_app` creado con `prisma/sql/runtime-role.sql`; `DATABASE_URL` lo usa y se comprueba que con él fallan `UPDATE` sobre `LedgerJournal`, `ALTER TABLE ... DISABLE TRIGGER` y `SET session_replication_role`.
- [ ] Cron configurados y visibles en la consola con su última ejecución.
- [ ] SPF, DKIM y DMARC validados; prueba de entrega a Gmail, Outlook e iCloud.
- [ ] Alertas de Sentry y del fallo de conciliación activas.
- [ ] Pago, reparto, reembolso y contracargo probados en el sandbox real de Paycomet.
- [ ] Search Console y Bing Webmaster Tools verificados; sitemap enviado.
- [ ] Textos legales publicados en los 3 idiomas y visto bueno del abogado.
- [ ] `docs/MANUAL_OPERACION.md` escrito.
