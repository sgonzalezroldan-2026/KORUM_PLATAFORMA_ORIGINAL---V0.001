# Cumplimiento legal y privacidad · KORUM v8.5

> Documento que manda en lo legal y en las decisiones de negocio con impacto legal. **No es asesoramiento jurídico:** recoge las decisiones del promotor, cómo se aplican en el producto y las preguntas que deben validar un abogado, una asesoría fiscal y Paycomet antes de ir a producción (§9).

---

## 1. Qué es KORUM (y qué no es)

- KORUM es una **plataforma tecnológica**: software para que entidades organicen campañas, taquillas, rifas, ideas y comercios colaboradores.
- **No es un banco, no está regulada como entidad financiera ni pretende estarlo, y no custodia fondos.** Los cobros, retenciones, repartos y devoluciones los ejecuta **PAYCOMET**, entidad de pago autorizada por el Banco de España, que es quien está regulada.
- **Consecuencias en el producto:**
  - Se **eliminan** de la landing todos los sellos de confianza que daban a entender regulación de KORUM (los de "PSD2 Banco de España" y "exención CNMV").
  - Los textos públicos siguen la Regla 03 §4: nada de "cuenta bancaria", "banco" o "regulado" aplicado a KORUM; "Escrow" solo como término interno.
  - Se puede decir, con la redacción exacta que apruebe Paycomet: *"Los pagos los procesa PAYCOMET, entidad de pago autorizada por el Banco de España."*

---

## 2. Paycomet: lo que se da por bueno y lo que hay que confirmar por escrito

> **Estado: aplazado por decisión del promotor (29-10-2026).** Las preguntas siguen vigentes pero se envían más adelante; hasta entonces se construye contra el simulador. Es requisito previo a cobrar dinero real (Sprints 6.1 y 6.2). Ver «Tareas externas aplazadas» en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).

**Según el promotor**, Paycomet está pensado para retener los cobros de una iniciativa y devolverlos sin coste si no se consigue la meta, igual que hace Mangopay. El producto se diseña así.

**Según la documentación pública de *split transfer* de Paycomet** (consultada en octubre de 2026):

- Los cobros quedan como **saldo** del producto que los generó hasta que se reparten o se retiran.
- Un reparto solo puede ejecutarse **si no han pasado más de 90 días desde el cobro inicial**. Por eso las campañas duran como máximo 60 días.
- Los repartos van a **cuentas destino dentro de Paycomet**, identificadas por su *Split Id*.

**Preguntas para confirmar por escrito (contrato o anexo):**

1. ¿Se pueden retener los cobros de cada iniciativa hasta 90 días y repartirlos solo si se alcanza la meta? ¿Hay algún límite de saldo retenido?
2. ¿Las devoluciones de Bizum y de tarjeta tienen coste? ¿Hasta cuántos días después del cobro se pueden hacer por cada método?
3. ¿Se puede pagar directamente al IBAN de un tercero (el proveedor elegido por la entidad), o solo a la cuenta destino de la entidad?
4. ¿Quién hace el KYB de cada entidad (alta como cuenta destino) y qué documentos pide?
5. Contracargos: proceso, plazos y quién asume el importe si la iniciativa ya se liquidó.
6. Cobros recurrentes con tarjeta tokenizada (`JET-ID`) para la aportación mensual de Mi Hucha y la renovación de comercios: requisitos de autenticación reforzada (SCA) en el primer cobro y en los siguientes.
7. ¿Ofrece Paycomet monederos con saldo a nombre de cada usuario (necesario para el modo `REGULATED_WALLET` de Mi Hucha)?
8. Redacción aprobada para mencionar a Paycomet en la web, los emails y los recibos, y uso de su logotipo.
9. Repartos: la API exige citar el cobro original en cada *split transfer*. ¿Una liquidación son tantos repartos como cobros? ¿El tope de cada uno es lo cobrado en ese pedido, o se puede repartir el saldo global? ¿Hay límite de repartos o una forma de agruparlos?
10. Notificaciones: formato del cuerpo (formulario o JSON), valor de `Response` en un fallo, zona horaria de `BankDateTime`, política de reintentos y qué respuesta espera Paycomet. ¿Devolver más de lo cobrado se rechaza siempre, también con reintentos tras un corte de conexión?

