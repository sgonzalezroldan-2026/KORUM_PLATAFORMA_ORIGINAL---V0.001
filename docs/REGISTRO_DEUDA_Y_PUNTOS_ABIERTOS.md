# Registro maestro de deuda y puntos abiertos

> **Qué es:** la lista única, completa y ordenada de todo lo que queda por hacer, decidir o gestionar hasta cerrar el piloto. Reúne los puntos P1–P26 (barrido del 2026-11-17), los puntos N1–N20 que salieron de la revisión legal y fiscal del promotor (2026-11-17 y 2026-11-18), la lista legal de [CUMPLIMIENTO §9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) y la lista de preproducción de [DECISIONES_TECNICAS §8](DECISIONES_TECNICAS.md).
> **Rehecho el 2026-11-18**, tras el traslado de las decisiones del promotor a los documentos que mandan. **Quién lo mantiene:** el asistente, al cerrar cada sprint; el promotor marca lo que decide o gestiona.
> **Fuente única:** el detalle técnico y legal de cada punto sigue en su documento de origen (se enlaza). Aquí está el **qué, quién, cuándo y dónde se resuelve**. El orden de ejecución y las fichas están en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md) («Orden de trabajo vigente»).
> **Regla de este registro (Regla 04 §5):** ningún punto queda sin destino. Cada uno tiene un sprint, una sesión, un dueño fuera del código (el promotor o un tercero) o está cerrado. Un sprint no deja «heredados» sin sprint de destino.

---

## 1. Cómo leerlo

| Marca | Significado |
| :--- | :--- |
| **Criticidad** 🔴 | Bloquea cobrar dinero real o deja un riesgo de seguridad o de dinero abierto |
| 🟠 | Bloquea abrir el piloto a familias reales o la preproducción |
| 🟡 | Importante, pero no bloquea |
| 🟢 | Menor o cosmético |
| **Complejidad** S / M / L / XL | S = menos de media sesión · M = una sesión o sprint corto · L = un sprint completo · XL = varios sprints |
| **Dueño** | **Promotor** (decide o gestiona) · **Externo** (Paycomet, proveedor de Veri\*factu, empresa de pruebas, persona nativa) · **Claude** (código y documentos) · **Mixto** |

**Quién valida lo legal y lo fiscal:** el promotor ([CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md), decisión 45). Toda pregunta nueva para un tercero se le plantea primero a él; si no puede resolverla, se anota en [CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md](CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md).

---

## 2. Resumen en cifras (2026-11-18)

