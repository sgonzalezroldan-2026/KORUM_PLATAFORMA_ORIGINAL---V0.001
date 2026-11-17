# Registro maestro de deuda y puntos abiertos

> **Qué es:** la lista única, completa y ordenada de todo lo que queda por hacer, decidir o gestionar antes y después del piloto. Reúne los puntos abiertos P1–P10 del [plan](PLAN_IMPLEMENTACION_ATOMICO.md), las «Tareas externas aplazadas», la deuda anotada en cada sprint de la [bitácora](BITACORA_SPRINTS.md), la lista legal de [CUMPLIMIENTO §9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) y la lista de preproducción de [DECISIONES_TECNICAS §8](DECISIONES_TECNICAS.md).
> **Fecha del barrido:** 2026-11-17 (tras el Sprint 5.9 y la actualización de Next.js 16.4.6). **Quién lo mantiene:** el asistente, al cerrar cada sprint; el promotor marca lo que decide o gestiona.
> **Fuente única:** el detalle técnico y legal de cada punto sigue en su documento de origen (se enlaza). Aquí está el **qué, quién, cuándo y con qué peso**. Si un punto se resuelve, se tacha aquí y en su origen en el mismo sprint.

---

## 1. Cómo leerlo

| Marca | Significado |
| :--- | :--- |
| **Criticidad** 🔴 | Bloquea cobrar dinero real o deja un riesgo de seguridad o de dinero abierto |
| 🟠 | Bloquea abrir el piloto a familias reales o la preproducción |
| 🟡 | Importante, pero no bloquea |
| 🟢 | Menor o cosmético |
| **Complejidad** S / M / L / XL | S = menos de media sesión · M = una sesión o sprint corto · L = un sprint completo · XL = varios sprints |
| **Dueño** | **Promotor** (decide o gestiona) · **Externo** (abogado, asesoría, Paycomet, proveedor) · **Claude** (código y documentos) · **Mixto** |

**Criterio del orden:** primero lo que bloquea dinero real y tiene plazo de terceros (se arranca ya, porque tarda semanas aunque no consuma trabajo), después lo que bloquea el despliegue, después lo que mejora el producto, y al final la validación externa y el piloto. Cuando dos puntos pesan parecido, va antes el que desbloquea a otros.

---

## 2. Resumen en cifras