---

## 3. Mi Hucha: modelo Wallapop + Mangopay, sin que KORUM guarde dinero

**Decisión del promotor:** una Hucha parecida a la de Wallapop con Mangopay, ajustada para que no genere problemas.

**El problema a evitar:** guardar saldo de las familias para que lo gasten después en distintas entidades es, en la práctica, **dinero electrónico**, y solo puede custodiarlo una entidad autorizada para ello (entidad de dinero electrónico). Wallapop puede hacerlo porque el saldo lo custodia Mangopay, no Wallapop. Paycomet figura como entidad de **pago**; si no ofrece monederos de usuario, no puede guardar ese saldo.

**Cómo queda en el producto** (ajuste `hucha.mode` de la consola):

| Modo | Experiencia para la familia | Riesgo legal |
| :--- | :--- | :--- |
| `PLEDGE` · **por defecto al lanzar** | "Mi Hucha" es una **aportación mensual programada**: la familia elige importe, entidad y duración; cada mes se cobra con su tarjeta y va directamente a una iniciativa activa. Puede pausar o cancelar en 1 clic. Ve su historial y lo que ha conseguido. | Bajo: no hay saldo guardado, son donaciones recurrentes. |
| `REGULATED_WALLET` | Hucha con saldo como en Wallapop: recarga, paga con saldo y retira al medio de pago original. | Bajo **solo si** el saldo lo custodia una entidad autorizada (Paycomet si lo ofrece, o Mangopay). Requiere contrato y validación legal. |
| `DISABLED` | No aparece. | — |

KORUM nunca envía dinero a un IBAN tecleado por el usuario, y su base de datos solo **refleja** el saldo que custodia el proveedor.

---

## 4. Titular de los fondos

**Decisión del promotor:** puede ser un **AMPA/AFA**, un **colegio privado o concertado** u **otro tipo de asociación** (club, entidad cultural, fundación).

**Cómo queda en el producto:**

- Cada organización distingue su **nombre público** (*CEIP Cervantes*) de su **titular legal** (`legalName`: *AFA CEIP Cervantes*), con su forma jurídica (`legalForm`) y la titularidad del centro (`centerOwnership`).
- **Un colegio público no puede cobrar a través de KORUM:** lo hace su AMPA/AFA. El alta lo impide.
- **Ley 49/2002:** solo fundaciones y asociaciones declaradas de utilidad pública que lo acrediten en el KYB (`ley49VerifiedAt`) emiten certificados fiscales y el Modelo 182. La mayoría de AMPAs y clubes emiten un justificante sin efectos fiscales.
- **Colegios privados con ánimo de lucro** (`SCHOOL_OWNER`): no pueden declarar Ley 49/2002, y el tratamiento fiscal de lo que reciben (¿donación, ingreso, IVA?) lo debe confirmar la asesoría antes de admitir este tipo de entidad.
- **Doble firma** entre dos personas de la entidad titular: `DIRECTOR` (gestión principal) y `COSIGNER` (Presidencia del AMPA, Tesorería del club, Representación del patronato, Titularidad del colegio…).

---

## 5. Privacidad (RGPD, LOPDGDD y LSSI)

**Decisión del promotor:** la privacidad es un elemento importante y fundamental; aplicar todas las medidas pertinentes.

### 5.1 Reparto de responsabilidades (propuesta a validar)

- **KORUM, responsable del tratamiento** de las cuentas de usuario, los pagos, la prevención del fraude y la seguridad de la plataforma.
- **Cada entidad, responsable** de la gestión de su comunidad (moderación de ideas, mensajes con las familias, datos de sus firmantes), con **KORUM como encargado del tratamiento** mediante el contrato de encargo que se acepta en el alta.
- **Proveedores de KORUM como encargados** (con contrato y alojamiento o garantías UE): Vercel, Supabase, Brevo, Sentry, Plausible, el proveedor de facturación. Paycomet actúa como responsable de sus propios tratamientos de pago.

