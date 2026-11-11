# PRD funcional · KORUM v8.5

> **Base funcional:** conserva cada función de `prototype/Korum_v8.html` (acciones, datos, filtros, columnas, alertas e imprimibles) y la eleva con céntimos enteros, libro mayor de doble partida, Paycomet, fiscalidad, multi-vertical, idiomas (es/ca/en), tarjetas para WhatsApp y modo portería. Cómo se vive cada pantalla: [EXPERIENCIA_DE_PRODUCTO.md](EXPERIENCIA_DE_PRODUCTO.md).

---

## 1. Entorno 1 · Portal público de familias, socios y comercios (`/[orgSlug]`)

### 1.1 Cabecera de la entidad y barra de impacto

- **Identidad por entidad:** logo (o icono según vertical: `🏫` / `🏀` / `🎵`), nombre público, lema, colores propios (`--brand-primary`, `--brand-secondary`) y portada opcional. En el pie, el titular legal que recibe los fondos.
- **Acceso a Mi Hucha** según su modo (ver §1.8): píldora con saldo en `REGULATED_WALLET`, botón *"Aportar cada mes"* en `PLEDGE`, oculto en `DISABLED`.
- **Banda de impacto del curso o temporada:** total conseguido y acceso a *Mejoras logradas (Antes y Después)*.
- **Selector de idioma** (es / ca / en) en cabecera y pie.

### 1.2 Navegación y filtros ocultos por defecto

- **5 pestañas:** `🚀 Iniciativas y taquilla`, `💡 Buzón de ideas`, `🎉 Logros conseguidos`, `🏪 Comercios amigos`, `❓ FAQ y soporte`.
- **`🔍 Filtrar`:** los filtros (categoría, urgencia o formato, etapa o categoría deportiva) están ocultos al cargar; se despliegan con el botón, que muestra un contador y *Limpiar filtros*.

### 1.3 Iniciativas en `FUNDRAISING` y viralidad en WhatsApp

- Solo se listan iniciativas en `FUNDRAISING` (destacando `⚡ Bono multiplicador 2x activo` si tienen *Matching 2x*). Al llegar al 100 % pasan a `GOAL_REACHED` y se cierran a nuevas aportaciones.
- **`💛 X aportaciones`** bajo la barra (aportaciones completadas de personas y comercios; el Auto-Impulso no cuenta).
- **Compartir (`📤`):** cada enlace (`/api/og/initiative/[id]?grupo=...`) genera una tarjeta con el logo de la entidad, el porcentaje, los días restantes y el reto del curso o equipo, siempre en positivo.

### 1.4 Ficha pública de la iniciativa (`.mobile-stack`)

- **Sin barra de 6 pasos:** solo la **hucha de la iniciativa (`WLT-ESC-XXX`)** y la **fecha límite**, más *"Si no se llega a la meta, se devuelve el 100 %"*.
- **Reto colectivo** (`rewardEnabled`) con el progreso por curso, equipo o grupo, y **placa conmemorativa** (`plaqueEnabled`), independientes.
- **Desglose público de 4 líneas** si `showPublicBreakdown`, que suman exactamente la meta (Regla 02 §1), con la nota de transparencia de la Regla 03 §3. Si está desactivado, sello de *presupuesto validado por la doble firma de la entidad*.

### 1.5 Checkout dual (familias, taquilla y comercios)

- **Modo 1 · Familia, socio o vecino (10 s, sin registro):**
  - Invitado: un único campo `📧 Tu email para enviarte al instante tu recibo o tus entradas QR`.
  - Botones de importe configurados por la entidad con uno sugerido (`⭐`) + importe libre.
  - Grupo de participación según el vertical: 13 cursos + 2 de comunidad (`SCHOOL`), categorías deportivas + afición (`SPORTS_CLUB`) o grupos culturales (`CULTURAL`).
  - **Aportación voluntaria a KORUM con el check desmarcado** y el texto exacto de la Regla 03 §3 (punto 3 según `ley49` verificada), con selector manual desde 0 €.
  - **NIF opcional** ("Quiero mi certificado fiscal") solo en entidades con Ley 49/2002 verificada.
  - Pago con Bizum, tarjeta, Apple Pay o Google Pay (y saldo de Mi Hucha solo en `REGULATED_WALLET`).
  - Tras pagar: pantalla de celebración con el nuevo progreso y la opción de compartir.