- **46 puntos:** P1–P26 (P10 está hecho y P16 no se usó: 24 vivos, con P2 partido en cuatro) y **N1–N20**, más los sprints 6.1 y 6.2.
- **144 puntos legales y fiscales** (`L-001`–`L-144`, [Anexo A](#anexo-a--los-144-puntos-legales-y-fiscales-uno-a-uno)): **92 resueltos o decididos** por el promotor y **52 abiertos**. De los abiertos, **48 son cambios pequeños en la aplicación**, cada uno con su sprint; **3 dependen de Paycomet** (`L-041`, `L-061`, `L-071`) y **1 de Veri\*factu** (`L-026`).
- **Consultas a terceros:** a Paycomet, **21 preguntas** (12 bloquean los primeros cobros reales); a los proveedores de Veri\*factu, **8** (no bloquean hasta su sprint); al abogado, **1**, y a la asesoría, **3**, que no bloquean nada (N20). Están redactadas en [CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md](CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md).
- **Trabajo de código hasta la preproducción:** 28 sesiones (sprints 5.10 a 5.24 y las sesiones T1, D1 y R1), entre 150 y 190 horas estimadas. Después, el bloque de producto (5.25 a 5.29 y la revisión de nativo) y la fase 6.
- **Lo que el código todavía no aplica** (decidido, pendiente de construir): la retirada de las rifas (5.12), los vales (5.14), los comercios en dos modos (5.16), el IVA incluido (5.20), el Auto-Impulso siempre visible y compensado en el reparto (5.21), la liquidación solo a la entidad (5.19) y Mi Hucha apagada (5.15).
- **Verificado en el código el 2026-11-17 y aún sin hacer:** no hay trámite para cambiar el email ni autoría de las consultas; no existen las páginas públicas de los textos legales; no se registra la aceptación del contrato de encargo en el alta; la analítica no está conectada; no hay protección contra la indexación de la preproducción; `docs/MANUAL_OPERACION.md` no existe.

---

## 3. Trazabilidad: dónde se resuelve cada punto

### 3.1 Puntos P (barrido del 2026-11-17)

| Punto | Qué es | Crit. | Dueño | Dónde se resuelve |
| :--- | :--- | :-: | :--- | :--- |
| **P1** | Proveedor de pagos definitivo: Paycomet u otro | 🔴 | Promotor | Decisión del promotor, antes de enviar P2a |
| **P2a** | Paycomet: 21 preguntas (12 bloquean el 6.1), credenciales de pruebas y contrato | 🔴 | Promotor + Externo | El promotor las envía justo antes del 6.1; se comprueban en el 6.1b |
| **P2b** | Veri\*factu: 8 preguntas y precios de proveedores | 🔴 | Promotor + Externo | El promotor pide ya los precios; proveedor o envío directo se decide al abrir el 5.23 |
| **P2c** | Abogado | — | Promotor | **Cerrado:** decidido por el promotor; queda 1 consulta que no bloquea (N20) |
| **P2d** | Asesoría fiscal | — | Promotor | **Cerrado:** decidido por el promotor; quedan 3 consultas que no bloquean (N20) |
| **P3** | Presupuesto de producción, con seguros | 🟠 | Promotor | Gestión del promotor, antes del 6.1 |
| **P4** | Rendimiento y escalabilidad | 🟡 | Claude | Sprint 6.1d |
| **P5** | Rediseño visual profundo: decidir sí o no | 🟡 | Mixto | SESIÓN V1; si es que sí, Sprint 5.28 |
| **P6** | Revisión crítica externa | 🟠 | Externo | Tras el 6.1c; lo que se elija, en el Sprint 6.1e |
| **P7** | Prueba de intrusión y de carga | 🔴 | Externo | Tras el 6.1c; sus hallazgos, en el Sprint 6.1e |
| **P8** | Documentación sin Gemini | 🟢 | Claude | Sprint 5.24b (las fichas nuevas ya no lo citan) |
| **P9** | Acceso a la demo: experiencia y nota del README | 🟢 | Mixto | Sprint 5.24b |
| **P10** | Sprint 5.9 | — | — | **Hecho** (2026-11-17) |
| **P11** | Revisión de la landing, con el mensaje de valor | 🟡 | Promotor + Claude | Sprint 5.29 |
| **P12** | Revisión crítica de producto | 🟡 | Claude | SESIÓN R1 (informe) y Sprint 5.25 (lo que se elija) |
| **P13** | Gamificación | 🟡 | Claude + Promotor | Sprint 5.27 |
| **P14** | Dominio, datos de la empresa, cuentas de servicio y correo del dominio | 🔴 | Promotor | Gestión del promotor, antes del 6.1a |
| **P15** | Entidades piloto y su acuerdo | 🟠 | Promotor | Gestión del promotor, desde ya; se usa en el 6.2 |
| **P17** | Cumplimiento en el código | 🔴 | Claude | Sprints 5.10a, 5.10b y 5.10c |
| **P18** | Endurecimiento previo al despliegue | 🔴 | Claude | Sprints 5.11a y 5.11b (el Modelo 182, en el 5.22) |
| **P19** | Medición del negocio | 🟠 | Claude | Sprint 5.26 |
| **P20** | Revisión de nativo de catalán e inglés | 🟠 | Promotor + Externo | SESIÓN I1, con los textos congelados |
| **P21** | Accesibilidad real con lector de pantalla y teclado | 🟠 | Promotor | Prueba del promotor tras el 6.1c; correcciones en el 6.1e |
| **P22** | Higiene de claves: rotar la clave de Stitch | 🟠 | Promotor | Gestión del promotor, **hoy** |
| **P23** | Verificación de la deuda heredada | 🟡 | Claude | Sprint 5.10c |
| **P24** | Monedero con saldo de Mi Hucha | — | — | **Descartado** (2026-11-18): KORUM no guardará saldo. El modo se retira del código en el Sprint 5.24b |
| **P25** | Decisiones pequeñas que quedan (5) | 🟠 | Promotor | SESIÓN D1 |
| **P26** | Deuda menor y cosmética | 🟢 | Claude | Sprint 5.24b (la tarifa guardada de la taquilla, en el 5.18) |
| **6.1** | Preproducción, con las 11 casillas de DECISIONES §8 | 🔴 | Claude + Promotor | Sprints 6.1a, 6.1b y 6.1c |
| **6.2** | Piloto con 3 entidades | — | Mixto | Sprint 6.2 |

### 3.2 Puntos N (revisión legal y fiscal del promotor)

| Punto | Qué es | Crit. | Dueño | Dónde se resuelve |
| :--- | :--- | :-: | :--- | :--- |
| **N1** | Textos legales, contrato de encargo, evaluación de impacto y tabla de plazos; los valida el promotor | 🔴 | Claude + Promotor | SESIÓN T1; se publican en el 5.10a |
| **N2** | Retirada de las rifas | 🔴 | Claude | Sprints 5.12a y 5.12b |
| **N3** | Vales | 🟠 | Claude | Sprints 5.14a, 5.14b y 5.14c |
| **N4** | Comercios en dos modos | 🔴 | Claude | Sprints 5.16a, 5.16b y 5.16c |
| **N5** | IVA incluido y facturas | 🔴 | Claude | Sprints 5.20a y 5.20b |
| **N6** | Veri\*factu | 🔴 | Claude + Promotor | Sprint 5.23 |
| **N7** | Campañas: devolución automática a los 14 días | 🔴 | Claude | Sprint 5.17 |
| **N8** | Entradas: liquidar por lo vendido, cancelación y cambio de fecha | 🔴 | Claude | Sprint 5.13 |
| **N9** | Tarifas: todo cambio a 30 días y tarifa guardada al publicar | 🟠 | Claude | Sprint 5.18 |
| **N10** | Auto-Impulso: siempre visible, compensado en el reparto y 💎 sin IVA | 🔴 | Claude | Sprint 5.21 |
| **N11** | Liquidación solo a la cuenta de la entidad y entrega automática | 🔴 | Claude | Sprint 5.19 |
| **N12** | Firma única: frase, cláusula y aviso de cada liberación | 🟠 | Claude | Sprint 5.19 (la cláusula, en la SESIÓN T1) |
| **N13** | Mi Hucha apagada al lanzar, condiciones propias y devolución de la gestión | 🟠 | Claude | Sprint 5.15 |
| **N14** | Aportación voluntaria sin IVA ni factura y enlace de devolución de 14 días | 🟠 | Claude | Sprint 5.15 (el IVA, en el 5.20a) |
| **N15** | Aceptación: una línea junto al botón, versión guardada y resumen en el recibo | 🔴 | Claude | Sprint 5.15 (la casilla de comercios, en el 5.16b) |
| **N16** | Privacidad: copia de «mis datos» con rastros y desvinculación a los 12 meses | 🟠 | Claude | Sprint 5.10b |
| **N17** | Colegios con ánimo de lucro: solo entradas y vales | 🟠 | Claude | Sprint 5.22 |
| **N18** | Modelo 182 contra el diseño oficial y en el entorno de pruebas de la Agencia Tributaria | 🔴 | Claude + Promotor | Sprint 5.22 (hace falta el certificado digital del promotor) |
| **N19** | Los 53 cambios pequeños y los retoques de los puntos R | 🟠 | Claude | 48 repartidos por sprint (ver §3.3) y 5 sin objeto |
| **N20** | Cuatro consultas para más adelante, sin bloquear nada | 🟢 | Promotor | Cuando el promotor quiera; redactadas en las partes 1 y 2 de CONSULTAS |

### 3.3 Los 52 puntos legales abiertos, por destino

| Destino | Puntos |
| :--- | :--- |
| Sprint 5.10a | `L-057`, `L-020` (primera capa) |
| Sprint 5.10b | `L-010`, `L-011`, `L-015`, `L-053`, `L-064` |
| Sprint 5.10c | `L-004`, `L-005`, `L-007`, `L-018`, `L-042`, `L-045`, `L-049`, `L-054`, `L-059` |
| Sprint 5.13 | `L-123`, `L-124`, `L-130`, `L-134` |
| Sprint 5.15 | `L-016`, `L-020` (línea de aceptación) |
| Sprint 5.16b | `L-040`, `L-081`, `L-082`, `L-088` |
| Sprint 5.16c | `L-037`, `L-038`, `L-039`, `L-078`, `L-079`, `L-087`, `L-089`, `L-090` |
| Sprint 5.17 | `L-112`, `L-113` |
| Sprint 5.18 | `L-056`, `L-096` |
| Sprint 5.21 | `L-022` |
| Sprint 5.22 | `L-028`, `L-030`, `L-032` |
| Sprint 5.23 | `L-026` (Veri\*factu), `L-141` |
| Sprint 5.24a | `L-008`, `L-035`, `L-097`, `L-102`, `L-115`, `L-121` |
| Paycomet (P2a) | `L-041`, `L-071`, `L-061` (se comprueba en el 6.1b) |

**Cinco cambios pequeños quedan sin objeto** y se cierran: `L-072`, `L-095`, `L-129` y `L-132` (rifas retiradas) y `L-100` (pago al proveedor aplazado). **Retoques de puntos R ya asignados:** `L-051` y `L-055` (5.10c), `L-067` (5.10b); `L-105` queda sin objeto mientras el pago al proveedor siga aplazado.

### 3.4 Lo que antes estaba «heredado» en la ficha del 6.1

| Qué | Dónde se resuelve ahora |
| :--- | :--- |
| Identificador por petición y cadena de huellas de la auditoría | Sprint 5.11a |
| Secretos de ejemplo; cifrado del `token` y el `otp` de la cola de emails | Sprint 5.11a |
| Subida directa con URL firmada; topes en el borde; IP de confianza (preparación) | Sprint 5.11b; su comprobación con infraestructura real, en el 6.1a |
| Doble reembolso (`clearRefundClaimInTx`) y conciliación de devoluciones y repartos | Sprint 5.11b; contra Paycomet real, en el 6.1b |
| `pg@9` y concurrencia con PostgreSQL real | Sprint 5.11b |
| Modelo 182: campañas sin resolver, diseño vigente, complementaria | Sprint 5.22 |
| Veri\*factu: proveedor, adaptador, NIF del destinatario, QR y remisión | Sprint 5.23; su entorno de pruebas, en el 6.1b |
| Tabla de plazos y cómo se ha construido la purga | SESIÓN T1 (la valida el promotor) |
| Textos legales publicados en los tres idiomas | Sprint 5.10a y SESIÓN I1 |
| Entornos, copias, rol `korum_app`, cron, cubos, Sentry, cookie por HTTPS, rotación de claves | Sprint 6.1a |
| Entorno de pruebas de Paycomet, página de pago, Bizum, `AuthCode`, borrado de tarjetas, email real, SPF, DKIM y DMARC | Sprint 6.1b |
| Search Console, Bing, IndexNow, tarjetas, cámara y audio en móviles reales, manual de operación y simulacro | Sprint 6.1c |

**Mejoras posteriores, fuera del alcance hasta el piloto** (no son deuda: no se construyen salvo decisión expresa): el pago directo al proveedor (`PROVIDER`, con `L-100`, `L-104` y `L-105`), si Paycomet lo ofrece con verificación del titular; un adaptador SMTP además de Brevo; fotografías reales de ambiente, si se decide en la SESIÓN D1.

---

## 4. Detalle de cada punto

### P1 · Proveedor de pagos definitivo · 🔴 · decidir S / cambiar L · Promotor
- **Decidir entre Paycomet y otro** (p. ej. Mangopay). Cambiar de proveedor no es meter credenciales: hay que escribir un adaptador de `PaymentProvider` (≈ un sprint medio con pruebas y revisión legal) y revisar lo ligado a Paycomet: ventana de 90 días, duración máxima de campaña (60), devoluciones, reparto por cobro (*split*), `REGULATED_WALLET`, notificaciones y conciliación.
- **Por qué va primero:** P2a, P3 y buena parte del 6.1 dependen de esta decisión. Si se queda Paycomet, P1 se cierra en una conversación; si se cambia, hay que hacerlo antes de gastar tiempo en las preguntas a Paycomet.
- **Origen:** plan P1; CUMPLIMIENTO §2 y §3.
- **Destino:** decisión del promotor, antes de enviar las preguntas a Paycomet (P2a).

### P2 · Gestiones externas · 🔴 · Promotor + Externo
Estado tras la revisión del promotor (2026-11-17 y 2026-11-18). El borrador final, con su visto bueno, está en [CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md](CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md).

- **P2a · Paycomet.** **21 preguntas** (parte 3 de CONSULTAS): 12 bloquean los primeros cobros reales y 9 no. El promotor las envía **justo antes del 6.1**, junto con la petición de credenciales de pruebas y el contrato. Lo que se supone mientras tanto: retención hasta 90 días y reparto solo si se llega a la meta; un reparto por cobro; reparto desde otra campaña de la misma entidad; devoluciones hasta 81 días tras el cobro (de aquí dependen los 14 días de espera); devoluciones parciales; alta y verificación de las entidades; contracargos y sus pruebas; y la venta de vales. Las siete de la aportación mensual siguen en la lista, pero no bloquean los primeros cobros porque Mi Hucha sale apagada. **Ya no se pregunta:** el pago al IBAN de un tercero (aplazado), los monederos con saldo (descartados), la redacción y el logotipo (se le menciona solo por su nombre) ni cómo financiar el Auto-Impulso (se compensa en el reparto).
- **P2b · Veri\*factu.** **8 preguntas** a los candidatos a proveedor (parte 4 de CONSULTAS). El promotor pide ya los precios; al abrir el Sprint 5.23 se comparan las dos vías (un proveedor, con coste por factura, o el envío directo a la Agencia Tributaria con el certificado digital de KORUM) y elige. Se cuenta con la obligación desde la primera factura real (antes del 1-1-2027 para sociedades).
- **P2c · Abogado: cerrado.** Todas sus preguntas quedan decididas por el promotor. Guarda **una** para consultarla más adelante sin que bloquee nada: el riesgo que le queda a KORUM con la firma única (N20).
- **P2d · Asesoría fiscal: cerrado.** Todas sus preguntas quedan decididas por el promotor. Guarda **tres** que no bloquean (N20): la aportación voluntaria sin IVA, el año del donativo «todo o nada» y si el Auto-Impulso es gasto deducible.
- **Prerrevisión y decisiones:** [PRERREVISION_LEGAL_Y_FISCAL.md](PRERREVISION_LEGAL_Y_FISCAL.md) (dictamen de los 144 puntos y, en su §3.1, cada decisión del promotor).

### P14 · Dominio, datos de la empresa y cuentas de servicio · 🔴 · S · Promotor *(tema nuevo)*
Junta cosas que hoy están repartidas en ocho sitios y que el 6.1 necesita todas a la vez:
- **Dominio definitivo** (fija `NEXT_PUBLIC_APP_URL`, que hoy vale `localhost`: de ahí salen las canónicas, `hreflang`, sitemap, `llms.txt` y las tarjetas sociales).
- **Datos de la empresa** en `/admin/ajustes`: **NIF y razón social emisores** (sin el NIF un patrocinio con fee no se asienta), correo de soporte y de privacidad (el buzón de la declaración de accesibilidad), clave `seo.indexNowKey`.
- **Cuentas:** Vercel **Pro** (el gratuito prohíbe uso comercial: obligatorio antes del primer cobro), Supabase UE, Brevo u otro email, Sentry UE, analítica, protección en el borde.
- **Correo del dominio:** SPF, DKIM, DMARC y prueba de entrega a Gmail, Outlook e iCloud.
- **Origen:** DECISIONES §8, ficha 6.1, bitácora 2.4, 2.6, 5.4, 5.5b.
- **Destino:** gestión del promotor, antes del Sprint 6.1a.

### P3 · Presupuesto de producción · 🟠 · S · Promotor
Validar con precios reales y decidir el plan de cada servicio. Estimación de partida: **100–250 €/mes** de infraestructura y **5.000–20.000 €** puntuales (abogado, asesoría, prueba de penetración, revisión de nativo, seguros). Valorar planes gratuitos en el piloto y alternativas «todo en uno» (Firebase no sirve: base NoSQL, habría que reescribir el libro mayor). Incluir **seguros** (responsabilidad civil, ciber) y el coste de P6 y P7. Origen: plan P3.
- **Destino:** gestión del promotor, antes del Sprint 6.1a.

### P17 · Sprints 5.10a, 5.10b y 5.10c · Cumplimiento en el código · 🔴 · L · Claude
Todo lo que el código debe tener antes de que existan cobros reales y que hoy no está (verificado). Fichas en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).
1. **5.10a:** páginas públicas de los textos legales en es/ca/en con archivo de versiones (`L-057`); primera capa de privacidad en cada formulario; aceptación registrada del contrato de encargo y de las condiciones en el alta; antiindexación de todo lo que no sea producción.
2. **5.10b:** trámite verificado para cambiar el email de una cuenta y autoría de las consultas (`senderUserId`); copia de «mis datos» con los rastros de seguridad y desvinculación a los 12 meses (N16); textos de la supresión; plazos que faltan; purgas pendientes (altas sin verificar en 7 días, auditoría, ficheros públicos retirados).
3. **5.10c:** firma única también en el alta; KYB al publicar; documento de identidad de quien representa; invitación, relevo y consola; buzón de ideas (cookie, huella, firmas en revisión); retoques de los puntos R; y la verificación de la deuda heredada (P23).

### P18 · Sprints 5.11a y 5.11b · Endurecimiento previo al despliegue · 🔴 · L · Claude
Lo técnico que es mejor tener hecho antes de tocar infraestructura real.
1. `env.ts` rechaza los secretos de ejemplo publicados en `ci.yml` y `playwright.config.ts` antes de cualquier despliegue (también una demo). *5.11a.*
2. **Cifrar** el `token` y el `otp` de `OutboxMessage.payloadJson` (hoy en claro hasta enviarse; las copias de seguridad los conservan). *5.11a.*
3. **Identificador por petición** que enlace auditoría, Sentry y registros del servidor; **cadena de huellas** de la auditoría, comprobada en la conciliación diaria. *5.11a.*
4. **Subida directa con URL firmada** al almacén: el límite de 4,5 MB de Vercel afecta a las fotos de logros (8 MB), las facturas de proveedor (10 MB) y las fotos de más de 4 MB. *5.11b.*
5. **IP de confianza:** confirmar qué cabecera entrega la plataforma elegida; los límites de pago, la regla padre/madre y la ráfaga dependen de ella. *Preparación en el 5.11b; comprobación en el 6.1a.*
6. **Topes de peticiones en el borde** para `/api/entities`, `/api/og/initiative`, `/api/og/entity` y `/api/auth/get-session`. *Preparación en el 5.11b; activación en el 6.1a.*
7. **Reparto y conciliación:** revisar `clearRefundClaimInTx` con el desfase horario real (riesgo de doble reembolso si Paycomet no rechaza devolver de más); ampliar la conciliación a **devoluciones y repartos**. *5.11b.*
8. **Modelo 182 con campañas sin resolver:** resuelto por la decisión 28 (solo entran las campañas conseguidas). *Sprint 5.22.*
9. **`pg@9`:** pasar la integración con `pg@9` y usar `relationLoadStrategy: 'join'` en lecturas dentro de transacciones. *5.11b.*
10. **Validar con PostgreSQL real** la concurrencia de las funciones que solo se han revisado leyendo código (`reserveTickets`, `checkInPass`, `openGateSession`, `issueInvoice`, `signIdea`, `requestSignature`, `completeSignature` y el canje de vales; ya sin el sorteo). *5.11b.*

### P22 · Higiene de claves · 🟠 · S · Promotor *(tema nuevo, hacer hoy)*
La bitácora del Sprint 3.9 recoge que la línea de comandos de un proceso `mcp-remote` de **Stitch** muestra una **clave de API en claro**: conviene rotarla. No consta que se hiciera. Si ya no usas Stitch, retirarlo. Revisar de paso qué otras claves se han escrito en conversaciones (la bitácora cita una clave de la base local «dada en la sesión»: es de una base local, pero conviene cambiarla si el equipo sale de casa).
- **Destino:** gestión del promotor, hoy.

### P25 · SESIÓN D1 · Decisiones pequeñas que quedan · 🟠 · S · Promotor
Una sesión corta, con el formato «qué pasa hoy, ejemplo, opciones, recomendación»:
1. **Gestión de Mi Hucha frente al coste de la pasarela:** con los valores por defecto (0,25 € de gestión; pasarela 1 % + 0,09 €) el aviso ya es crítico desde unos 16–25 € al mes. Como Mi Hucha sale apagada, puede dejarse para cuando se encienda, con los precios reales de P1.
2. **¿Puede el Super-Admin intervenir en la portería?** Hoy no entra ni crea PIN. *Destino: Sprint 5.13.*
3. **Chat de soporte del centro:** hoy no puede contestar dos veces ni reabrir una consulta resuelta. *Destino: Sprint 5.24a.*
4. **Fotografías de ambiente:** se sustituyeron por ilustraciones vectoriales. Decidir si bastan o si se usarán fotos reales de las entidades piloto (con permisos y sin menores identificables).
5. **Revisión cruzada con otro modelo:** si se quiere, y en qué sprints.

**Ya decididas y fuera de esta lista:** el evento de taquilla que llega a su fecha sin agotar el aforo (decisión 30), el aviso por email al cambiar una tarifa global (decisión 34) y el Auto-Impulso en taquilla (decisión 33).

### P15 · Entidades piloto y su acuerdo · 🟠 · M · Promotor
El 6.2 necesita **3 entidades reales con KYB real**. Incluye: elegir cuáles (un colegio, un club y una entidad cultural si se quiere probar las tres verticales), acuerdo de piloto (qué se promete, qué no, duración, soporte), contrato de encargo aceptado (sale de la SESIÓN T1), alta acompañada, **primera campaña de presupuesto y primera taquilla o venta de vales** (ya sin rifa), y qué se mide (depende del Sprint 5.26). También fotos reales si se decide así en la SESIÓN D1.

### P12 · Revisión crítica de producto · 🟡 · M · Claude *(punto pedido por el promotor)*
Un repaso crítico de toda la aplicación **poniéndolo todo en cuestión** para proponer mejoras de negocio, control, automatismos, simplificación de UX, textos y diseño. Entrega: informe con una tabla común (pantalla o flujo, problema o idea, impacto en negocio, esfuerzo, riesgo, recomendación) y una propuesta de qué entra y en qué sprint. **Va antes de P13, P5 y P11** porque sus conclusiones los alimentan. Lo ejecutan, con contexto separado, `ux-school-director-reviewer` y `korum-community-target-psychologist`, y lo sintetizo yo; después tú decides qué entra.
- **Hipótesis iniciales a validar** (no son decisiones; salen de este barrido):
  1. **Medición:** hoy el embudo de aportación no se mide (ver P19). Sin eso no se puede mejorar la conversión.
  2. **Panel de la entidad con «siguiente mejor acción»:** firma pendiente, campaña que vence en 7 días sin llegar a la meta, agradecimiento pendiente, fotos Antes/Después sin subir.
  3. **Cuadro de control del promotor:** embudo de entidades (alta → KYB → primera campaña → primera meta → renovación), entidades inactivas 60 días, campañas con riesgo de fracaso y salud de precios ya existe.
  4. **Automatismos de crecimiento:** cartel QR y tarjetas de WhatsApp ya existen; faltan bucles de «lleva KORUM a otro colegio» y recordatorio de compartir en las últimas 72 h de una campaña.
  5. **Simplificar el alta:** valorar aplazar el KYB hasta la primera publicación y no pedir lo que luego no se guarda (el teléfono del cofirmante).
  6. **Memoria del curso:** informe anual automático de la entidad (lo conseguido, cifras, fotos) útil para su asamblea; retención.
  7. **Reducción de soporte:** autoservicio para los casos repetidos (reenviar enlace de voto ya existe; faltan cambio de email, recibos, entradas).
  8. **Coherencia de textos:** un solo glosario aplicado por pruebas (la vigilancia de catálogos ya existe).
  9. **Control financiero:** alertas de conciliación y ratios de contracargos y devoluciones en el cuadro de mandos.
- **Destino:** SESIÓN R1 (informe) y Sprint 5.25 (lo que el promotor elija).

### P19 · Medición del negocio · 🟠 · M · Claude *(tema nuevo, verificado)*
EXPERIENCIA §9 define las métricas del piloto (conversión del checkout ≥ 35 %, tiempo mediano hasta pagar ≤ 15 s, activación de la aportación voluntaria, % de campañas logradas, tiempo de la doble firma…) y promete eventos de Plausible. **En el código no hay ni script ni eventos.** Alcance: conectar Plausible con consentimiento y sin datos personales, eventos del embudo, métricas de negocio desde la base de datos, y una pantalla en la consola. Necesita P14 (dominio) para configurarse del todo. Sin esto, el seguimiento diario del piloto (6.2) se haría a ciegas.
- **Destino:** Sprint 5.26.

### P13 · Gamificación · 🟡 · L · Claude + Promotor *(punto pedido por el promotor)*
Mejorar la experiencia de familias, comercios y entidades con mecánicas de juego **dentro de las reglas de la casa**: sin presión social, sin ranking de personas, sin señalar a quien no aporta, sin importes por curso, sin copiar instituciones (Regla 03 §0 y §6), con `prefers-reduced-motion` y accesible.
- **Lo que ya existe y se puede aprovechar:** medallas Bronce, Plata y Oro de la entidad (kit y beca), retos por curso en positivo, sellos de mérito, pegatinas, celebraciones al firmar y al conseguir un reto, galería Antes/Después, Matching 2x.
- **Direcciones a explorar (propuestas, a decidir tras P12):**
  - **Familias:** «Cuaderno» personal con sellos por cada campaña apoyada; capítulo por curso escolar; hitos de la comunidad (no de personas); sello de constancia en Mi Hucha por meses seguidos, solo visible para la propia persona; «Yo ayudé a…» para compartir con permiso explícito; álbum de logros conseguidos.
  - **Entidades:** lista de **primeros pasos** con progreso (alta → KYB → firmantes → primera idea → primera campaña → primera liquidación con Antes/Después); camino a la **siguiente medalla** con lo que falta; «sello de entidad al día» por liquidar a tiempo y subir fotos; memoria del curso (ver P12).
  - **Comercios:** distintivo visible por categoría, sin importes (ya es regla), con antigüedad y renovación celebrada.
- **Límites a vigilar:** nada que parezca un sorteo o un incentivo económico encubierto (las rifas se han retirado de la plataforma); nada que premie dar más dinero; cualquier ventaja con coste (como la beca de medalla) se decide contigo; privacidad por defecto.
- **Salida:** propuesta con 2–3 mecánicas, maqueta y métricas de éxito (P19) antes de construir; se construye en 1–2 sprints.
- **Destino:** Sprint 5.27.

### P5 · Rediseño visual profundo · 🟡 · XL · Mixto
Entre el 5.9 y el 6.1: tres propuestas en maqueta interactiva de 3 pantallas (portada de entidad, ficha con checkout, panel de la entidad); eliges o mezclas; se aplica primero por tokens (`globals.css`) y luego pantalla a pantalla. Si cambia la marca: actualizar `korum-brand-design-system` y la Regla 03 en `.agents/` y ejecutar `node scripts/sync-ai-context.mjs`; los E2E de estructura se rehacen. **Recomendación:** decidir **sí o no** después de P12 y P13, porque ambos pueden mover pantallas, y antes de P11 (tus microajustes de la landing se perderían si luego se rediseña). Aviso: la portada de la entidad está a 1,8 KB del tope de JavaScript.
- **Destino:** SESIÓN V1 (decidir sí o no) y, solo si es que sí, Sprint 5.28.

### P11 · Revisión de la landing por el promotor · 🟡 · S–M · Promotor + Claude *(punto pedido por el promotor)*
Tu revisión y ajuste de **textos y mensajes** de la landing y de **microcorrecciones de diseño y visualización**. Método: me pasas lotes («dónde → qué»); los textos van a `messages/{es,ca,en}.json`; los **textos oficiales de la Regla 03 §3 no se tocan sin tu aprobación expresa**; cada lote con capturas a 1440 y 430 px y las puertas por niveles. Puedo preparar una hoja con todos los textos de la landing extraídos de los catálogos para que los repases de una vez. **Va después de decidir P5.** Tras él, los textos nuevos entran en la revisión de nativo (P20).
- **Destino:** Sprint 5.29. Incluye el **mensaje de valor** que pide el promotor para la portada, la página de precios y las preguntas frecuentes: «entras gratis, te vas cuando quieres y solo pagas cuando obtienes resultados».

### P20 · Revisión de nativo ca/en · 🟠 · M · Promotor + Externo
**Casi todos los sprints la dejan pendiente.** Hoy los textos en catalán e inglés los escribió el mismo modelo. Se hace **una sola vez, al final**, cuando P11, P12, P13 y los textos legales estén congelados, para no pagarla dos veces. Incluye: espacios `home`, `nav`, `finder`, `calculator`, `cookies`, `marketing`, `auth`, `registration`, `panel`, `gate`, `admin`, `portal`, `email`, `audit` y los de pase, vales, categorías y expediente; «piggy bank»; «the school» frente a clubes y centros culturales; los nombres de curso de la plantilla (Regla 03 §5), que hoy salen sin traducir en el selector ca/en; y la traducción de los textos legales de la SESIÓN T1.
- **Destino:** SESIÓN I1, una sola vez y con los textos congelados.

### P23 · Verificación de la deuda heredada · 🟡 · S · Claude *(tema nuevo)*
Algunas deudas de sprints antiguos se movieron de ficha en ficha y no sé si siguen vivas. Compruebo en código y las tacho o las llevo a su sitio: KYB exigido al publicar; purga de altas sin verificar; email de la entidad desde la ficha 360º; verificación de documentos KYB con `org.kybStatus`; liberar un CIF ocupado; aviso al caducar un relevo; listado de campañas al 0 % por candado semántico; avisos de reembolso rechazado y de factura atascada; `completedThisYear` (contador de demostración) y `medalGrantUsedInTitle` al cancelar una campaña; metas de la semilla; adaptador SMTP (hoy solo Brevo). Se hace en el Sprint 5.10c: cada punto se corrige allí o sale con su sprint.
- **Destino:** Sprint 5.10c.

### P8 · Imágenes y animaciones las hace Claude · 🟢 · S · Claude
Decidido el 2026-11-16. Falta ejecutar: actualizar la guía de IA §5, la Regla 04 §3.4, `CLAUDE.md`, la skill de marca y las fichas del plan que citan Gemini («Gemini Argon» para revisión de nativo y 6.1, «Gemini Flash» como alternativa de modelo; hay 53 menciones repartidas en `AGENTS.md`, la Regla 04, el plan y la guía), y ejecutar `node scripts/sync-ai-context.mjs`. Límite honesto: Claude no genera fotografías ni ilustraciones en mapa de bits (ver P25.5).
- **Destino:** Sprint 5.24b.

### 6.1 · Preproducción · 🔴 · L · Claude + Promotor · Sprints 6.1a, 6.1b y 6.1c
Ficha completa en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md). Tras los sprints 5.10 a 5.24 queda lo que **solo se puede hacer con infraestructura real**:
- **6.1a · Infraestructura y datos:** entornos `preview` y `production` separados, función en Frankfurt, base en la UE, **copias diarias y recuperación a un punto en el tiempo probadas con una restauración real**, rol `korum_app` (con prueba de que no puede alterar el libro mayor), cron visibles en la consola, cubos `korum-public` y `korum-private` (comprobar que el privado lo es), DSN de Sentry en la UE sin datos personales, alertas, IP de confianza y topes en el borde, cookie `korum_device` por HTTPS y ensayo de la **rotación de `ENCRYPTION_KEY`** (rotar `QR_HMAC_SECRET` invalida todos los pases).
- **6.1b · Pagos y correo reales:** entorno de pruebas de Paycomet (pago, reparto, reembolso y contracargo; página de pago `/v1/form`, idioma `ca`, Bizum sin salir de `*.paycomet.com`; `PSP_RECONCILIATION` contra la API real; `AuthCode` de cada cobro; venta de vales; tarjeta guardada de Mi Hucha si se va a encender); Brevo con una cuenta real; SPF, DKIM y DMARC; entorno de pruebas de Veri\*factu; `/api/cron/*` solo con `CRON_SECRET`.
- **6.1c · Descubribilidad, dispositivos y operación:** Search Console y Bing con el sitemap, resultados enriquecidos, IndexNow con el dominio definitivo y tarjetas en WhatsApp, Facebook y LinkedIn; cámara y audio de la portería y del puesto de vales en iPhone y Android reales; **simulacro de restauración** y **`docs/MANUAL_OPERACION.md`** (pago fallido, contracargo, caída, solicitud RGPD).
- **Las 11 casillas** de [DECISIONES_TECNICAS §8](DECISIONES_TECNICAS.md) se marcan aquí. **Gate:** `QA-OPS03`.
- **Antes de abrirlo:** P1, P2a, P3 y P14 hechos por el promotor.