### 5.2 Medidas aplicadas en el diseño

| Medida | Dónde |
| :--- | :--- |
| **Minimización:** de los menores solo se registra el **curso o equipo** elegido por la familia; nunca nombre, edad ni foto del menor. | Checkout, retos |
| **Personas usuarias mayores de edad:** crear cuenta, aportar o comprar exige ser mayor de 18 años (condiciones de uso). | Alta y checkout |
| **Cifrado** de NIF, tokens de pago y secretos; **HMAC** para lo que hay que buscar (NIF, IP, huella). | Esquema y Regla 01 |
| **Antifraude proporcionado:** cookie propia de dispositivo (necesaria para la votación segura que la persona pide), subred IP como HMAC y huella del navegador **solo con consentimiento**. | Skill de antifraude |
| **Sin cookies de terceros ni píxeles de seguimiento.** Analítica sin cookies (Plausible). Si algún día se activan cookies no esenciales, banner con "rechazar" igual de visible que "aceptar". | Toda la web |
| **Datos en la UE** y contratos de encargo con cada proveedor. | Decisiones técnicas |
| **Derechos en autoservicio** desde *Mi cuenta*: acceso, exportación, rectificación, supresión y retirada de consentimientos. Respuesta en menos de un mes. | Sprint 3.7 (hecho: acceso y exportación en JSON y PDF, supresión y retirada de la huella, con código por email antes de exportar o suprimir) / 3.9 (hecho: rectificación por el formulario de soporte, con código por email y solicitud con plazo de un mes) |
| **Fotos Antes/Después sin menores identificables** (casilla obligatoria al subir, registrada en `AuditLog`), **sin metadatos EXIF** y responsabilidad de la entidad sobre los permisos de imagen. | Sprint 3.6 (hecho) / 4.4 |
| **Nada personal indexable** en buscadores ni en asistentes de IA. | Skill de SEO |
| **Registro de auditoría** sin datos personales en claro. | `AuditLog` |
| **Gestión de brechas:** detección (Sentry, conciliación), evaluación y notificación a la AEPD en 72 h cuando proceda. | Manual de operación (Sprint 6.1) |

### 5.3 Evaluación de impacto

Se recomienda una **evaluación de impacto (EIPD)** antes del lanzamiento: hay perfiles antifraude, datos relacionados con el entorno escolar de menores y tratamiento a escala de muchas entidades.

---

## 6. Plazos de conservación (propuesta a validar)

| Dato | Plazo | Después |
| :--- | :--- | :--- |
| Asientos contables, aportaciones, facturas, webhooks de pago | 6 años desde el cierre del ejercicio | Borrado |
| Recuento de notificaciones rechazadas por firma inválida (`rejected:*`) | 90 días | Borrado |
| Documentos KYB de la entidad | Mientras dure la relación + 6 años | Borrado |
| Datos fiscales del donante (NIF, provincia) | 6 años | Borrado |
| Cuenta de usuario sin actividad | 3 años | Aviso y anonimización a los 30 días |
| Auditoría de firmas de ideas | Vida de la idea + 1 año | Anonimización |
| Chat anónimo de una idea (mensajes de la familia) | Vida de la idea + 1 año; o al suprimir la cuenta | Borrado (las respuestas del centro se conservan, sin nadie detrás) |
| Consultas de soporte (email, asunto, mensaje y respuesta) | 2 años desde que se resuelven (o desde que se abren, si nunca se resuelven); o el email y el texto, al suprimir la cuenta | Se vacían email y textos; queda la fila (código, tema y fechas) para las estadísticas |
| Cookie de dispositivo | 13 meses | Caduca |
| HMAC de IP y huella | 12 meses | Borrado |
| Registro de auditoría | 6 años | Borrado |
| Notificaciones enviadas | 12 meses | Borrado del contenido, se conserva el hecho del envío |
| Consentimientos | Mientras estén vigentes + 3 años | Borrado |
| Tarjeta guardada de Mi Hucha (token de Paycomet, cifrado) | Mientras la aportación mensual esté activa o en pausa (pausa máxima: 6 meses) | Se revoca al momento y se pide a Paycomet que la borre al cancelar, terminar, pasar 6 meses en pausa, haber un contracargo o suprimir la cuenta; la purga semanal reintenta el borrado |
| Errores en Sentry | 90 días | Automático |