- **Modo 2 · Taquilla y rifas:** selector `-` / `+` con **aforo atómico** (`ticketMax − ticketsSold`), desglose de precio + *"Gastos de gestión digital"*, y pase o papeleta numerada con QR firmado (`#PASE-2026-XXXX` / `#RIFA-2026-XXXX`, números `#0001`–`#N`) enviado por email.
- **Modo 3 · Comercio (100 % íntegro + fee encima):** categoría `🥉 BRONCE`, `🥈 PLATA ⭐` u `🥇 ORO` (con opción de destinarlo a *Matching 2x*), datos fiscales, cupón para familias y renovación anual con enlace de pago (sin tarjeta guardada) y preaviso de 30 días; su dinero solo se devuelve si la entidad no lo admite; justificante del 100 % + factura de KORUM registrada en Veri\*factu.

### 1.6 Buzón de ideas (quórum con regla padre/madre en servidor)

- Propuestas con alias privado (`#FAM-XXXX`) y moderación previa (Fase 0).
- `✍️ Firmar apoyo` exige email verificado y canónico: 1 firma por persona e idea.
- Hasta 2 cuentas por dispositivo cuentan como `🟢 Verificadas`; desde la 3ª o ante ráfagas, `⚠️ Sospechosa`. La huella del navegador solo se usa con consentimiento.
- Las ideas no se indexan en buscadores.

### 1.7 Comercios amigos

- Sin importes ni fees en público; solo `🥇 ORO`, `🥈 PLATA` o `🥉 BRONCE`, en ese orden, con la ventaja o el código para familias.

### 1.8 Mi Hucha, Mi cuenta y soporte

- **Mi Hucha según `hucha.mode`:**
  - `PLEDGE` (por defecto): aportación mensual programada a la entidad (importe, duración, iniciativa preferida), con pausa, cambio y cancelación en 1 clic e historial de lo conseguido.
  - `REGULATED_WALLET`: recarga puntual y mensual; pago con saldo; retirada **solo** al medio de pago original con el aviso oficial; saldo custodiado por una entidad autorizada.
  - `DISABLED`: no aparece.
- **Mi cuenta:** mis aportaciones, mis entradas QR, datos fiscales (NIF/NIE validado en vivo) y descarga del certificado (Ley 49/2002 verificada) o del justificante nominativo, **solo con donaciones completadas y no reembolsadas** (nunca recargas ni entradas); consentimientos; exportar mis datos; suprimir mi cuenta.
- **Chat anónimo** con la entidad (`#FAM-XXXX`), **FAQ** y **buzón de soporte** con enrutamiento a la entidad o a KORUM.
  - *Mis propuestas y mensajes con el centro* y *Mis firmas* viven en *Mi cuenta* (`/mi-cuenta/propuestas`): el centro solo ve el código; la familia puede escribir hasta 3 mensajes seguidos sin respuesta.
  - *FAQ y soporte* (`/[orgSlug]/ayuda`): preguntas frecuentes y formulario. Escribir exige una cuenta con el email verificado; cada consulta lleva su código `TCK-XXXXXX`, se contesta a la entidad (iniciativas y eventos) o a KORUM (pagos, cuenta, datos, sugerencias) y se sigue en *Mi cuenta*. «Corregir mis datos personales» abre una solicitud de rectificación con plazo de un mes.

---

## 2. Entorno 2 · Panel de la entidad (`/panel/[orgSlug]`)