### P21 · Accesibilidad real · 🟠 · M · Promotor
VoiceOver (iPhone) y TalkBack (Android) en el pago y en la portería, y recorrido entero con teclado (`QA-X02`). Aplazada el 2026-11-14. **Bloquea el piloto (6.2).** Al hacerla, actualizar `/accesibilidad`, que hoy dice «parcialmente conforme». También por comprobar a mano: el foco del alta de 2FA y de la invitación (solo cubierto con pruebas de componente).
- **Destino:** prueba del promotor tras el Sprint 6.1c; lo que encuentre se corrige en el 6.1e.

### P4 · Rendimiento y escalabilidad de datos · 🟡 · M · Claude
Decidido: **medir primero en la preproducción** (LCP, INP, JavaScript inicial, consultas lentas; el servidor de desarrollo no sirve) y optimizar solo lo que salga mal. Incluye la deuda de volumen anotada en los sprints: `loadLedgerPerInitiative` a `GROUP BY` antes de ~50.000 apuntes; `loadBiSnapshot` por una sola fila para el pop-up; propagación de ajustes a las entidades por lotes; cursor en el cierre de donaciones; la pulsación de «Filtrar» con picos de ~230 ms.
- **Destino:** Sprint 6.1d.

### P6 · Revisión crítica externa · 🟠 · M · Externo
Sobre la preproducción y antes del 6.2: dossier con URL, cuentas de prueba y guion por rol; perfiles (UX, producto o negocio, técnico, 5–8 personas reales); tabla común (pantalla, problema, gravedad, propuesta); yo priorizo por impacto y esfuerzo y tú eliges qué entra. **Distinta de P12:** P12 es mía y anterior, P6 es de ojos ajenos.
- **Destino:** tras el Sprint 6.1c; lo que el promotor elija se corrige en el 6.1e.