La tarea `DATA_RETENTION_PURGE` aplica esta tabla (semanal, Sprint 2.5; los números viven en `src/core/privacy/retention-policy.ts`). **Cómo se ha construido, a validar por el abogado (ficha 6.1):**

- **Asientos, aportaciones y auditoría no se borran** a los 6 años: el libro mayor y la auditoría son inmutables por diseño (triggers). En su lugar se **anonimiza** lo personal de las aportaciones (NIF, nombre, provincia y emails) y de la auditoría (IP y navegador, a los 12 meses); importes y fechas se conservan sin nadie identificable detrás.
- **Supresión a petición (derecho al olvido):** anonimiza la cuenta, sus compras como invitada, entradas, dispositivos, firmas de ideas y mensajes; borra sesiones, credenciales y tarjetas (también en Paycomet). Conserva, por obligación legal (RGPD art. 17.3.b), el NIF, el nombre y la provincia de las **donaciones con certificado fiscal**, hasta que vence su plazo. No se puede suprimir a quien firma en una entidad (primero se le da de baja del cargo) ni con saldo en el monedero regulado.
- **Cuenta sin actividad:** a los 3 años se escribe el aviso `privacy.inactivityNotice`; si no vuelve en 30 días, se suprime como arriba.
- **Solicitudes RGPD:** vencen al mes; fuera de plazo, alerta crítica en la consola.

---

## 7. Consumidores, rifas y transparencia

- **Aportación voluntaria a KORUM:** **check desmarcado por defecto** (decisión del promotor; las casillas premarcadas para pagos adicionales no son válidas con consumidores). El texto deja claro que es opcional y que las garantías se dan a todas las familias (Regla 03 §3).
- **Entradas de eventos con fecha concreta:** no tienen derecho de desistimiento (servicios de ocio en fecha determinada), lo que debe informarse antes del pago.
- **Rifas:** son competencia autonómica y pueden requerir comunicación o autorización según su importe. El Estudio muestra un aviso y exige que la entidad confirme que cumple la normativa de su comunidad antes de publicar.
- **Información previa al pago:** quién recibe el dinero (titular legal de la entidad), qué pasa si no se llega a la meta, comisiones visibles y datos de KORUM como prestador del servicio.

---

## 8. Registro de decisiones de negocio con impacto legal