1. **Cabecera, medallas y Modelo 182:** los dos firmantes con su cargo, estado del KYB, cupo exento restante, beca de medalla, botón `🏅 Sello + texto para redes` y, solo con Ley 49/2002 verificada, `📥 Descargar el Modelo 182`.
2. **Cuadro de mandos:** filtros ocultos tras `🔍 Filtrar`, 5 KPIs, línea de 6 estados con su `WLT-ESC-XXX` y acceso al Estudio. Para una entidad nueva, guía de 3 pasos.
3. **Aprobaciones, doble firma y ajustes:**
   - Ideas con auditoría de firmas (`🟢 Verificadas` / `⚠️ Sospechosas`), chat anónimo y **doble firma real (`1/2` → `2/2`) entre `DIRECTOR` y `COSIGNER`**, con enlace de un solo uso y OTP.
   - KYB (4 documentos + acreditación de Ley 49/2002 si procede), moderación y renovación de comercios (con `CREDIT_POOL` y una invitación a renovar por año a quien no lo pidió), **Fondo de actividades** (`/panel/{slug}/fondo`, Sprint 4.2f: bolsas de comercios vencidas, liquidación a la cuenta de la entidad con destino escrito, doble firma y justificante en PDF), importes de donación, grupos de participación, identidad visual, idioma del contenido e indexación pública.
4. **Estudio dual:** plantillas de campaña; presupuesto con proveedor libre o taquilla/rifa (con aviso y confirmación de normativa); candado semántico; reto y placa independientes; duración máxima de 60 días; pizarra TCO en céntimos (`0,00 €` limpio cuando no hay mantenimiento); cartel A4 con QR.
5. **Logros, liquidaciones y portería:**
   - Liquidación a la cuenta de la entidad o al proveedor, con factura adjunta y **doble firma obligatoria**; aviso de la ventana de 90 días; fotos Antes/Después; votación de redimensionamiento o reembolso del 100 % (liberando cupos y reasignando comercios o enviándolos a `CREDIT_POOL`).
   - **PIN por evento** para `/panel/[orgSlug]/porteria` (escáner con cámara, alerta ante pases usados, modo sin cobertura y sorteo certificado).

---

## 3. Entorno 3 · Consola del Super-Admin (`/admin`)