### P7 · Prueba de intrusión y de carga · 🔴 · M · Externo
Empresa independiente sobre la preproducción (la interna del 5.6 no la sustituye) y prueba de carga con un acto grande (toda la comunidad en la misma wifi). Presupuesto en P3.
- **Destino:** tras el Sprint 6.1c; todo hallazgo de seguridad se corrige en el 6.1e.

### 6.2 · Piloto · L · Mixto
Alta acompañada de las 3 entidades, primera campaña y primera taquilla o venta de vales, seguimiento diario de métricas (Sprint 5.26), registro de incidencias y lista priorizada de mejoras. **Gate:** conciliación diaria sin diferencias durante todo el piloto. Depende de: contrato de Paycomet en producción, KYB real, textos legales publicados, Veri\*factu en marcha, P21 hecha, P15 y los Sprints 6.1d y 6.1e cerrados. **Con su cierre el proyecto se da por terminado.**

### P24 · Monedero con saldo de Mi Hucha · descartado (2026-11-18)
El promotor confirma que **KORUM no guardará saldo**: el modo `REGULATED_WALLET` no se construye ([CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md), decisión 38). Queda una tarea de limpieza con sprint: retirar el modo del esquema, del código, de los ajustes de la consola y de los textos, y con él el aviso oficial de retirada de saldo de la Regla 03 §3. **Destino: Sprint 5.24b.** Mi Hucha queda con dos modos: `DISABLED` (al lanzar) y `PLEDGE`.