| # | Decisión | Quién | Estado |
| :--- | :--- | :--- | :--- |
| 1 | Check de la aportación voluntaria **desmarcado** por defecto | Promotor | Aplicada (Regla 03) |
| 2 | Título y descripción de la aportación voluntaria reformulados para no dar a entender que las garantías dependen de pagarla | Propuesta técnica | Aplicada; **revisable por el promotor** |
| 3 | Mi Hucha con modelo Wallapop + Mangopay y modos `PLEDGE` / `REGULATED_WALLET` | Promotor + propuesta técnica | Aplicada; lanzamiento en `PLEDGE` |
| 4 | Escrow con Paycomet para retener y devolver sin coste | Promotor | Aplicada; pendiente de confirmación escrita (§2) |
| 5 | Eliminar los sellos que daban a entender regulación de KORUM | Promotor | Aplicada |
| 6 | Titulares de fondos: AMPA, colegio privado o concertado, otras asociaciones | Promotor | Aplicada (§4) |
| 7 | Privacidad desde el diseño | Promotor | Aplicada (§5–6) |
| 8 | Mostrar o no el Auto-Impulso en público: **decisión del Super-Admin** en cada ejecución, con valor por defecto configurable (`SHOW`) | Promotor | Aplicada |
| 9 | Campaña fallida: se devuelve el **100 % de lo cobrado**, incluida la aportación voluntaria a KORUM | Propuesta técnica | Aplicada por defecto; **revisable por el promotor** |
| 10 | Campañas de 60 días como máximo (ventana de 90 días de Paycomet) | Propuesta técnica | Aplicada |
| 11 | Las respuestas escritas de Paycomet (§2) y la revisión del abogado y de la asesoría fiscal (§9) **se aplazan hasta ver el resultado del proyecto** (29-10-2026) | Promotor | **Aplazada.** No bloquea la construcción (simulador y textos en borrador); **sí bloquea cobrar dinero real** (Sprints 6.1 y 6.2) |
| 12 | Tramos de comisión, fee de Mi Hucha y demás comisiones **configurables** por el Super-Admin; si una regla pierde dinero o es incoherente, la consola avisa y decide el Super-Admin (puede aceptar y registrar la pérdida) | Promotor | Aplicada ([DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6.1) |
| 13 | El logotipo de referencia es la lámina `public/brand/korum-logo.jpg`; los SVG antiguos y el sello de custodia quedan **descartados** y no se usan | Promotor | Aplicada (el sello de custodia no existe en la aplicación, coherente con la decisión 5) |

---

## 9. Lista de comprobación antes de producción

> **Estado: aplazada por decisión del promotor (29-10-2026)**, junto con las 8 preguntas a Paycomet del §2. Hasta que se resuelvan se desarrolla contra el simulador y con los textos legales en borrador; no se cobra dinero real. Ver «Tareas externas aplazadas» en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md).

**Abogado:**