- **26 puntos numerados** (P1–P26; P9 y P10 ya están hechos) más los sprints 6.1 y 6.2. Cada uno indica su dueño: tuyo, externo o mío.
- **144 puntos legales y fiscales** identificados uno a uno en el [Anexo A](#anexo-a--los-144-puntos-legales-y-fiscales-uno-a-uno) (IDs `L-001`–`L-144`): **2 ya resueltos y 142 abiertos**. De los abiertos, **108 son para el abogado**, **12 compartidos con el abogado y Paycomet** y **22 para la asesoría fiscal**. Son puntos, no preguntas: muchos llevan varias (unas 130 interrogaciones en total). Más **10 preguntas a Paycomet** (§2 de CUMPLIMIENTO) y **6 de Mi Hucha** (a–f).
- **11 casillas** de la lista de preproducción (DECISIONES §8) y unos **14 bloques «heredados»** en la ficha del Sprint 6.1.
- **Verificado en el código el 2026-11-17** (no es solo lo que dicen los documentos):
  - No existe el trámite para cambiar el email de una cuenta (RGPD art. 16) ni se guarda quién escribió cada consulta (`senderUserId`). La ficha del 5.3 lo marca «bloquea cobros reales».
  - No existen las páginas públicas de términos, privacidad, cookies y aviso legal (solo la declaración de accesibilidad).
  - No se registra la aceptación del contrato de encargo y las condiciones en el alta.
  - **Plausible no está conectado:** la variable existe en `env.ts`, pero no hay script ni eventos (`checkout_open`, `payment_success`, `share_click`…). Las métricas del piloto que promete EXPERIENCIA §9 no se pueden medir todavía.
  - **No hay protección contra la indexación de la preproducción:** ninguna comprobación de entorno ni cabecera `X-Robots-Tag` fuera de IndexNow. Una preproducción con entidades de demostración «indexables» podría aparecer en Google.
  - `docs/MANUAL_OPERACION.md` no existe.
  - Sí está hecho: reponer en cola los emails fallidos desde la consola; la resolución de repartos bloqueados quedó **decidida como «solo avisar»** (2026-11-13).

---

## 3. Orden de trabajo (resumen)

| # | Punto | Criticidad | Importancia | Complejidad | Dueño | Cuándo |
| :-: | :--- | :-: | :-: | :-: | :--- | :--- |
| 1 | **P1** Proveedor de pagos definitivo | 🔴 | Muy alta | S (decidir) · L (si se cambia) | Promotor | Ya |
| 2 | **P2** Plan de gestiones externas (P2a Paycomet · P2b Veri\*factu · P2c abogado · P2d asesoría) | 🔴 | Muy alta | S de tu parte, semanas de espera | Promotor + Externo | Ya, en paralelo |
| 3 | **P14** Dominio, empresa y cuentas de servicio | 🔴 | Alta | S | Promotor | Ya |
| 4 | **P3** Presupuesto de producción | 🟠 | Alta | S | Promotor | Antes del 6.1 |
| 5 | **P17** Sprint 5.10 · Cumplimiento en el código | 🔴 | Muy alta | M | Claude | Antes del 6.1 |
| 6 | **P18** Sprint 5.11 · Endurecimiento previo al despliegue | 🔴 | Alta | M–L | Claude | Antes del 6.1 |
| 7 | **P22** Higiene de claves | 🟠 | Alta | S | Promotor | **Hoy** |
| 8 | **P25** Sesión de decisiones pequeñas | 🟠 | Media-alta | S | Promotor | Una sesión corta |
| 9 | **P15** Entidades piloto y su acuerdo | 🟠 | Muy alta | M | Promotor | Desde ya (plazo largo) |
| 10 | **P12** Revisión crítica de producto (negocio, UX, automatismos) | 🟡 | Muy alta | M | Claude | Antes de P13, P5 y P11 |
| 11 | **P19** Medición del negocio (analítica y cuadro de control) | 🟠 | Alta | M | Claude | Antes del 6.2 |
| 12 | **P13** Gamificación | 🟡 | Alta | L | Claude + Promotor | Tras P12 |
| 13 | **P5** Rediseño visual profundo | 🟡 | Media | XL | Mixto | Decidir tras P12 y P13 |
| 14 | **P11** Revisión de la landing por el promotor | 🟡 | Alta | S–M | Promotor + Claude | Tras decidir P5 |
| 15 | **P20** Revisión de nativo ca/en | 🟠 | Media | M | Promotor + Externo | Cuando los textos estén congelados |
| 16 | **P23** Verificación de la deuda heredada | 🟡 | Media | S | Claude | Al abrir el 5.10 |
| 17 | **P8** Documentación sin Gemini | 🟢 | Baja | S | Claude | Cuando haya hueco |
| 18 | **6.1** Preproducción | 🔴 | Muy alta | L | Claude + Promotor | Tras las olas anteriores |
| 19 | **P21** Accesibilidad real (lector de pantalla y teclado) | 🟠 | Alta | M | Promotor | Antes del 6.2 |
| 20 | **P4** Rendimiento y escalabilidad de datos | 🟡 | Media | M | Claude | Tras medir en el 6.1 |
| 21 | **P6** Revisión crítica externa | 🟠 | Media-alta | M | Externo | Tras el 6.1 |
| 22 | **P7** Prueba de intrusión y de carga | 🔴 | Alta | M | Externo | Tras el 6.1 |
| 23 | **6.2** Piloto con 3 entidades | — | — | L | Mixto | Tras todo lo bloqueante |
| 24 | **P24** `REGULATED_WALLET` de Mi Hucha | 🟢 | Baja | XL | Mixto | Solo si se quiere (depende de P1) |
| 25 | **P26** Deuda menor y cosmética | 🟢 | Baja | S–M | Claude | Tandas de pulido |
| — | **P9** Acceso a la demo (hecho; queda revisar la experiencia) | 🟢 | Baja | S | Mixto | Cuando haya hueco |

---

## 4. Detalle de cada punto

### P1 · Proveedor de pagos definitivo · 🔴 · decidir S / cambiar L · Promotor
- **Decidir entre Paycomet y otro** (p. ej. Mangopay). Cambiar de proveedor no es meter credenciales: hay que escribir un adaptador de `PaymentProvider` (≈ un sprint medio con pruebas y revisión legal) y revisar lo ligado a Paycomet: ventana de 90 días, duración máxima de campaña (60), devoluciones, reparto por cobro (*split*), `REGULATED_WALLET`, notificaciones y conciliación.
- **Por qué va primero:** P2a, P3, P24 y buena parte del 6.1 dependen de esta decisión. Si se queda Paycomet, P1 se cierra en una conversación; si se cambia, hay que hacerlo antes de gastar tiempo en las preguntas a Paycomet.
- **Origen:** plan P1; CUMPLIMIENTO §2 y §3.

### P2 · Plan de gestiones externas · 🔴 · Promotor + Externo
Orden decidido el 2026-11-16: respuestas de Paycomet y proveedor de Veri\*factu **antes del 6.1**; abogado y asesoría **antes del 6.2**. Se pueden arrancar ya porque no consumen código. Según lo que respondan, puede haber retrabajo (adaptador, cálculos fiscales, textos), así que cuanto antes lleguen, mejor.

- **P2a · Paquete Paycomet** (origen: CUMPLIMIENTO §2 y §9).
  - Las **10 preguntas** del §2: retención hasta 90 días y límites de saldo; coste y plazo de las devoluciones; pago a un IBAN de terceros; KYB de cada entidad; contracargos; cobros recurrentes con tarjeta guardada y 3DS; monederos para `REGULATED_WALLET`; redacción aprobada para citar a Paycomet; repartos por cobro y su tope; formato, zona horaria (`BankDateTime`) y reintentos de las notificaciones; y devolver más de lo cobrado.
  - Las **6 de Mi Hucha (a–f):** guardar tarjeta en el primer pago, `IdUser`/`TokenUser` fuera de la firma, cobro iniciado por el comercio, autenticación en recurrentes, etc.
  - **Credenciales de sandbox y contrato de producción.**
  - Además, de la bitácora: IP original de las devoluciones, consulta de cobros, cómo gestiona el dinero bloqueado, cómo financia KORUM el Auto-Impulso como origen del reparto, si la entidad puede recibir varios repartos de un mismo pedido, y borrado de tarjetas (`/v1/cards/delete`, suposición sin probar).
- **P2b · Proveedor Veri\*factu** (origen: PLAN «Tareas externas aplazadas», CUMPLIMIENTO §9). Elegir proveedor homologado y escribir su adaptador (hoy falla a propósito con `PAYCOMET_MODE=live`). Con él: URL y entorno de pruebas del QR, campos de la factura rectificativa `R1` (`TipoRectificativa`, `FacturasRectificadas`, importe) y si hay que enviar el NIF del destinatario. **La rectificativa bloquea cobros reales con comercios.**
- **P2c · Abogado** (origen: CUMPLIMIENTO §9). **108 puntos abiertos para el abogado y 12 compartidos con Paycomet**, cada uno con su ID en el [Anexo A](#anexo-a--los-144-puntos-legales-y-fiscales-uno-a-uno). Para no mandar 120 consultas sueltas se agrupan en **9 paquetes** que se pueden enviar y cerrar por separado:
  1. **Textos legales, contrato y plazos** (4 puntos): términos, privacidad, aviso legal y cookies en es/ca/en; contrato de encargo; EIPD y plazos de conservación; publicación y archivo de versiones.
  2. **Familias, datos personales, Mi cuenta y Mi Hucha** (25): cookie de dispositivo y huella frente a la LSSI, buzón de ideas y anonimato, supresión, exportación y rectificación, chat y soporte, fotos con menores, llaves de acceso, Mi Hucha y `REGULATED_WALLET`, cambio de email.
  3. **Entidades, firmantes, KYB y medallas** (12): documentos del titular, DNI de quien representa, firma única, relevos, cuenta de una tercera persona, imagen de menores en portada y logotipo, kit de medallas.
  4. **Comercios, patrocinio y Fondo de actividades** (19): aportación a fondo perdido, renovación (LSSI art. 21), cobros tardíos, Fondo, cartel del escaparate, aceptación expresa (Ley 7/1998).
  5. **Campañas, checkout, rifas y carteles** (10): textos del checkout y de la aportación voluntaria, aviso normativo de rifas, «sorteo certificado», promesa impresa del 100 %, mención de Paycomet, Auto-Impulso.
  6. **Liquidaciones y avisos a quienes aportaron** (9): pago a IBAN de terceros, factura del proveedor, avisos sin consentimiento de comunicaciones, papel de KORUM, dinero que no se puede repartir.
  7. **Votación de redimensionamiento y devoluciones** (7): mayoría simple, derecho de devolución, enlace del email como identificación, conservación de votos, reenvío del enlace.
  8. **Portería y sorteo** (14): voluntarios con PIN compartido, lecturas sin cobertura, cámara, conservación de asistencia, ronda extra, pase de rifa «al portador».
  9. **Consola, soporte de KORUM, auditoría y trazabilidad** (20): qué ve cada entidad de su registro, base jurídica y plazos de los rastros de seguridad, deber del art. 28.3.h RGPD, expediente exportable, ajustes de la plataforma, accesibilidad e IndexNow.
- **Prerrevisión hecha (2026-11-17):** [PRERREVISION_LEGAL_Y_FISCAL.md](PRERREVISION_LEGAL_Y_FISCAL.md) clasifica los 144 puntos: 42 resolubles con tu visto bueno, 53 con un cambio pequeño, 17 duplicados, 4 obsoletos y **solo 28 que necesitan profesional o tercero** (20 `E` + 8 `P`). Pendiente: que el promotor apruebe la clasificación y las 11 decisiones de su §3 antes de tachar nada en CUMPLIMIENTO.
- **P2d · Asesoría fiscal** (origen: CUMPLIMIENTO §9, **22 puntos**, paquete F del Anexo A): colegios con ánimo de lucro; IVA del fee a comercios, de la cuota de mantenimiento, de la aportación voluntaria y de la gestión de Mi Hucha; formato del Modelo 182 (diseño vigente tras la Orden HAC/1430/2025), campañas sin resolver y complementaria; certificado y justificante; naturaleza del 100 % del comercio que acaba en la entidad y documento fiscal del Fondo de actividades; rectificativa `R1` y contracargo de un comercio; finalidad que cambia al redimensionar.

### P14 · Dominio, datos de la empresa y cuentas de servicio · 🔴 · S · Promotor *(tema nuevo)*
Junta cosas que hoy están repartidas en ocho sitios y que el 6.1 necesita todas a la vez:
- **Dominio definitivo** (fija `NEXT_PUBLIC_APP_URL`, que hoy vale `localhost`: de ahí salen las canónicas, `hreflang`, sitemap, `llms.txt` y las tarjetas sociales).
- **Datos de la empresa** en `/admin/ajustes`: **NIF y razón social emisores** (sin el NIF un patrocinio con fee no se asienta), correo de soporte y de privacidad (el buzón de la declaración de accesibilidad), clave `seo.indexNowKey`.
- **Cuentas:** Vercel **Pro** (el gratuito prohíbe uso comercial: obligatorio antes del primer cobro), Supabase UE, Brevo u otro email, Sentry UE, analítica, protección en el borde.
- **Correo del dominio:** SPF, DKIM, DMARC y prueba de entrega a Gmail, Outlook e iCloud.
- **Origen:** DECISIONES §8, ficha 6.1, bitácora 2.4, 2.6, 5.4, 5.5b.

### P3 · Presupuesto de producción · 🟠 · S · Promotor
Validar con precios reales y decidir el plan de cada servicio. Estimación de partida: **100–250 €/mes** de infraestructura y **5.000–20.000 €** puntuales (abogado, asesoría, prueba de penetración, revisión de nativo, seguros). Valorar planes gratuitos en el piloto y alternativas «todo en uno» (Firebase no sirve: base NoSQL, habría que reescribir el libro mayor). Incluir **seguros** (responsabilidad civil, ciber) y el coste de P6 y P7. Origen: plan P3.

### P17 · Sprint 5.10 · Cumplimiento en el código · 🔴 · M · Claude *(tema nuevo, agrupa deuda dispersa)*
Todo lo que el código debe tener antes de que existan cobros reales y que hoy no está (verificado). Modelo recomendado: **Claude Opus 5.5 · esfuerzo alto**; auditoría `antifraud-legal-guardian` + `ux-school-director-reviewer` + `qa-e2e-verifier`.
1. **Antiindexación de la preproducción:** `noindex` y `robots.txt` que bloquee todo lo que no sea producción (por `VERCEL_ENV` o un ajuste explícito), con prueba. *Hueco encontrado en este barrido.*
2. **Trámite verificado para cambiar el email de una cuenta** (rectificación RGPD art. 16, plazo legal de un mes) y guardar quién escribió cada consulta (`senderUserId`). *Bloquea cobros reales (5.3).*
3. **Aceptación registrada del contrato de encargo y las condiciones** en el alta de la entidad (hoy solo se registra la declaración de representación). *Bloquea producción (3.2).* El texto lo da el abogado: se construye con borrador.
4. **Páginas públicas de los textos legales** en es/ca/en con archivo de versiones anteriores. *Bloquea cobros reales (5.4).*
5. **Purgas pendientes:** altas cuyo responsable no verifica el email en 7 días (libera la URL); la tabla de auditoría crece sin purga; limpieza de ficheros públicos retirados cuyo objeto sigue en el almacén.
6. **Firma única también en el alta** de la entidad (hoy solo en Ajustes; decisión del 5.2).
7. **KYB al publicar:** `publishInitiative` aún no lo exige (4.2c, a verificar en P23).

### P18 · Sprint 5.11 · Endurecimiento previo al despliegue · 🔴 · M–L · Claude *(tema nuevo)*
Lo técnico que el 6.1 hereda y es mejor tener hecho antes de tocar infraestructura real. Modelo: **Claude Opus 5.5 · alto**.
1. `env.ts` rechaza los secretos de ejemplo publicados en `ci.yml` y `playwright.config.ts` antes de cualquier despliegue (también una demo).
2. **Cifrar** el `token` y el `otp` de `OutboxMessage.payloadJson` (hoy en claro hasta enviarse; las copias de seguridad los conservan).
3. **Identificador por petición** que enlace auditoría, Sentry y registros del servidor; **cadena de huellas** de la auditoría (prueba de que no se ha manipulado), comprobada en la conciliación diaria.
4. **Subida directa con URL firmada** al almacén: el límite de 4,5 MB de Vercel afecta a las fotos de logros (8 MB), las facturas de proveedor (10 MB) y las fotos de más de 4 MB.
5. **IP de confianza:** confirmar qué cabecera entrega la plataforma elegida; los límites de pago, la regla padre/madre y la ráfaga dependen de ella. Un cambio de alojamiento obliga a revisarlo.
6. **Topes de peticiones en el borde** para `/api/entities`, `/api/og/initiative`, `/api/og/entity` y `/api/auth/get-session`.
7. **Reparto y conciliación:** revisar `clearRefundClaimInTx` con el desfase horario real (riesgo de doble reembolso si Paycomet no rechaza devolver de más); ampliar la conciliación para cubrir **devoluciones y repartos**, no solo cobros.
8. **Modelo 182:** decidir si se excluyen las campañas sin resolver (hoy entran y se señalan).
9. **`pg@9`:** pasar la integración con `pg@9` y usar `relationLoadStrategy: 'join'` en lecturas dentro de transacciones.
10. **Validar con PostgreSQL real** la concurrencia de las funciones que solo se han revisado leyendo código (`reserveTickets`, `checkInPass`, `openGateSession`, `drawRaffle`, `issueInvoice`, `signIdea`, `requestSignature`, `completeSignature`).

### P22 · Higiene de claves · 🟠 · S · Promotor *(tema nuevo, hacer hoy)*
La bitácora del Sprint 3.9 recoge que la línea de comandos de un proceso `mcp-remote` de **Stitch** muestra una **clave de API en claro**: conviene rotarla. No consta que se hiciera. Si ya no usas Stitch, retirarlo. Revisar de paso qué otras claves se han escrito en conversaciones (la bitácora cita una clave de la base local «dada en la sesión»: es de una base local, pero conviene cambiarla si el equipo sale de casa).

### P25 · Sesión de decisiones pequeñas · 🟠 · S · Promotor *(tema nuevo)*
Decisiones que están repartidas por la bitácora como «decisión del promotor» sin cerrar. Una sesión corta las limpia, con el formato «qué pasa hoy, ejemplo, opciones, recomendación»:
1. **Gestión de Mi Hucha frente al coste de la pasarela:** con los valores por defecto (0,25 € de gestión; pasarela 1 % + 0,09 €) el aviso ya es crítico desde unos 16–25 € al mes. Subir la gestión o cambiar cómo se cuenta. Se decide con los precios reales de P1.
2. **Evento de taquilla que llega a su fecha sin agotar el aforo:** hoy pasa a «vencido» aunque haya entradas vendidas.
3. **¿Puede el Super-Admin intervenir en la portería?** Hoy no entra ni crea PIN.
4. **Chat de soporte del centro:** hoy no puede contestar dos veces ni reabrir una consulta resuelta.
5. **Fotografías de ambiente:** se sustituyeron por ilustraciones vectoriales. Decidir si bastan o si se usarán fotos reales de las entidades piloto (con permisos y sin menores identificables).
6. **Revisión cruzada con otro modelo** (la bitácora la ofrece «si la quiere») y modelo recomendado en las fichas tras P8.
7. **Aviso de cambio global del límite exento:** ¿avisar por email a las entidades cuando sube o baja?
8. **Retorno del 💎 y Auto-Impulso en taquilla/matching:** ya decidido «se deja como está» el 2026-11-15; queda solo en la lista del abogado.

### P15 · Entidades piloto y su acuerdo · 🟠 · M · Promotor *(tema nuevo)*
El 6.2 necesita **3 entidades reales con KYB real** y no hay ningún punto que diga quién las capta. Incluye: elegir cuáles (un colegio, un club y una entidad cultural si se quiere probar las tres verticales), acuerdo de piloto (qué se promete, qué no, duración, soporte), contrato de encargo firmado (depende de P2c), alta acompañada, primera campaña de presupuesto y primera taquilla o rifa, y qué se mide (depende de P19). También **fotos reales** si se decide así en P25 y **bases legales de la primera rifa** de la comunidad autónoma que toque.

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

### P19 · Medición del negocio · 🟠 · M · Claude *(tema nuevo, verificado)*
EXPERIENCIA §9 define las métricas del piloto (conversión del checkout ≥ 35 %, tiempo mediano hasta pagar ≤ 15 s, activación de la aportación voluntaria, % de campañas logradas, tiempo de la doble firma…) y promete eventos de Plausible. **En el código no hay ni script ni eventos.** Alcance: conectar Plausible con consentimiento y sin datos personales, eventos del embudo, métricas de negocio desde la base de datos, y una pantalla en la consola. Necesita P14 (dominio) para configurarse del todo. Sin esto, el seguimiento diario del piloto (6.2) se haría a ciegas.

### P13 · Gamificación · 🟡 · L · Claude + Promotor *(punto pedido por el promotor)*
Mejorar la experiencia de familias, comercios y entidades con mecánicas de juego **dentro de las reglas de la casa**: sin presión social, sin ranking de personas, sin señalar a quien no aporta, sin importes por curso, sin copiar instituciones (Regla 03 §0 y §6), con `prefers-reduced-motion` y accesible.
- **Lo que ya existe y se puede aprovechar:** medallas Bronce, Plata y Oro de la entidad (kit y beca), retos por curso en positivo, sellos de mérito, pegatinas, celebraciones al firmar y al conseguir un reto, galería Antes/Después, Matching 2x.
- **Direcciones a explorar (propuestas, a decidir tras P12):**
  - **Familias:** «Cuaderno» personal con sellos por cada campaña apoyada; capítulo por curso escolar; hitos de la comunidad (no de personas); sello de constancia en Mi Hucha por meses seguidos, solo visible para la propia persona; «Yo ayudé a…» para compartir con permiso explícito; álbum de logros conseguidos.
  - **Entidades:** lista de **primeros pasos** con progreso (alta → KYB → firmantes → primera idea → primera campaña → primera liquidación con Antes/Después); camino a la **siguiente medalla** con lo que falta; «sello de entidad al día» por liquidar a tiempo y subir fotos; memoria del curso (ver P12).
  - **Comercios:** distintivo visible por categoría, sin importes (ya es regla), con antigüedad y renovación celebrada.
- **Límites a vigilar:** nada que parezca una rifa o un incentivo económico encubierto (ver los puntos de rifas del abogado); nada que premie dar más dinero; cualquier ventaja con coste (como la beca de medalla) se decide contigo; privacidad por defecto.
- **Salida:** propuesta con 2–3 mecánicas, maqueta y métricas de éxito (P19) antes de construir; se construye en 1–2 sprints.

### P5 · Rediseño visual profundo · 🟡 · XL · Mixto
Entre el 5.9 y el 6.1: tres propuestas en maqueta interactiva de 3 pantallas (portada de entidad, ficha con checkout, panel de la entidad); eliges o mezclas; se aplica primero por tokens (`globals.css`) y luego pantalla a pantalla. Si cambia la marca: actualizar `korum-brand-design-system` y la Regla 03 en `.agents/` y ejecutar `node scripts/sync-ai-context.mjs`; los E2E de estructura se rehacen. **Recomendación:** decidir **sí o no** después de P12 y P13, porque ambos pueden mover pantallas, y antes de P11 (tus microajustes de la landing se perderían si luego se rediseña). Aviso: la portada de la entidad está a 1,8 KB del tope de JavaScript.

### P11 · Revisión de la landing por el promotor · 🟡 · S–M · Promotor + Claude *(punto pedido por el promotor)*
Tu revisión y ajuste de **textos y mensajes** de la landing y de **microcorrecciones de diseño y visualización**. Método: me pasas lotes («dónde → qué»); los textos van a `messages/{es,ca,en}.json`; los **textos oficiales de la Regla 03 §3 no se tocan sin tu aprobación expresa**; cada lote con capturas a 1440 y 430 px y las puertas por niveles. Puedo preparar una hoja con todos los textos de la landing extraídos de los catálogos para que los repases de una vez. **Va después de decidir P5.** Tras él, los textos nuevos entran en la revisión de nativo (P20).

### P20 · Revisión de nativo ca/en · 🟠 · M · Promotor + Externo
**Casi todos los sprints la dejan pendiente.** Hoy los textos en catalán e inglés los escribió el mismo modelo. Se hace **una sola vez, al final**, cuando P11, P12, P13 y los textos legales estén congelados, para no pagarla dos veces. Incluye: espacios `home`, `nav`, `finder`, `calculator`, `cookies`, `marketing`, `auth`, `registration`, `panel`, `gate`, `admin`, `portal`, `email`, `audit` y los de rifa, pase, categorías y expediente; «piggy bank»; «the school» frente a clubes y centros culturales; los nombres de curso de la plantilla (Regla 03 §5), que hoy salen sin traducir en el selector ca/en; y la redacción de los textos legales con el abogado.

### P23 · Verificación de la deuda heredada · 🟡 · S · Claude *(tema nuevo)*
Algunas deudas de sprints antiguos se movieron de ficha en ficha y no sé si siguen vivas. Compruebo en código y las tacho o las llevo a su sitio: KYB exigido al publicar; purga de altas sin verificar; email de la entidad desde la ficha 360º; verificación de documentos KYB con `org.kybStatus`; liberar un CIF ocupado; aviso al caducar un relevo; listado de campañas al 0 % por candado semántico; avisos de reembolso rechazado y de factura atascada; `completedThisYear` (contador de demostración) y `medalGrantUsedInTitle` al cancelar una campaña; metas de la semilla; adaptador SMTP (hoy solo Brevo). Se hace al abrir el 5.10.

### P8 · Imágenes y animaciones las hace Claude · 🟢 · S · Claude
Decidido el 2026-11-16. Falta ejecutar: actualizar la guía de IA §5, la Regla 04 §3.4, `CLAUDE.md`, la skill de marca y las fichas del plan que citan Gemini («Gemini Argon» para revisión de nativo y 6.1, «Gemini Flash» como alternativa de modelo; hay 53 menciones repartidas en `AGENTS.md`, la Regla 04, el plan y la guía), y ejecutar `node scripts/sync-ai-context.mjs`. Límite honesto: Claude no genera fotografías ni ilustraciones en mapa de bits (ver P25.5).

### 6.1 · Preproducción · 🔴 · L · Claude + Promotor
Ficha completa en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md). Tras P14, P17 y P18 queda lo que **solo se puede hacer con infraestructura real**:
- Entornos `preview` y `production` separados, función en Frankfurt, base en la UE, **copias diarias y recuperación a un punto en el tiempo probadas con una restauración real**, rol `korum_app` (con prueba de que no puede alterar el libro mayor), cron visibles en la consola.
- Cubos de Supabase `korum-public` y `korum-private` (comprobar que el privado lo es), DSN de Sentry en la UE sin datos personales, alertas de Sentry y de la conciliación.
- **Sandbox real de Paycomet:** pago, reparto, reembolso y contracargo; página de pago `/v1/form` (campos, idioma `ca`, Bizum sin salir de `*.paycomet.com`), `PSP_RECONCILIATION` contra la API real (se asume UTC), verificar la tarjeta guardada de Mi Hucha y los datos de recurrencia 3DS, confirmar el `AuthCode` de cada cobro, ver `/api/cron/*` solo con `CRON_SECRET`.
- Email: probar Brevo con una cuenta real, sin reescritura de enlaces de las papeletas; SPF, DKIM y DMARC (P14).
- Cookie `korum_device` por HTTPS; ensayar la **rotación de `ENCRYPTION_KEY`**; saber que rotar `QR_HMAC_SECRET` invalida todos los pases.
- Search Console y Bing con el sitemap, prueba de resultados enriquecidos, IndexNow con el dominio definitivo, y compartir un enlace en WhatsApp, Facebook y LinkedIn para ver las tarjetas (también tu tarea).
- **Simulacro de restauración** y **`docs/MANUAL_OPERACION.md`** (pago fallido, contracargo, caída, solicitud RGPD).
- Probar la cámara y el audio de la portería en iPhone y Android reales.
- **Gate:** `QA-OPS03` (la única sin prueba automática).

### P21 · Accesibilidad real · 🟠 · M · Promotor
VoiceOver (iPhone) y TalkBack (Android) en el pago y en la portería, y recorrido entero con teclado (`QA-X02`). Aplazada el 2026-11-14. **Bloquea el piloto (6.2).** Al hacerla, actualizar `/accesibilidad`, que hoy dice «parcialmente conforme». También por comprobar a mano: el foco del alta de 2FA y de la invitación (solo cubierto con pruebas de componente).

### P4 · Rendimiento y escalabilidad de datos · 🟡 · M · Claude
Decidido: **medir primero en la preproducción** (LCP, INP, JavaScript inicial, consultas lentas; el servidor de desarrollo no sirve) y optimizar solo lo que salga mal. Incluye la deuda de volumen anotada en los sprints: `loadLedgerPerInitiative` a `GROUP BY` antes de ~50.000 apuntes; `loadBiSnapshot` por una sola fila para el pop-up; propagación de ajustes a las entidades por lotes; cursor en el cierre de donaciones; la pulsación de «Filtrar» con picos de ~230 ms.

### P6 · Revisión crítica externa · 🟠 · M · Externo
Sobre la preproducción y antes del 6.2: dossier con URL, cuentas de prueba y guion por rol; perfiles (UX, producto o negocio, técnico, 5–8 personas reales); tabla común (pantalla, problema, gravedad, propuesta); yo priorizo por impacto y esfuerzo y tú eliges qué entra. **Distinta de P12:** P12 es mía y anterior, P6 es de ojos ajenos.

### P7 · Prueba de intrusión y de carga · 🔴 · M · Externo
Empresa independiente sobre la preproducción (la interna del 5.6 no la sustituye) y prueba de carga con un acto grande (toda la comunidad en la misma wifi). Presupuesto en P3.

### 6.2 · Piloto · L · Mixto
Alta acompañada de las 3 entidades, primera campaña y primera taquilla o rifa, seguimiento diario de métricas (P19), registro de incidencias y lista priorizada de mejoras. **Gate:** conciliación diaria sin diferencias durante todo el piloto. Depende de: contrato de Paycomet en producción, KYB real, textos legales publicados, P21, P15.

### P24 · `REGULATED_WALLET` de Mi Hucha · 🟢 · XL · Mixto
Aplazado el 2026-11-07. Solo si se quiere activar y si P1 trae un proveedor de monederos. Queda por construir: recarga puntual y mensual, retirada solo al medio de pago original (FIFO de recargas) con el aviso oficial de la Regla 03 §3, pago con Mi Hucha en el checkout y saldo en la portada. Revisión legal y confirmación escrita del proveedor.

### P26 · Deuda menor y cosmética · 🟢 · S–M · Claude
Se agrupa para barrerla en una tanda de pulido:
- **Experiencia:** el anillo de foco de las casillas roza el emoji 🛡️ del bloque de aportación voluntaria; aviso de consola «preloaded CSS not used» (del framework); total anunciado a cada pulsación al teclear otro importe (3.4) y resumen de Mi Hucha anunciado a cada pulsación (3.8); la barra de la celebración arranca su valor accesible en el avance anterior; los errores fiscales de Mi Hucha no mueven el foco; el simulador de Mi Hucha no desglosa donación y gestión; el chat solo se refresca al recargar; el bloque de cookie y huella antes de las ideas es demasiado largo; alineación de la navegación con las tarjetas a 1440 px; encabezados de la cabecera de gestión, «tú»/«vosotros», etiqueta genérica de la cofirma y contador en «Aprobaciones» (4.2a).
- **Mi cuenta:** tras suprimir la cuenta siguen visibles llaves e idioma hasta salir; «Dar de alta mi entidad» e «Iniciar sesión» aparecen con sesión iniciada en el cuerpo de la portada; quitar una llave de acceso no pide reautenticación; el historial de aportaciones no se filtra por ejercicio; reservar cupo antes de `requireVerifiedAccount` en la rectificación; los mensajes del alta revelan si un email ya tiene cuenta (limitado a 5 por red y hora); se pide el teléfono del cofirmante pero no se guarda.
- **Dinero y fichas:** la ficha dice «agotadas» con plazas retenidas y barra por debajo del 100 % (M1); un `INC` con gastos ≥ precio ofrece comprar y la reserva lo rechaza (M2); «íntegro para la entidad» no descuenta el mantenimiento (M3); caché de 24 h de la tarjeta social atrasa los días restantes (M4); `isWinner` queda en `true` en una papeleta sustituida; la ronda extra no limita los días; sin otra persona firmante nadie recibe el aviso de una ronda extra.
- **Tarifa de gestión de la taquilla:** guardar en la iniciativa los gastos de gestión con los que se publicó, para poder cambiar la tarifa sin tocar lo prometido (hoy se rechaza mientras haya una a la venta). *Deuda del B1.*
- **Semilla y entorno:** `Initiative` de «Toldos y Sombras» con vocabulario interno; Cervantes con `contentLocale = ca` y textos en castellano; fechas de publicación que no siempre caen dentro del curso; `db:seed` conserva fechas y para renovarlas hace falta `db:reset`; las bases de demostración sembradas antes del 2026-11-15 dirán «NO COINCIDE» hasta rehacerlas.
- **Pruebas intermitentes conocidas** bajo carga (`auth-rbac`, `chat-faq-soporte`, `mi-cuenta`, `panel-studio-poster`, `console-settings`, `resize-vote`): se tratan como carga de la máquina; **no lanzar integración y E2E a la vez**.
- **Otros:** la 404 del portal es la genérica del sitio (3.3); al desactivar una entidad `publicIndexing` no se avisa a IndexNow (la retirada depende del `noindex` y del rastreo; prerrevisión legal, bloque 3).

### P9 · Acceso a la demo · hecho (revisar) · 🟢 · S
`npm run demo:access` (solo bases locales). Queda revisar con calma la experiencia de acceso y anotar en el README el bloqueo de `npm run db:dev` por un fichero antiguo en `AppData\Local\prisma-dev-nodejs\Data\durable-streams\korum\`.

---

## 5. Decisiones ya tomadas que NO son deuda

Para que no se vuelvan a abrir por error:
- Auto-Impulso: suma como cualquier aportación; el importe es anónimo; se deja como está en taquilla y matching (2026-11-15).
- Firma única opcional, relevos sin esperas y sin Super-Admin (2026-11-12); riesgo aceptado: una sola persona puede quedarse con el control.
- El dinero de un comercio admitido no se le devuelve nunca; solo si la entidad no lo admite (2026-11-10).
- Repartos bloqueados o desconocidos: **solo avisar** (2026-11-13).
- Estudio sin el desplegable «Estado» del prototipo (2026-11-15).
- La pasarela se enseña como «cubierta» (2026-11-17); el cargo de quien firma queda como lo escribe la entidad; sin expediente propio del Fondo de actividades.
- «Comercios amigos» es «Local partners» en inglés (2026-11-14).
- El Super-Admin no descarga el Modelo 182 de ninguna entidad (minimización de los NIF de las familias).

---

## 6. Cómo se cierra un punto

1. Se resuelve (código, decisión o respuesta escrita) y se anota en la bitácora con fecha.
2. Se tacha aquí y en su documento de origen (plan, CUMPLIMIENTO o DECISIONES) en el mismo sprint.
3. Si cambia una regla de negocio, se actualiza el documento que manda (AGENTS §0) y se ejecuta `node .agents/skills/korum-qa-harness-gatekeeper/scripts/verify-invariants.mjs`.

---

## Anexo A · Los 144 puntos legales y fiscales, uno a uno

> Generado el 2026-11-17 leyendo cada casilla de [CUMPLIMIENTO §9](CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) (la **fuente** del texto completo de cada punto, en la línea indicada). El ID `L-nnn` sigue el orden del documento; **no se renumeran** aunque se resuelvan puntos. «Origen» es el sprint que lo generó. Dos puntos (L-143 y L-144) de la asesoría fiscal estaban en un párrafo sin casilla y se han añadido. Resueltos: L-080 y L-107.
> **Para mantenerlo:** al responder el abogado o la asesoría, se tacha el punto en CUMPLIMIENTO y se marca «resuelto» aquí. Un cambio de redacción del punto se hace solo en CUMPLIMIENTO.

#### Paquete 1 · Textos legales, contrato y plazos (4 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-001 | Condiciones de uso, política de privacidad, aviso legal y política de cookies (en es, ca y en) | varios | 188 | Abogado | abierto |
| L-002 | Contrato de encargo del tratamiento con las entidades y reparto de responsabilidades (§5.1) | varios | 189 | Abogado | abierto |
| L-019 | EIPD (§5.3) y plazos de conservación (§6) | varios | 206 | Abogado | abierto |
| L-057 | Textos legales: publicación y archivo | 5.4 | 271 | Abogado + Paycomet | abierto |

#### Paquete 2 · Familias, datos personales, Mi cuenta y Mi Hucha (25 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-003 | Validez del diseño antifraude (cookie de dispositivo sin consentimiento, huella con consentimiento) frente a la LSSI art.… | varios | 190 | Abogado | abierto |
| L-004 | Buzón de ideas (Sprint 3.6) · cookie de dispositivo | varios | 191 | Abogado | abierto |
| L-005 | Buzón de ideas (Sprint 3.6) · consentimiento de la huella del navegador | varios | 192 | Abogado | abierto |
| L-006 | Buzón de ideas (Sprint 3.6) · anonimato y datos de la idea | varios | 193 | Abogado | abierto |
| L-007 | Buzón de ideas (Sprint 3.6) · firmas sospechosas | varios | 194 | Abogado | abierto |
| L-008 | Fotos Antes / Después (Sprint 3.6) · menores y derechos de imagen | varios | 195 | Abogado | abierto |
| L-009 | Agradecimiento público del centro (Sprint 3.6) | varios | 196 | Abogado | abierto |
| L-010 | Mi cuenta (Sprint 3.7) · supresión de la cuenta | varios | 197 | Abogado | abierto |
| L-011 | Mi cuenta (Sprint 3.7) · exportación de datos | varios | 198 | Abogado | abierto |
| L-012 | Mi cuenta (Sprint 3.7) · rectificación | varios | 199 | Abogado | abierto |
| L-013 | Chat anónimo de las ideas (Sprint 3.9) | varios | 200 | Abogado | abierto |
| L-014 | Soporte (Sprint 3.9) | varios | 201 | Abogado | abierto |
| L-015 | Soporte y chat (Sprint 3.9) · puntos que deja la auditoría de seguridad | varios | 202 | Abogado | abierto |
| L-016 | Mi Hucha (Sprint 3.8) · aportación mensual | varios | 203 | Abogado | abierto |
| L-017 | Llaves de acceso (Sprint 3.7) | varios | 204 | Abogado | abierto |
| L-018 | Si, con el consentimiento de una persona, los dispositivos con la misma huella y red pueden contar también las cuentas de… | varios | 205 | Abogado | abierto |
| L-021 | Modo `REGULATED_WALLET` de Mi Hucha, si se quiere activar | varios | 208 | Abogado | abierto |
| L-053 | Cambiar el email de una cuenta como rectificación (RGPD art. 16) — bloquea el paso a cobros reales (Sprint 6.1) | 5.3 | 264 | Abogado + Paycomet | abierto |
| L-058 | Monedero con saldo (`REGULATED_WALLET`) | 5.4 | 272 | Abogado + Paycomet | abierto |
| L-115 | El centro lee el texto libre de la familia sin conocer su identidad | 4.4c | 361 | Abogado | abierto |
| L-116 | Aviso por email «tienes una respuesta» sin consentimiento de comunicaciones | 4.4c | 362 | Abogado | abierto |
| L-117 | La respuesta del centro puede aludir a la situación de una familia | 4.4c | 363 | Abogado | abierto |
| L-118 | Consultas de la entidad a KORUM | 4.4c | 364 | Abogado | abierto |
| L-120 | Lo que escribió una persona en nombre de su entidad a KORUM | 4.4c | 367 | Abogado | abierto |
| L-121 | Una respuesta abusiva del centro | 4.4c | 368 | Abogado | abierto |

#### Paquete 3 · Entidades, firmantes, KYB y medallas (12 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-035 | Un sello público «Comunidad Impulsora KORUM» y un informe en PDF pensados para difundirse entre las familias: el informe… | 4.1 | 234 | Abogado | abierto |
| L-036 | La cifra «Recaudado» del informe sale de `raisedCents`, que incluye el bonus Matching 2x de comercios y, cuando exista, el… | 4.1 | 235 | Abogado | abierto |
| L-041 | Qué documentos se piden y quién los verifica | 4.2c | 246 | Abogado | abierto |
| L-042 | DNI de la persona representante a la vista de las dos firmas | 4.2c | 247 | Abogado | abierto |
| L-043 | Plazo de conservación del KYB | 4.2c | 248 | Abogado | abierto |
| L-044 | Imagen de menores en la portada y el logotipo de la entidad | 4.2e | 252 | Abogado | abierto |
| L-045 | Cuenta de una tercera persona creada al invitarla | 4.2e | 253 | Abogado | abierto |
| L-046 | Firma única y cambio de firmantes sin esperas (Sprint 5.2, decisión del promotor del 2026-11-12) | 4.2e | 254 | Abogado | abierto |
| L-047 | Contacto del alta al relevar a quien dirige | 4.2e | 255 | Abogado | abierto |
| L-048 | Historial de relevos | 4.2e | 256 | Abogado | abierto |
| L-049 | Texto del aviso `signer.handover` | 4.2e | 257 | Abogado | abierto |
| L-119 | Imagen de la campaña y fotos con menores | 4.4c | 365 | Abogado | abierto |

#### Paquete 4 · Comercios, patrocinio y Fondo de actividades (19 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-037 | No admitir a un comercio | 4.2b | 239 | Abogado | abierto |
| L-038 | Cartel del escaparate | 4.2b | 240 | Abogado | abierto |
| L-039 | Conservación del contacto de un comercio cobrado | 4.2b | 241 | Abogado | abierto |
| L-040 | Contacto del comercio a la vista de la entidad | 4.2b | 242 | Abogado | abierto |
| L-076 | El patrocinio como aportación a fondo perdido | 4.2d | 302 | Abogado | abierto |
| L-077 | Sobrante de una bolsa Matching 2x reasignado | 4.2d | 303 | Abogado | abierto |
| L-078 | Avisos de renovación (LSSI art. 21) | 4.2d | 304 | Abogado | abierto |
| L-079 | Datos de la renovación | 4.2d | 305 | Abogado | abierto |
| L-080 | Coherencia de la política | 4.2d | 306 | Abogado | resuelto |
| L-081 | Bolsa vencida al Fondo de actividades | 4.2f | 312 | Abogado | abierto |
| L-082 | Cobro tardío retenido | 4.2f | 313 | Abogado | abierto |
| L-083 | Renovación pagada dos veces | 4.2f | 314 | Abogado | abierto |
| L-084 | Invitación a renovar sin «renovar cada año» | 4.2f | 315 | Abogado | abierto |
| L-085 | Justificante del Fondo | 4.2f | 316 | Abogado | abierto |
| L-086 | Destino escrito en texto libre e inmutable | 4.2f | 317 | Abogado | abierto |
| L-087 | Invitación a renovar y la casilla no marcada (decisión 19) | 4.2f | 318 | Abogado | abierto |
| L-088 | Aceptación expresa de las condiciones del patrocinio | 4.2f | 319 | Abogado | abierto |
| L-089 | Renovación pagada dos veces (cobro de lo indebido, art. 1895 CC) | 4.2f | 320 | Abogado | abierto |
| L-090 | Cobro tardío sin decisión de la entidad | 4.2f | 321 | Abogado | abierto |
| L-091 | «No se devuelve nunca» si la entidad incumple la publicidad | 4.2f | 322 | Abogado | abierto |

#### Paquete 5 · Campañas, checkout, rifas y carteles (10 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-020 | Textos del checkout, de la aportación voluntaria y del aviso de rifas | varios | 207 | Abogado | abierto |
| L-022 | Publicación o no del Auto-Impulso frente al mensaje "lo han conseguido las familias". Desde el Sprint 5.2 hay un aviso… | varios | 209 | Abogado | abierto |
| L-023 | Para el abogado (anotado por el promotor el 2026-11-12, se trata más adelante) | varios | 210 | Abogado | abierto |
| L-092 | Rifas | 4.3 | 326 | Abogado | abierto |
| L-093 | PAYCOMET en el cartel impreso | 4.3 | 327 | Abogado | abierto |
| L-094 | Promesa impresa «se devuelve el 100 % si no se consigue» | 4.3 | 328 | Abogado | abierto |
| L-095 | «Sorteo certificado» | 4.3 | 329 | Abogado | abierto |
| L-096 | Cambios con la campaña recaudando | 4.3 | 330 | Abogado | abierto |
| L-097 | Plantillas redactadas por KORUM | 4.3 | 331 | Abogado | abierto |
| L-098 | Candado semántico | 4.3 | 332 | Abogado | abierto |

#### Paquete 6 · Liquidaciones y avisos a quienes aportaron (9 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-050 | Dinero que no se puede repartir (Paycomet y asesoría; decisión del promotor, 2026-11-13: solo avisar) | 5.3 | 261 | Abogado + Paycomet | abierto |
| L-099 | Avisos a quienes donaron sin consentimiento de comunicaciones | 4.4a | 336 | Abogado | abierto |
| L-100 | Pago directo al IBAN de un proveedor | 4.4a | 337 | Abogado | abierto |
| L-101 | Factura o proforma del proveedor obligatoria | 4.4a | 338 | Abogado | abierto |
| L-102 | Fotos Antes / Después solo tras la liquidación | 4.4a | 339 | Abogado | abierto |
| L-103 | Papel de KORUM en los avisos a quienes donaron | 4.4a | 340 | Abogado | abierto |
| L-104 | Pago a un tercero y verificación del beneficiario | 4.4a | 341 | Abogado | abierto |
| L-105 | Qué ve quien firma del IBAN del proveedor | 4.4a | 342 | Abogado | abierto |
| L-106 | Facturas subidas y no adjuntadas | 4.4a | 343 | Abogado | abierto |

#### Paquete 7 · Votación de redimensionamiento y devoluciones (7 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-074 | «Reenviarme mi enlace de voto» | 5.5b | 297 | Abogado | abierto |
| L-107 | Votación vinculante para quien no vota | 4.4b | 347 | Abogado | resuelto |
| L-108 | Mayoría simple sin quórum, una persona un voto sea cual sea el importe | 4.4b | 348 | Abogado | abierto |
| L-109 | Derecho de devolución | 4.4b | 349 | Abogado | abierto |
| L-110 | El enlace del email como única identificación | 4.4b | 350 | Abogado | abierto |
| L-111 | Avisos sin consentimiento de comunicaciones | 4.4b | 351 | Abogado | abierto |
| L-112 | Conservación de los votos | 4.4b | 352 | Abogado | abierto |
| L-113 | Una campaña vencida sin decidir | 4.4b | 353 | Abogado | abierto |

#### Paquete 8 · Portería y sorteo (14 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-072 | Pase de una papeleta de rifa | 5.6 | 292 | Abogado | abierto |
| L-122 | Voluntarios sin cuenta que entran con un PIN compartido | 4.5 | 372 | Abogado | abierto |
| L-123 | Lista de pases y cola de lecturas en el móvil del voluntario | 4.5 | 373 | Abogado | abierto |
| L-124 | Conservación de las lecturas de portería (`TicketCheckIn`, `GateSession`) | 4.5 | 374 | Abogado | abierto |
| L-125 | El Super-Admin no entra en la portería ni crea PIN | 4.5 | 375 | Abogado | abierto |
| L-126 | Lectura sin cobertura | 4.5 | 376 | Abogado | abierto |
| L-127 | La cámara del voluntario | 4.5 | 377 | Abogado | abierto |
| L-128 | Sorteo certificado | 4.5 | 378 | Abogado | abierto |
| L-129 | Sorteo desde el día del evento | 4.5 | 379 | Abogado | abierto |
| L-130 | Evento sin el aforo completo | 4.5 | 380 | Abogado | abierto |
| L-131 | Ronda extra por una sola persona firmante | 4.6 | 384 | Abogado | abierto |
| L-132 | Qué ven quienes participaron | 4.6 | 385 | Abogado | abierto |
| L-133 | Nombre de quien hace la ronda extra en el aviso por email | 4.6 | 387 | Abogado | abierto |
| L-134 | El enlace de la portería es una credencial compartida por WhatsApp | 4.6 | 388 | Abogado | abierto |

#### Paquete 9 · Consola, soporte de KORUM, auditoría y trazabilidad (20 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-051 | Email directo de KORUM al centro | 5.3 | 262 | Abogado + Paycomet | abierto |
| L-052 | Soporte de KORUM ve el email de quien escribe | 5.3 | 263 | Abogado + Paycomet | abierto |
| L-054 | Texto del email directo y conservación | 5.3 | 265 | Abogado + Paycomet | abierto |
| L-055 | Aceptar un aviso de precios con una nota | 5.3 | 266 | Abogado + Paycomet | abierto |
| L-056 | Cambio global del límite exento | 5.3 | 267 | Abogado + Paycomet | abierto |
| L-059 | Alta de nuevas personas con acceso total a la consola | 5.4 | 273 | Abogado + Paycomet | abierto |
| L-060 | Historial de ajustes | 5.4 | 274 | Abogado + Paycomet | abierto |
| L-061 | «Probar conexión» de Paycomet y del email (suposiciones hasta tener cuentas de pruebas) | 5.4 | 275 | Abogado + Paycomet | abierto |
| L-062 | Qué ve cada entidad de su registro de actividad | 5.8a | 279 | Abogado | abierto |
| L-063 | Rastros nuevos y su base jurídica | 5.8a | 280 | Abogado | abierto |
| L-064 | Plazos | 5.8a | 281 | Abogado | abierto |
| L-065 | Deber del encargado de informar de sus accesos (art. 28.3.h RGPD) | 5.8a | 282 | Abogado | abierto |
| L-066 | Filas que nacen de las familias | 5.8a | 283 | Abogado | abierto |
| L-067 | Derecho de acceso y supresión sobre los rastros de seguridad | 5.8a | 284 | Abogado | abierto |
| L-068 | Aviso a la persona | 5.8a | 285 | Abogado | abierto |
| L-069 | Texto del panel sobre la inalterabilidad del registro | 5.8a | 286 | Abogado | abierto |
| L-070 | Auto-Impulso en el registro de la entidad | 5.8a | 287 | Abogado | abierto |
| L-071 | Expediente exportable (Sprint 5.8b, construido con el criterio más prudente; DECISIONES §2.31) | 5.8a | 288 | Abogado | abierto |
| L-073 | Declaración de accesibilidad | 5.5b | 296 | Abogado | abierto |
| L-075 | IndexNow | 5.5b | 298 | Abogado | abierto |

#### Paquete F · Asesoría fiscal (22 abiertos)

| ID | Punto | Origen | Línea en CUMPLIMIENTO | Para | Estado |
| :-: | :--- | :-: | :-: | :--- | :-: |
| L-024 | Tratamiento de lo recibido por colegios privados con ánimo de lucro | varios | 214 | Asesoría fiscal | abierto |
| L-025 | IVA del fee a comercios, de la cuota de mantenimiento y de la aportación voluntaria a KORUM | varios | 215 | Asesoría fiscal | abierto |
| L-026 | Proveedor de facturación Verifactu y fecha de obligatoriedad aplicable | varios | 216 | Asesoría fiscal | abierto |
| L-027 | Formato y contenido del Modelo 182 y del justificante sin efectos fiscales | varios | 217 | Asesoría fiscal | abierto |
| L-028 | Certificado de donación y justificante de Mi cuenta (Sprint 3.7): texto de la hoja (`account.documents.sheet.`: «la… | varios | 218 | Asesoría fiscal | abierto |
| L-029 | Gestión de Mi Hucha | 3.8 | 222 | Asesoría fiscal | abierto |
| L-030 | Persona de contacto del fichero | 4.1 | 226 | Asesoría fiscal | abierto |
| L-031 | Campañas sin resolver | 4.1 | 227 | Asesoría fiscal | abierto |
| L-032 | Declaración complementaria o sustitutiva | 4.1 | 228 | Asesoría fiscal | abierto |
| L-033 | Texto sin Ley 49/2002 verificada | 4.1 | 229 | Asesoría fiscal | abierto |
| L-034 | El Super-Admin no descarga el Modelo 182 | 4.1 | 230 | Asesoría fiscal | abierto |
| L-114 | Finalidad que cambia al redimensionar | 4.4b | 357 | Asesoría fiscal | abierto |
| L-135 | Fee de un cobro tardío | 4.2f | 392 | Asesoría fiscal | abierto |
| L-136 | Momento de la rectificativa al no admitir a un comercio | 4.2f | 393 | Asesoría fiscal | abierto |
| L-137 | Naturaleza del 100 % del comercio que acaba en la entidad | 4.2f | 394 | Asesoría fiscal | abierto |
| L-138 | Dinero del Fondo liquidado a la entidad | 4.2f | 395 | Asesoría fiscal | abierto |
| L-139 | Rectificativa al no admitir a un comercio | 4.2b | 399 | Asesoría fiscal | abierto |
| L-140 | Contracargo de un comercio ya facturado | 4.2b | 400 | Asesoría fiscal | abierto |
| L-141 | Proveedor Verifactu y rectificativas: el registro de alta de una `R1` necesita `TipoRectificativa = I`,… | 4.2b | 401 | Asesoría fiscal | abierto |
| L-142 | Devolución del fee y su IVA | 4.2b | 402 | Asesoría fiscal | abierto |
| L-143 | Factura del fee de cada renovación anual (una por año, en la serie normal) | 4.2d | 308 | Asesoría fiscal | abierto |
| L-144 | Dinero de un comercio que acaba en la entidad sin campaña concreta: ¿patrocinio o donación? | 4.2d | 308 | Asesoría fiscal | abierto |