### P26 · Deuda menor y cosmética · 🟢 · M · Claude · Sprint 5.24b
Se barre en una sola entrega. Ya no incluye los puntos de rifas, que desaparecen con el Sprint 5.12.
- **Experiencia:** el anillo de foco de las casillas roza el emoji 🛡️ del bloque de aportación voluntaria; aviso de consola «preloaded CSS not used» (del framework); total anunciado a cada pulsación al teclear otro importe (3.4) y resumen de Mi Hucha anunciado a cada pulsación (3.8); la barra de la celebración arranca su valor accesible en el avance anterior; los errores fiscales de Mi Hucha no mueven el foco; el simulador de Mi Hucha no desglosa donación y gestión; el chat solo se refresca al recargar; el bloque de cookie y huella antes de las ideas es demasiado largo; alineación de la navegación con las tarjetas a 1440 px; encabezados de la cabecera de gestión, «tú»/«vosotros», etiqueta genérica de la cofirma y contador en «Aprobaciones» (4.2a).
- **Mi cuenta:** tras suprimir la cuenta siguen visibles llaves e idioma hasta salir; «Dar de alta mi entidad» e «Iniciar sesión» aparecen con sesión iniciada en el cuerpo de la portada; quitar una llave de acceso no pide reautenticación; el historial de aportaciones no se filtra por ejercicio; reservar cupo antes de `requireVerifiedAccount` en la rectificación; los mensajes del alta revelan si un email ya tiene cuenta (limitado a 5 por red y hora); se pide el teléfono del cofirmante pero no se guarda.
- **Dinero y fichas:** la ficha dice «agotadas» con plazas retenidas y barra por debajo del 100 % (M1); un `INC` con gastos ≥ precio ofrece comprar y la reserva lo rechaza (M2); «íntegro para la entidad» no descuenta el mantenimiento (M3); caché de 24 h de la tarjeta social atrasa los días restantes (M4).
- **Tarifa de gestión de la taquilla:** guardar en la iniciativa los gastos de gestión con los que se publicó. **Sale de esta lista: se resuelve en el Sprint 5.18.**
- **Semilla y entorno:** `Initiative` de «Toldos y Sombras» con vocabulario interno; Cervantes con `contentLocale = ca` y textos en castellano; fechas de publicación que no siempre caen dentro del curso; `db:seed` conserva fechas y para renovarlas hace falta `db:reset`; las bases de demostración sembradas antes del 2026-11-15 dirán «NO COINCIDE» hasta rehacerlas.
- **Pruebas intermitentes conocidas** bajo carga (`auth-rbac`, `chat-faq-soporte`, `mi-cuenta`, `panel-studio-poster`, `console-settings`, `resize-vote`): se tratan como carga de la máquina; **no lanzar integración y E2E a la vez**.
- **Otros:** la 404 del portal es la genérica del sitio (3.3); al desactivar una entidad `publicIndexing` no se avisa a IndexNow.