- [ ] Condiciones de uso, política de privacidad, aviso legal y política de cookies (en es, ca y en).
- [ ] Contrato de encargo del tratamiento con las entidades y reparto de responsabilidades (§5.1).
- [ ] Validez del diseño antifraude (cookie de dispositivo sin consentimiento, huella con consentimiento) frente a la LSSI art. 22.2.
- [ ] **Buzón de ideas (Sprint 3.6) · cookie de dispositivo:** texto del aviso que se muestra al firmar (`portal.ideas.protection.cookie`): cookie propia `korum_device` (`HttpOnly`, `Secure`, 13 meses), necesaria para la votación segura que la persona pide y creada solo al firmar. ¿Basta el aviso o hace falta otro mecanismo (LSSI art. 22.2)?
- [ ] **Buzón de ideas (Sprint 3.6) · consentimiento de la huella del navegador:** texto de la casilla (`portal.ideas.protection.checkboxHelp`: «código seudónimo calculado con datos técnicos del navegador… para reconocer este dispositivo aunque se borren las cookies»), que empieza desmarcada, que se retira con un clic en el propio buzón y que la versión que se guarda en cada consentimiento es `privacy.policyVersion` (por defecto `2026-11-01`: ¿a qué texto publicado apunta?). ¿Es un consentimiento informado y retirable con el mismo esfuerzo (RGPD art. 7)?
- [ ] **Buzón de ideas (Sprint 3.6) · anonimato y datos de la idea:** la idea se muestra solo con el código `#FAM-XXXX` y el recuento de firmas verificadas; se guarda el email canónico de quien propone y de quien firma (no se enseña), la subred IP y la huella solo como HMAC, y las ideas llevan `noindex`. Confirmar la base jurídica, los plazos de conservación de esas firmas y la auditoría (§6) y que el alias sobrevive a la supresión de la cuenta sin identificar a nadie.
- [ ] **Buzón de ideas (Sprint 3.6) · firmas sospechosas:** los textos que se dan a quien firma desde un dispositivo con varias cuentas o en ráfaga (`portal.ideas.result.signedReview` y `signedBurst`: «por ahora no suma al recuento») y el registro de esas firmas en la auditoría del centro. ¿Es una decisión automatizada con efectos sobre la persona (RGPD art. 22) y qué vía de revisión debe ofrecerse?
- [ ] **Fotos Antes / Después (Sprint 3.6) · menores y derechos de imagen:** texto de la casilla obligatoria «En la foto no aparecen menores identificables» (`panel.achievements.minorsLabel` y `minorsHelp`), que la responsabilidad sobre los permisos de imagen es de la entidad, que la confirmación queda auditada y que las fotos se publican sin metadatos. ¿Hace falta además un procedimiento para retirar una foto a petición de una familia y un plazo?
- [ ] **Agradecimiento público del centro (Sprint 3.6):** el mensaje que escribe la entidad a las familias (`Initiative.thanksMessage`) es público; el formulario avisa de no poner nombres de personas ni de menores. ¿Basta el aviso?
- [ ] **Mi cuenta (Sprint 3.7) · supresión de la cuenta:** el texto que se enseña antes de suprimir (`account.erase.deleted`, `kept` y `signIn`): qué se borra, que se conservan sin identificar a nadie los importes y fechas de las aportaciones, y que la entidad conserva 6 años el NIF, el nombre y la provincia de las donaciones con certificado (Modelo 182). ¿Es correcta la base legal (RGPD art. 17.3.b) y el plazo? ¿Debe avisarse también a la entidad? Tras suprimir quedan códigos irreversibles (HMAC) del email, que impiden volver a firmar la misma idea y evitar un segundo aviso fiscal: son datos seudonimizados; ¿es correcta la redacción de la confirmación (`account.erase.done.*`: «ya no guardamos tu nombre ni tu email; solo queda un código irreversible…»)? El texto dice que «la entidad debe guardar» los datos fiscales, pero técnicamente los conserva KORUM por cuenta de la entidad: ¿cómo debe decirse?
- [ ] **Mi cuenta (Sprint 3.7) · exportación de datos:** la persona confirma su identidad con un código por email y descarga al momento un JSON y un PDF con todo lo que KORUM guarda de ella (sin tarjetas ni secretos); cada descarga queda como solicitud `EXPORT` atendida. ¿Cumple los arts. 15 y 20 RGPD tal cual o hace falta incluir algo más (destinatarios, plazos de conservación, origen de los datos)?
- [ ] **Mi cuenta (Sprint 3.7) · rectificación:** no se puede cambiar el nombre ni el email desde *Mi cuenta*; la vía es el formulario de soporte con el tema «Corregir mis datos personales» (Sprint 3.9), que pide confirmar la identidad con un código por email, abre una `PrivacyRequest` `RECTIFICATION` con plazo de un mes y la deja visible en «Mis solicitudes». ¿Basta con ese canal? Cambiar el email de la cuenta exige además comprobar que la persona controla el nuevo (a definir con la consola, Sprint 5.x).
- [ ] **Chat anónimo de las ideas (Sprint 3.9):** el centro solo ve el código `#FAM-XXXX`; la familia escribe texto libre que puede contener datos personales (el aviso dice «no escribas tu nombre ni el de tus hijos», `account.proposals.privacyHint`). Plazos: se borra al suprimir la cuenta y al año de cerrarse la idea (§6). ¿Basta el aviso y esa conservación? El mensaje de rechazo del centro (Sprint 4.2) debe evitar datos de la familia.
- [ ] **Soporte (Sprint 3.9):** para escribir hace falta una cuenta con el email verificado (decisión de producto: la consulta es de quien la envía y tiene su código); se guarda el email, el asunto y el mensaje 2 años desde que se resuelve (§6) y se incluyen en la exportación de datos. Una consulta sobre una iniciativa va al centro: **el centro no debería ver el email de quien escribe** (se le contesta desde la plataforma), a aplicar en el panel (Sprint 4.5). Textos de `portal.help.*` (preguntas frecuentes: no prometen efectos fiscales ni garantías legales) y del email `support.received`.
- [ ] **Soporte y chat (Sprint 3.9) · puntos que deja la auditoría de seguridad:** (a) **«Mis firmas» no usa la marca anónima de una supresión anterior** (quien vuelve empieza vacío, como dice el texto de la supresión): confirmar que es la lectura correcta; (b) **la exportación (art. 15) enseña el estado y el motivo antifraude de las firmas propias** (`SUSPICIOUS`, `ideas.audit.*`, desde el 3.7), lo que contradice la política de no avisar a quien intenta un fraude: ¿se limita con base en el art. 23 / LOPDGDD o se acepta?; (c) **la rectificación exige una cuenta con el email verificado y no desechable**: ¿qué canal alternativo se ofrece (email de privacidad de la política) para quien no puede entrar? (art. 12.2); (d) plazo de conservación de las **respuestas del centro** en el chat y de la **descripción de las ideas** (texto libre de la familia; hoy solo está el plazo de la auditoría de firmas); (e) las consultas a KORUM, incluida la rectificación, guardan `organizationId`: el panel (Sprint 4.5) debe enseñar al centro solo las de `target = ORGANIZATION` y **nunca el email de quien escribe**; (f) la FAQ dice que las firmas sospechosas «no suman hasta que se revisen»: la revisión llega con el Sprint 4.2.
- [ ] **Mi Hucha (Sprint 3.8) · aportación mensual:** textos del alta (`hucha.form.*`: importe, duración, «la tarjeta la guarda Paycomet, KORUM nunca la ve; si cancelas o termina, la borramos», resumen con el máximo total) y de los emails `pledge.charged`, `pledge.skipped` y `pledge.failed`. ¿Hace falta un documento aparte de condiciones de la donación recurrente (mandato, cancelación en cualquier momento, sin permanencia)? Hoy, como prueba del mandato, se guarda la versión de los textos legales aceptada (`WalletSubscription.termsVersion`) y cada alta, pausa, reanudación, cambio y cancelación queda en `AuditLog`: ¿basta? Y el plazo máximo de 6 meses en pausa antes de cancelarla y borrar la tarjeta (`PLEDGE_MAX_PAUSE_DAYS`).
- [ ] **Llaves de acceso (Sprint 3.7):** texto de *Mi cuenta* («la llave se queda en tu dispositivo: KORUM nunca ve tu huella ni tu cara»). Confirmar que no hay tratamiento de datos biométricos por parte de KORUM (la verificación la hace el dispositivo).
- [ ] Si, con el consentimiento de una persona, los dispositivos con la misma huella y red pueden contar también las cuentas de quien no consintió y comparte ese dispositivo.
- [ ] EIPD (§5.3) y plazos de conservación (§6).
- [ ] Textos del checkout, de la aportación voluntaria y del aviso de rifas.
- [ ] Modo `REGULATED_WALLET` de Mi Hucha, si se quiere activar.
- [ ] Publicación o no del Auto-Impulso frente al mensaje "lo han conseguido las familias".