1. **BI ejecutivo:** filtros por provincia, entidad, salud y trimestre; ingresos reales del libro mayor separados de la proyección al 100 %; gráfico de las 6 fuentes cuadrado al céntimo; avisos de conciliación.
2. **Tablas ordenables (`↕`) y alertas:** rendimiento por entidad (`Cerradas (Año / Hist.)`, `Comercios (Act. / Hist.)`), top 10 y listado global (`💛 Aportaciones`), con 💎 Auto-Impulso rentable y 🚨 Retorno negativo.
3. **Pop-up ejecutivo:** enlace público, comercios participantes, **Auto-Impulso con la decisión de mostrarlo o no en público** y corrección de tarifas en 1 clic.
4. **Ficha 360º:** contacto, titular legal, KYB, verificación de Ley 49/2002, condiciones económicas, categorías propias, facturas Veri\*factu, gráfico de ingresos y tabla de iniciativas.
5. **Motor de reglas y soporte:** categorías globales (exenta / por tramos), tramos de comisión configurables (modo plano o marginal, umbrales y tarifas), fee de Mi Hucha (fijo + porcentaje), costes de Paycomet, duración máxima de campaña, *"Gastos de gestión digital"* con validador, mantenimiento con tope anual, medallas y bandeja central de soporte. **Salud de precios:** si una regla pierde dinero o es incoherente, la consola muestra un aviso `❗` / `⚠️` con la cifra concreta y el Super-Admin decide si ajusta o acepta y registra ([DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6.1).
6. **Ajustes de la plataforma (`/admin/ajustes`):** Paycomet, email, Veri\*factu, modo de Mi Hucha, divulgación por defecto del Auto-Impulso, SEO y rastreadores de IA, textos legales por idioma y límites ([DECISIONES_TECNICAS.md](DECISIONES_TECNICAS.md) §6).

---

## 4. Máquinas de estado

### 4.1 Iniciativa (`InitiativeStatus`)

```text
BUDGETING ──publicar (KYB verificado, ≤ maxCampaignDays)──► FUNDRAISING
BUDGETING ──descartar──────────────────────────────────────► CANCELLED
FUNDRAISING ──raisedCents ≥ goalCents (o aforo completo)───► GOAL_REACHED
FUNDRAISING ──vence la fecha sin meta (CAMPAIGN_EXPIRY)────► EXPIRED
EXPIRED ──la entidad lanza votación────────────────────────► RESIZE_VOTING
EXPIRED ──la entidad elige reembolsar──────────────────────► REFUNDING
RESIZE_VOTING ──aprobada (nueva meta ≤ lo recaudado)───────► GOAL_REACHED
RESIZE_VOTING ──rechazada──────────────────────────────────► REFUNDING
REFUNDING ──todas las devoluciones ejecutadas──────────────► REFUNDED
GOAL_REACHED ──doble firma + split transfer hecho──────────► CLOSED (las fotos se publican desde ahí)
GOAL_REACHED ──contracargo baja de la meta, sin liquidar───► FUNDRAISING
```

- `stepIndex` de la línea de 6 estados del panel: idea (1) → quórum (2) → `BUDGETING` (3) → `FUNDRAISING` (4) → `GOAL_REACHED` / `CLOSED` (5–6).
- Al entrar en `REFUNDED` o `CANCELLED` se liberan los cupos reservados.
- **Sprint 4.4b:** una campaña vencida se decide en `/panel/{slug}/vencidas` (una persona firmante: reembolsar o lanzar la votación de 7 días, solo campañas de presupuesto con donaciones y margen en la ventana de 90 días). Votan quienes donaron, una persona un voto, con «Prefiero que me devolváis mi aportación» siempre disponible (devolución del 100 % en el acto). Gana la opción de proyecto más votada y se hace solo con lo que aportaron quienes votaron un proyecto: **a quien no vota se le devuelve el 100 %** (`GOAL_REACHED` con meta = lo que queda y comisiones proporcionales); sin votos o con empate, `REFUNDING`. Una campaña redimensionada no vuelve a recaudar por un contracargo.
- **Sprint 4.4a:** la liquidación de una campaña conseguida se pide en `/panel/{slug}/liquidaciones` (destino y factura del proveedor) y se puede cambiar mientras espera la doble firma (las firmas se vuelven a pedir). Con las dos firmas se aprueba y se envía en el acto; al terminar el envío, la campaña pasa a `CLOSED` y las fotos Antes/Después que suba la entidad se ven en *Logros conseguidos*.

### 4.2 Idea (`IdeaPhase`)

```text
PHASE0_MOD ──la entidad aprueba──► PUBLIC_VOTING ──verifiedVotes ≥ minVotes──► DOUBLE_CHECK ──2 firmas──► CONVERTED (crea la iniciativa en BUDGETING)
PHASE0_MOD / PUBLIC_VOTING / DOUBLE_CHECK ──rechazo o vence maxIdeaDays──► REJECTED (con mensaje al proponente)
```

### 4.3 Liquidación (`PayoutStatus`)

```text
PENDING_DOUBLE_CHECK ──2ª firma──► APPROVED ──se envía a Paycomet──► PROCESSING ──confirmación──► EXECUTED
PROCESSING ──error──► FAILED ──reintento o corrección──► PROCESSING
```

### 4.4 Aportación (`ContributionStatus`)

```text
PENDING ──webhook de pago correcto──► COMPLETED ──reembolso aprobado──► REFUND_PENDING ──ejecutado──► REFUNDED
PENDING ──pago fallido o abandonado──► FAILED
COMPLETED ──contracargo──► CHARGEBACK
```