### P9 · Acceso a la demo · hecho (revisar) · 🟢 · S
`npm run demo:access` (solo bases locales). Queda revisar con calma la experiencia de acceso y anotar en el README el bloqueo de `npm run db:dev` por un fichero antiguo en `AppData\Local\prisma-dev-nodejs\Data\durable-streams\korum\`.
- **Destino:** Sprint 5.24b.

### N1–N20 · Puntos nuevos de la revisión legal y fiscal del promotor

El detalle de cada decisión está en [PRERREVISION_LEGAL_Y_FISCAL.md](PRERREVISION_LEGAL_Y_FISCAL.md) §3.1 y su resumen en [CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) (decisiones 21 a 47). Las fichas, en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).

- **N1 · Sesión de escritura (SESIÓN T1).** Aviso legal; condiciones (familias, entidades, comercios, aportación mensual, entradas y vales); privacidad; cookies; primera capa de cada formulario; contrato de encargo; evaluación de impacto y tabla de plazos. Los valida el promotor.
- **N2 · Retirada de las rifas (5.12a y 5.12b).** 231 archivos las mencionan. Papeletas numeradas, sorteo, acta, números de reserva, ronda extra, aviso normativo, textos, semilla, pruebas y documentación.
- **N3 · Vales (5.14a, 5.14b y 5.14c), en exclusiva.** Unidades de canje en un QR con saldo; puesto con lector y PIN; devolución de 14 días; caducidad; tarifa propia; liquidación por lo vendido.
- **N4 · Comercios en dos modos (5.16a, 5.16b y 5.16c).** Donación con solo el nombre; publicidad con IVA de la entidad; casilla de aceptación; moderación a 14 días; ampliaciones; renovación; factura de la entidad con recordatorios; mismo comercio reconocido por NIF y email; domicilio fiscal. KORUM no devuelve nada si la entidad retira el anuncio: lo resuelven fuera de la plataforma.
- **N5 · IVA incluido y facturas (5.20a y 5.20b).** Completa a entidades y comercios; simplificada en el recibo de las familias. La factura de un comercio con contracargo solo se anula si el banco indica fraude.
- **N6 · Veri\*factu (5.23), sprint propio.**
- **N7 · Campañas (5.17).** Devolución automática a los 14 días con avisos a 7, 3 y 1; email a quien donó el día del vencimiento con la fecha exacta.
- **N8 · Entradas (5.13).** El evento se liquida por lo vendido; la cancelación devuelve el 100 %; el cambio de fecha devuelve a quien lo pida en 14 días.
- **N9 · Tarifas (5.18).** Todo cambio a 30 días, con email y aviso en el Estudio; se guarda la tarifa con la que se publicó cada campaña.
- **N10 · Auto-Impulso (5.21).** Siempre visible sin importe (se quita el ajuste de divulgación), frase en el email, línea con importe en la liquidación y el expediente, solo campañas con presupuesto, compensación en el reparto y 💎 sobre la comisión sin IVA.
- **N11 · Liquidación (5.19).** Solo a la cuenta de la entidad (pago al proveedor aplazado); entrega automática 5 días antes de vencer el plazo, también en el Fondo de actividades.
- **N12 · Firma única (5.19).** Frase añadida a la confirmación, cláusula en las condiciones y aviso de cada liberación al email general de la entidad.
- **N13 · Mi Hucha (5.15).** Apagada al lanzar; condiciones propias con versión; devolución automática de la gestión en 14 días.
- **N14 · Aportación voluntaria (5.15 y 5.20a).** Sin IVA ni factura; enlace de devolución de 14 días en el recibo.
- **N15 · Aceptación (5.15).** Una línea junto al botón de pago, versión guardada y resumen en el recibo.
- **N16 · Privacidad (5.10b).** Copia de «mis datos» con los rastros de seguridad; desvincularlos de la cuenta a los 12 meses.
- **N17 · Colegios con ánimo de lucro (5.22).** Solo entradas y vales.
- **N18 · Modelo 182 (5.22).** Comprobarlo contra el diseño oficial y validarlo en el entorno de pruebas de la Agencia Tributaria (hace falta el certificado digital del promotor).
- **N19 · Los 53 cambios pequeños y los retoques de los puntos R.** Repartidos por sprint en el §3.3 y, uno a uno, en el Anexo A.
- **N20 · Cuatro consultas para más adelante, sin bloquear nada.** Al abogado, el riesgo de la firma única; a la asesoría, la aportación voluntaria sin IVA, el año del donativo «todo o nada» y si el Auto-Impulso es gasto deducible. Redactadas en las partes 1 y 2 de [CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md](CONSULTAS_ABOGADO_ASESORIA_PAYCOMET.md). Se construye con lo decidido.

---

## 5. Decisiones ya tomadas que NO son deuda

Para que no se vuelvan a abrir por error. La lista completa, con fecha, está en [CUMPLIMIENTO §8](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md).
- **Rifas:** retiradas de la plataforma (2026-11-18). No se rediseñan ni se sustituyen por otro juego de azar; las sustituyen los vales.
- **Auto-Impulso:** suma como cualquier aportación; siempre visible y sin importe; solo en campañas con presupuesto; gasto promocional de KORUM, compensado en el reparto (2026-11-18, sustituye a lo decidido el 2026-11-12 y el 2026-11-15).
- **Firma única opcional**, relevos sin esperas y sin Super-Admin (2026-11-12); riesgo aceptado, con aviso de cada liberación al email general de la entidad.
- **Comercios:** el dinero de un comercio admitido no se le devuelve nunca; KORUM no media si la entidad retira su anuncio; no habrá un tercer modo de convenio; los importes se quedan como hoy.
- **Mi Hucha:** KORUM no guardará saldo; sale apagada.
- **Pago directo al proveedor:** aplazado; se liquida solo a la cuenta de la entidad.
- **PAYCOMET:** solo por su nombre, sin logotipo.
- **Quién valida:** el promotor; las preguntas a terceros pasan primero por él.
- Repartos bloqueados o desconocidos: **solo avisar** (2026-11-13).
- Estudio sin el desplegable «Estado» del prototipo (2026-11-15).
- La pasarela se enseña como «cubierta» (2026-11-17); el cargo de quien firma queda como lo escribe la entidad; sin expediente propio del Fondo de actividades.
- «Comercios amigos» es «Local partners» en inglés (2026-11-14).
- El Super-Admin no descarga el Modelo 182 de ninguna entidad (minimización de los NIF de las familias).

---

## 6. Cómo se cierra un punto

1. Se resuelve (código, decisión o respuesta escrita) y se anota en la bitácora con fecha y con la duración real del sprint.
2. Se marca aquí (§3) y en su documento de origen (plan, CUMPLIMIENTO §9 o DECISIONES §8) en el mismo sprint. Un punto legal `L-nnn` abierto se marca en CUMPLIMIENTO §9 y en el Anexo A.
3. Si cambia una regla de negocio, se actualiza el documento que manda (AGENTS §0) y se ejecuta `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs`.
4. **Nada nuevo se queda sin destino:** lo que aparezca en un sprint se corrige dentro de él o se añade a este registro con su sprint.

---

## Anexo A · Los 144 puntos legales y fiscales, uno a uno

> Generado el 2026-11-17 leyendo cada casilla de [CUMPLIMIENTO §9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) (la **fuente** del texto completo de cada punto, en la línea indicada). El ID `L-nnn` sigue el orden del documento; **no se renumeran** aunque se resuelvan puntos. «Origen» es el sprint que lo generó. Dos puntos (L-143 y L-144) de la asesoría fiscal estaban en un párrafo sin casilla y se han añadido. **Actualizado el 2026-11-18** con las decisiones del promotor: 92 resueltos y 52 abiertos, cada uno con su destino en la columna «Estado».
> **Para mantenerlo:** al cerrar el sprint de un punto abierto, se marca su casilla en CUMPLIMIENTO y se pone «resuelto» aquí. La columna «Para» indica quién lo resuelve hoy (Claude, Paycomet o Veri\*factu); en los resueltos queda vacía. Un cambio de redacción del punto se hace solo en CUMPLIMIENTO.

#### Paquete 1 · Textos legales, contrato y plazos (1 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-001 | Condiciones de uso, política de privacidad, aviso legal y política de cookies (en es, ca y en) | varios | 230 | — | resuelto (2026-11-17) |
| L-002 | Contrato de encargo del tratamiento con las entidades y reparto de responsabilidades (§5.1) | varios | 231 | — | resuelto (2026-11-17) |
| L-019 | EIPD (§5.3) y plazos de conservación (§6) | varios | 248 | — | resuelto (2026-11-17) |
| L-057 | Textos legales: publicación y archivo | 5.4 | 313 | Claude | abierto → Sprint 5.10a |

#### Paquete 2 · Familias, datos personales, Mi cuenta y Mi Hucha (12 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-003 | Validez del diseño antifraude (cookie de dispositivo sin consentimiento, huella con consentimiento) frente a la LSSI art.… | varios | 232 | — | resuelto (2026-11-17) |
| L-004 | Buzón de ideas (Sprint 3.6) · cookie de dispositivo | varios | 233 | Claude | abierto → Sprint 5.10c |
| L-005 | Buzón de ideas (Sprint 3.6) · consentimiento de la huella del navegador | varios | 234 | Claude | abierto → Sprint 5.10c |
| L-006 | Buzón de ideas (Sprint 3.6) · anonimato y datos de la idea | varios | 235 | — | resuelto (2026-11-17) |
| L-007 | Buzón de ideas (Sprint 3.6) · firmas sospechosas | varios | 236 | Claude | abierto → Sprint 5.10c |
| L-008 | Fotos Antes / Después (Sprint 3.6) · menores y derechos de imagen | varios | 237 | Claude | abierto → Sprint 5.24a |
| L-009 | Agradecimiento público del centro (Sprint 3.6) | varios | 238 | — | resuelto (2026-11-17) |
| L-010 | Mi cuenta (Sprint 3.7) · supresión de la cuenta | varios | 239 | Claude | abierto → Sprint 5.10b |
| L-011 | Mi cuenta (Sprint 3.7) · exportación de datos | varios | 240 | Claude | abierto → Sprint 5.10b |
| L-012 | Mi cuenta (Sprint 3.7) · rectificación | varios | 241 | — | resuelto (2026-11-17) |
| L-013 | Chat anónimo de las ideas (Sprint 3.9) | varios | 242 | — | resuelto (2026-11-17) |
| L-014 | Soporte (Sprint 3.9) | varios | 243 | — | resuelto (2026-11-17) |
| L-015 | Soporte y chat (Sprint 3.9) · puntos que deja la auditoría de seguridad | varios | 244 | Claude | abierto → Sprint 5.10b |
| L-016 | Mi Hucha (Sprint 3.8) · aportación mensual | varios | 245 | Claude | abierto → Sprint 5.15 |
| L-017 | Llaves de acceso (Sprint 3.7) | varios | 246 | — | resuelto (2026-11-17) |
| L-018 | Si, con el consentimiento de una persona, los dispositivos con la misma huella y red pueden contar también las cuentas de… | varios | 247 | Claude | abierto → Sprint 5.10c |
| L-021 | Modo `REGULATED_WALLET` de Mi Hucha, si se quiere activar | varios | 250 | — | resuelto (2026-11-18) |
| L-053 | Cambiar el email de una cuenta como rectificación (RGPD art. 16) — bloquea el paso a cobros reales (Sprint 6.1) | 5.3 | 306 | Claude | abierto → Sprint 5.10b |
| L-058 | Monedero con saldo (`REGULATED_WALLET`) | 5.4 | 314 | — | resuelto (2026-11-18) |
| L-115 | El centro lee el texto libre de la familia sin conocer su identidad | 4.4c | 403 | Claude | abierto → Sprint 5.24a |
| L-116 | Aviso por email «tienes una respuesta» sin consentimiento de comunicaciones | 4.4c | 404 | — | resuelto (2026-11-17) |
| L-117 | La respuesta del centro puede aludir a la situación de una familia | 4.4c | 405 | — | resuelto (2026-11-17) |
| L-118 | Consultas de la entidad a KORUM | 4.4c | 406 | — | resuelto (2026-11-17) |
| L-120 | Lo que escribió una persona en nombre de su entidad a KORUM | 4.4c | 409 | — | resuelto (2026-11-17) |
| L-121 | Una respuesta abusiva del centro | 4.4c | 410 | Claude | abierto → Sprint 5.24a |

#### Paquete 3 · Entidades, firmantes, KYB y medallas (5 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-035 | Un sello público «Comunidad Impulsora KORUM» y un informe en PDF pensados para difundirse entre las familias: el informe… | 4.1 | 276 | Claude | abierto → Sprint 5.24a |
| L-036 | La cifra «Recaudado» del informe sale de `raisedCents`, que incluye el bonus Matching 2x de comercios y, cuando exista, el… | 4.1 | 277 | — | resuelto (2026-11-17) |
| L-041 | Qué documentos se piden y quién los verifica | 4.2c | 288 | Paycomet | abierto → Paycomet (P2a) |
| L-042 | DNI de la persona representante a la vista de las dos firmas | 4.2c | 289 | Claude | abierto → Sprint 5.10c |
| L-043 | Plazo de conservación del KYB | 4.2c | 290 | — | resuelto (2026-11-17) |
| L-044 | Imagen de menores en la portada y el logotipo de la entidad | 4.2e | 294 | — | resuelto (2026-11-17) |
| L-045 | Cuenta de una tercera persona creada al invitarla | 4.2e | 295 | Claude | abierto → Sprint 5.10c |
| L-046 | Firma única y cambio de firmantes sin esperas (Sprint 5.2, decisión del promotor del 2026-11-12) | 4.2e | 296 | — | resuelto (2026-11-17) |
| L-047 | Contacto del alta al relevar a quien dirige | 4.2e | 297 | — | resuelto (2026-11-17) |
| L-048 | Historial de relevos | 4.2e | 298 | — | resuelto (2026-11-17) |
| L-049 | Texto del aviso `signer.handover` | 4.2e | 299 | Claude | abierto → Sprint 5.10c |
| L-119 | Imagen de la campaña y fotos con menores | 4.4c | 407 | — | resuelto (2026-11-17) |

#### Paquete 4 · Comercios, patrocinio y Fondo de actividades (12 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-037 | No admitir a un comercio | 4.2b | 281 | Claude | abierto → Sprint 5.16c |
| L-038 | Cartel del escaparate | 4.2b | 282 | Claude | abierto → Sprint 5.16c |
| L-039 | Conservación del contacto de un comercio cobrado | 4.2b | 283 | Claude | abierto → Sprint 5.16c |
| L-040 | Contacto del comercio a la vista de la entidad | 4.2b | 284 | Claude | abierto → Sprint 5.16b |
| L-076 | El patrocinio como aportación a fondo perdido | 4.2d | 344 | — | resuelto (2026-11-17) |
| L-077 | Sobrante de una bolsa Matching 2x reasignado | 4.2d | 345 | — | resuelto (2026-11-17) |
| L-078 | Avisos de renovación (LSSI art. 21) | 4.2d | 346 | Claude | abierto → Sprint 5.16c |
| L-079 | Datos de la renovación | 4.2d | 347 | Claude | abierto → Sprint 5.16c |
| L-080 | Coherencia de la política | 4.2d | 348 | — | resuelto (2026-11-17) |
| L-081 | Bolsa vencida al Fondo de actividades | 4.2f | 354 | Claude | abierto → Sprint 5.16b |
| L-082 | Cobro tardío retenido | 4.2f | 355 | Claude | abierto → Sprint 5.16b |
| L-083 | Renovación pagada dos veces | 4.2f | 356 | — | resuelto (2026-11-17) |
| L-084 | Invitación a renovar sin «renovar cada año» | 4.2f | 357 | — | resuelto (2026-11-17) |
| L-085 | Justificante del Fondo | 4.2f | 358 | — | resuelto (2026-11-17) |
| L-086 | Destino escrito en texto libre e inmutable | 4.2f | 359 | — | resuelto (2026-11-17) |
| L-087 | Invitación a renovar y la casilla no marcada (decisión 19) | 4.2f | 360 | Claude | abierto → Sprint 5.16c |
| L-088 | Aceptación expresa de las condiciones del patrocinio | 4.2f | 361 | Claude | abierto → Sprint 5.16b |
| L-089 | Renovación pagada dos veces (cobro de lo indebido, art. 1895 CC) | 4.2f | 362 | Claude | abierto → Sprint 5.16c |
| L-090 | Cobro tardío sin decisión de la entidad | 4.2f | 363 | Claude | abierto → Sprint 5.16c |
| L-091 | «No se devuelve nunca» si la entidad incumple la publicidad | 4.2f | 364 | — | resuelto (2026-11-18) |

#### Paquete 5 · Campañas, checkout, rifas y carteles (4 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-020 | Textos del checkout, de la aportación voluntaria y del aviso de rifas | varios | 249 | Claude | abierto → Sprints 5.10a y 5.15 |
| L-022 | Publicación o no del Auto-Impulso frente al mensaje "lo han conseguido las familias". Desde el Sprint 5.2 hay un aviso… | varios | 251 | Claude | abierto → Sprint 5.21 |
| L-023 | Para el abogado (anotado por el promotor el 2026-11-12, se trata más adelante) | varios | 252 | — | resuelto (2026-11-18) |
| L-092 | Rifas | 4.3 | 368 | — | resuelto (2026-11-18) |
| L-093 | PAYCOMET en el cartel impreso | 4.3 | 369 | — | resuelto (2026-11-18) |
| L-094 | Promesa impresa «se devuelve el 100 % si no se consigue» | 4.3 | 370 | — | resuelto (2026-11-17) |
| L-095 | «Sorteo certificado» | 4.3 | 371 | — | resuelto (2026-11-18) |
| L-096 | Cambios con la campaña recaudando | 4.3 | 372 | Claude | abierto → Sprint 5.18 |
| L-097 | Plantillas redactadas por KORUM | 4.3 | 373 | Claude | abierto → Sprint 5.24a |
| L-098 | Candado semántico | 4.3 | 374 | — | resuelto (2026-11-17) |

#### Paquete 6 · Liquidaciones y avisos a quienes aportaron (1 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-050 | Dinero que no se puede repartir (Paycomet y asesoría; decisión del promotor, 2026-11-13: solo avisar) | 5.3 | 303 | — | resuelto (2026-11-18) |
| L-099 | Avisos a quienes donaron sin consentimiento de comunicaciones | 4.4a | 378 | — | resuelto (2026-11-17) |
| L-100 | Pago directo al IBAN de un proveedor | 4.4a | 379 | — | resuelto (2026-11-18) |
| L-101 | Factura o proforma del proveedor obligatoria | 4.4a | 380 | — | resuelto (2026-11-17) |
| L-102 | Fotos Antes / Después solo tras la liquidación | 4.4a | 381 | Claude | abierto → Sprint 5.24a |
| L-103 | Papel de KORUM en los avisos a quienes donaron | 4.4a | 382 | — | resuelto (2026-11-17) |
| L-104 | Pago a un tercero y verificación del beneficiario | 4.4a | 383 | — | resuelto (2026-11-18) |
| L-105 | Qué ve quien firma del IBAN del proveedor | 4.4a | 384 | — | resuelto (2026-11-17) |
| L-106 | Facturas subidas y no adjuntadas | 4.4a | 385 | — | resuelto (2026-11-17) |

#### Paquete 7 · Votación de redimensionamiento y devoluciones (2 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-074 | «Reenviarme mi enlace de voto» | 5.5b | 339 | — | resuelto (2026-11-17) |
| L-107 | Votación vinculante para quien no vota | 4.4b | 389 | — | resuelto (2026-11-17) |
| L-108 | Mayoría simple sin quórum, una persona un voto sea cual sea el importe | 4.4b | 390 | — | resuelto (2026-11-17) |
| L-109 | Derecho de devolución | 4.4b | 391 | — | resuelto (2026-11-17) |
| L-110 | El enlace del email como única identificación | 4.4b | 392 | — | resuelto (2026-11-17) |
| L-111 | Avisos sin consentimiento de comunicaciones | 4.4b | 393 | — | resuelto (2026-11-17) |
| L-112 | Conservación de los votos | 4.4b | 394 | Claude | abierto → Sprint 5.17 |
| L-113 | Una campaña vencida sin decidir | 4.4b | 395 | Claude | abierto → Sprint 5.17 |

#### Paquete 8 · Portería y sorteo (4 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-072 | Pase de una papeleta de rifa | 5.6 | 334 | — | resuelto (2026-11-18) |
| L-122 | Voluntarios sin cuenta que entran con un PIN compartido | 4.5 | 414 | — | resuelto (2026-11-17) |
| L-123 | Lista de pases y cola de lecturas en el móvil del voluntario | 4.5 | 415 | Claude | abierto → Sprint 5.13 |
| L-124 | Conservación de las lecturas de portería (`TicketCheckIn`, `GateSession`) | 4.5 | 416 | Claude | abierto → Sprint 5.13 |
| L-125 | El Super-Admin no entra en la portería ni crea PIN | 4.5 | 417 | — | resuelto (2026-11-17) |
| L-126 | Lectura sin cobertura | 4.5 | 418 | — | resuelto (2026-11-17) |
| L-127 | La cámara del voluntario | 4.5 | 419 | — | resuelto (2026-11-17) |
| L-128 | Sorteo certificado | 4.5 | 420 | — | resuelto (2026-11-18) |
| L-129 | Sorteo desde el día del evento | 4.5 | 421 | — | resuelto (2026-11-18) |
| L-130 | Evento sin el aforo completo | 4.5 | 422 | Claude | abierto → Sprint 5.13 |
| L-131 | Ronda extra por una sola persona firmante | 4.6 | 426 | — | resuelto (2026-11-18) |
| L-132 | Qué ven quienes participaron | 4.6 | 427 | — | resuelto (2026-11-18) |
| L-133 | Nombre de quien hace la ronda extra en el aviso por email | 4.6 | 429 | — | resuelto (2026-11-17) |
| L-134 | El enlace de la portería es una credencial compartida por WhatsApp | 4.6 | 430 | Claude | abierto → Sprint 5.13 |

#### Paquete 9 · Consola, soporte de KORUM, auditoría y trazabilidad (6 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-051 | Email directo de KORUM al centro | 5.3 | 304 | — | resuelto (2026-11-17) |
| L-052 | Soporte de KORUM ve el email de quien escribe | 5.3 | 305 | — | resuelto (2026-11-17) |
| L-054 | Texto del email directo y conservación | 5.3 | 307 | Claude | abierto → Sprint 5.10c |
| L-055 | Aceptar un aviso de precios con una nota | 5.3 | 308 | — | resuelto (2026-11-17) |
| L-056 | Cambio global del límite exento | 5.3 | 309 | Claude | abierto → Sprint 5.18 |
| L-059 | Alta de nuevas personas con acceso total a la consola | 5.4 | 315 | Claude | abierto → Sprint 5.10c |
| L-060 | Historial de ajustes | 5.4 | 316 | — | resuelto (2026-11-17) |
| L-061 | «Probar conexión» de Paycomet y del email (suposiciones hasta tener cuentas de pruebas) | 5.4 | 317 | Paycomet | abierto → Paycomet (P2a) · Sprint 6.1b |
| L-062 | Qué ve cada entidad de su registro de actividad | 5.8a | 321 | — | resuelto (2026-11-17) |
| L-063 | Rastros nuevos y su base jurídica | 5.8a | 322 | — | resuelto (2026-11-17) |
| L-064 | Plazos | 5.8a | 323 | Claude | abierto → Sprint 5.10b |
| L-065 | Deber del encargado de informar de sus accesos (art. 28.3.h RGPD) | 5.8a | 324 | — | resuelto (2026-11-17) |
| L-066 | Filas que nacen de las familias | 5.8a | 325 | — | resuelto (2026-11-17) |
| L-067 | Derecho de acceso y supresión sobre los rastros de seguridad | 5.8a | 326 | — | resuelto (2026-11-17) |
| L-068 | Aviso a la persona | 5.8a | 327 | — | resuelto (2026-11-17) |
| L-069 | Texto del panel sobre la inalterabilidad del registro | 5.8a | 328 | — | resuelto (2026-11-17) |
| L-070 | Auto-Impulso en el registro de la entidad | 5.8a | 329 | — | resuelto (2026-11-17) |
| L-071 | Expediente exportable (Sprint 5.8b, construido con el criterio más prudente; DECISIONES §2.31) | 5.8a | 330 | Paycomet | abierto → Paycomet (P2a) |
| L-073 | Declaración de accesibilidad | 5.5b | 338 | — | resuelto (2026-11-17) |
| L-075 | IndexNow | 5.5b | 340 | — | resuelto (2026-11-17) |

#### Paquete F · Asesoría fiscal (5 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-024 | Tratamiento de lo recibido por colegios privados con ánimo de lucro | varios | 256 | — | resuelto (2026-11-18) |
| L-025 | IVA del fee a comercios, de la cuota de mantenimiento y de la aportación voluntaria a KORUM | varios | 257 | — | resuelto (2026-11-18) |
| L-026 | Proveedor de facturación Verifactu y fecha de obligatoriedad aplicable | varios | 258 | Veri\*factu + Claude | abierto → Veri\*factu (P2b) · Sprint 5.23 |
| L-027 | Formato y contenido del Modelo 182 y del justificante sin efectos fiscales | varios | 259 | — | resuelto (2026-11-18) |
| L-028 | Certificado de donación y justificante de Mi cuenta (Sprint 3.7): texto de la hoja (`account.documents.sheet.`: «la… | varios | 260 | Claude | abierto → Sprint 5.22 |
| L-029 | Gestión de Mi Hucha | 3.8 | 264 | — | resuelto (2026-11-17) |
| L-030 | Persona de contacto del fichero | 4.1 | 268 | Claude | abierto → Sprint 5.22 |
| L-031 | Campañas sin resolver | 4.1 | 269 | — | resuelto (2026-11-18) |
| L-032 | Declaración complementaria o sustitutiva | 4.1 | 270 | Claude | abierto → Sprint 5.22 |
| L-033 | Texto sin Ley 49/2002 verificada | 4.1 | 271 | — | resuelto (2026-11-17) |
| L-034 | El Super-Admin no descarga el Modelo 182 | 4.1 | 272 | — | resuelto (2026-11-17) |
| L-114 | Finalidad que cambia al redimensionar | 4.4b | 399 | — | resuelto (2026-11-18) |
| L-135 | Fee de un cobro tardío | 4.2f | 434 | — | resuelto (2026-11-17) |
| L-136 | Momento de la rectificativa al no admitir a un comercio | 4.2f | 435 | — | resuelto (2026-11-17) |
| L-137 | Naturaleza del 100 % del comercio que acaba en la entidad | 4.2f | 436 | — | resuelto (2026-11-18) |
| L-138 | Dinero del Fondo liquidado a la entidad | 4.2f | 437 | — | resuelto (2026-11-17) |
| L-139 | Rectificativa al no admitir a un comercio | 4.2b | 441 | — | resuelto (2026-11-17) |
| L-140 | Contracargo de un comercio ya facturado | 4.2b | 442 | — | resuelto (2026-11-18) |
| L-141 | Proveedor Verifactu y rectificativas: el registro de alta de una `R1` necesita `TipoRectificativa = I`,… | 4.2b | 443 | Claude | abierto → Sprint 5.23 |
| L-142 | Devolución del fee y su IVA | 4.2b | 444 | — | resuelto (2026-11-17) |
| L-143 | Factura del fee de cada renovación anual (una por año, en la serie normal) | 4.2d | 350 | — | resuelto (2026-11-17) |
| L-144 | Dinero de un comercio que acaba en la entidad sin campaña concreta: ¿patrocinio o donación? | 4.2d | 350 | — | resuelto (2026-11-17) |