**Asesoría fiscal:**

- [ ] Tratamiento de lo recibido por colegios privados con ánimo de lucro.
- [ ] IVA del fee a comercios, de la cuota de mantenimiento y de la aportación voluntaria a KORUM.
- [ ] Proveedor de facturación Veri\*factu y fecha de obligatoriedad aplicable.
- [ ] Formato y contenido del Modelo 182 y del justificante sin efectos fiscales.
- [ ] **Certificado de donación y justificante de *Mi cuenta* (Sprint 3.7):** texto de la hoja (`account.documents.sheet.*`: «la entidad, acogida al régimen fiscal de la Ley 49/2002, certifica que ha recibido esta donación de forma irrevocable»), datos que lleva (referencia, entidad y su NIF, donante, NIF, provincia, iniciativa, importe, fecha y ejercicio) y si el certificado lo emite la entidad o KORUM en su nombre. Hoy lleva la leyenda **BORRADOR**. ¿Falta algún dato obligatorio (domicilio de la entidad, mención expresa al art. 24 de la Ley 49/2002, firma o código de verificación)?

**Asesoría fiscal (Sprint 3.8):**

- [ ] **Gestión de Mi Hucha:** se cobra encima de cada mes (0,25 € por defecto) como ingreso de KORUM y no entra en el certificado fiscal. ¿IVA de esa gestión y cómo se documenta para la familia (hoy solo figura en el email mensual)?

**Asesoría fiscal (Sprint 4.1 · Modelo 182 del panel):**

- [ ] **Persona de contacto del fichero:** es quien descarga (su nombre de cuenta, tal cual, no «apellidos y nombre» como pide el diseño de la AEAT) y el teléfono lo escribe esa persona (se precarga el de la ficha, que hoy es el móvil de quien dirige). ¿Puede presentarlo la persona cofirmante? ¿Hay que avisar a quien firma de que su nombre y teléfono van a la AEAT?
- [ ] **Campañas sin resolver:** las donaciones de campañas `FUNDRAISING`, `EXPIRED` o `RESIZE_VOTING` entran en el fichero y se señalan; las de campañas que se devuelven (`REFUNDING`) o se cancelaron (`CANCELLED`) **no** entran (un dinero que se devuelve no es un donativo irrevocable, Ley 49/2002 art. 24). Confirmar el criterio y si se debe esperar a que se resuelva la campaña antes de presentar.
- [ ] **Declaración complementaria o sustitutiva:** el número de justificante es fijo (`182{año}000001`) y las posiciones 121-122 van en blanco; no hay ruta para sustituir un fichero ya presentado.
- [ ] **Texto sin Ley 49/2002 verificada** (`panel.model182.notVerified`): «justificante nominativo de aportación, sin efectos fiscales».
- [ ] **El Super-Admin no descarga el Modelo 182** de ninguna entidad (minimización de los NIF de las familias); solo lo hacen las personas firmantes de la propia entidad.

**Abogado (Sprint 4.1 · kit de medallas):**

- [ ] Un sello público «Comunidad Impulsora KORUM» y un informe en PDF pensados para difundirse entre las familias: el informe dice «PAYCOMET, entidad de pago autorizada por el Banco de España» (usar la redacción que apruebe Paycomet en el contrato) y «se devuelve el 100 % de lo cobrado» (existe también la vía del redimensionamiento por votación).
- [ ] La cifra «Recaudado» del informe sale de `raisedCents`, que incluye el bonus *Matching 2x* de comercios y, cuando exista, el Auto-Impulso: enlaza con el punto abierto de la publicación del Auto-Impulso frente a «lo han conseguido las familias».

**Paycomet:** las 8 preguntas del §2, por escrito. Del Sprint 3.8, además: (a) cómo pedir en `/v1/form` que el primer pago guarde la tarjeta para cobros recurrentes (se ha supuesto `trxType: 'R'`) y si su notificación trae `IdUser` y `TokenUser` (fuera de la firma); (b) los campos de un cobro iniciado por el comercio sin la persona (se ha supuesto `secure: 0`, `trxType: 'R'`, `scaException: 'MIT'`) y qué IP enviar (se usa la del servidor); (c) si un cobro recurrente puede volver con petición de autenticación (hoy se trata como rechazo y se pausa); (d) **cómo autenticar `IdUser` y `TokenUser` de la notificación**, que no entran en la firma: antes de cobros reales hay que comprobarlos contra la operación del pedido (consulta a Paycomet) o confirmar que van firmados (auditoría del 3.8); (e) qué datos de recurrencia pide la autenticación 3DS del primer pago (frecuencia y fecha de fin) para que los bancos no exijan autenticarse cada mes; (f) si Paycomet guarda la tarjeta aunque KORUM no la registre y cómo pedir que la borre.

---

## Fuentes consultadas (octubre de 2026)

- Paycomet · Split Transfer Integration: https://docs.paycomet.com/en/documentacion/split-transfer-marketplace
- Calendario de Veri\*factu (Real Decreto-ley 15/2025 y aplazamiento anunciado): https://www.billin.net/blog/hacienda-retrasa-verifactu-a-2027/ · https://wwwhatsnew.com/2026/10/26/verifactu-factura-electronica-obligatoria-autonomos-fechas/
