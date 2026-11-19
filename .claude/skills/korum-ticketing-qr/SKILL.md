---
name: korum-ticketing-qr
description: Motor de Taquilla Escolar, Eventos con Control Atómico de Aforo, Códigos QR Firmados (HMAC) y Modo Portería Móvil de KORUM. Cargar siempre que se programen eventos de entradas, Gastos de gestión digital, pases QR, el escáner de puerta o, desde el Sprint 5.14, los vales.
---

<!-- GENERADO AUTOMÁTICAMENTE desde .agents/skills/korum-ticketing-qr/SKILL.md por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->

# Skill · Taquilla Escolar, QR Criptográfico y Modo Portería

> **Decisiones del promotor del 2026-11-17 y del 2026-11-18, pendientes de construir.** **Las rifas se retiraron** (papeletas, sorteo, acta y ronda extra) en los Sprints 5.12a y 5.12b, y llegan los **vales** en el 5.14. Lo que describía las rifas se ha quitado de esta skill y no se recupera. **Entradas (5.13, construido):** ver §5. **Vales (5.14):** unidades de canje de precio único, sin numerar, en **un solo QR firmado por compra con su saldo**; canje parcial atómico en el puesto, con lector y PIN como la portería; tope opcional y «seguir aportando sin producto» al agotarse; devolución del 100 % durante 14 días si no se ha gastado ninguno; validez hasta la fecha que indique la entidad; tarifa propia de «Gastos de gestión digital»; liquidación por lo vendido; sin certificado y fuera del Modelo 182. **Tarifa guardada (5.18):** cada taquilla o venta de vales conserva la tarifa con la que se publicó. Los «Gastos de gestión digital» llevan el IVA dentro (5.20). Hasta el sprint indicado, lo que sigue describe lo que el código hace hoy y **no se adelanta la regla nueva**. Lista completa en [CUMPLIMIENTO §8](../../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) (decisiones 21 a 62); orden y fichas en el [plan](../../../docs/PLAN_IMPLEMENTACION_ATOMICO.md).

## 1. Modelo de Negocio de los "Gastos de gestión digital" (Cobertura Real Paycomet)
- Se denomina única y exclusivamente **"Gastos de gestión digital"** en toda la plataforma y solo puede configurarse desde Super-Admin (Global o Ficha 360º del centro) mediante `fixedCents + pctBps`.
- **Validador de Cobertura Real frente a Paycomet:**
  En modo `'ADD'`, Paycomet aplica su `% variable` sobre el **importe total pagado por el comprador** (`ticketPriceCents + digitalFeeUnitCents`):
  ```typescript
  export function validateTicketDigitalFeeMarginCents(
    sampleTicketPriceCents: number, // ej. 500 cts (5,00 €)
    digitalConfig: { fixedCents: number; pctBps: number },
    gatewayConfig: { fixedCents: number; pctBps: number }
  ) {
    const digitalFeeCents =
      digitalConfig.fixedCents +
      Math.round((sampleTicketPriceCents * digitalConfig.pctBps) / 10000);
    const grossBuyerChargeCents = sampleTicketPriceCents + digitalFeeCents;
    const gatewayCostCents =
      Math.round((grossBuyerChargeCents * gatewayConfig.pctBps) / 10000) +
      gatewayConfig.fixedCents;
    const netMarginPerTicketCents = digitalFeeCents - gatewayCostCents;

    return {
      digitalFeeCents,
      gatewayCostCents,
      netMarginPerTicketCents,
      isProfitable: netMarginPerTicketCents > 0
    };
  }
  ```

---

## 2. Modalidades en el Estudio de Edición
1. `ticketSubtype`: `'EVENT'` (entrada con control de aforo). Es el único valor desde que se retiraron las rifas (Sprint 5.12a); el tipo se conserva por si los vales (5.14) necesitan otro.
2. `ticketFeeMode`: `'ADD'` (por defecto: suma los *Gastos de gestión digital* al comprador, dejando el 100% del precio íntegro al centro) o `'INC'` (incluidos dentro del precio facial).

---

## 3. Bloqueo Atómico de Aforo (Cero Sobreventa en Ráfagas de WhatsApp)
1. **Validación en Cliente y Bloqueo Atómico en Servidor:**
   - En la UI, `+` nunca supera `availableTickets = Math.max(0, ticketMax - ticketsSold)`.
   - En el servidor, la reserva de entradas se ejecuta dentro de `prisma.$transaction` con actualización condicional atómica (`WHERE id = $1 AND ticketsSold + $qty <= ticketMax`) para impedir sobreventa incluso si 50 familias pagan con Bizum en el mismo segundo.
   - **Implementación (Sprint 2.3):** `reserveTickets` bloquea la fila de la iniciativa y retiene plazas 15 minutos en `ticketsHeld`; `ticketsSold` solo cuenta lo pagado. Un `CHECK` en base de datos impide pasarse del aforo. `settleTicketSeatInTx` convierte la reserva en venta dentro de la transacción del webhook; un pago tardío sin plaza se reembolsa entero. Reembolsos y contracargos anulan el pase con `revokePassInTx`.
2. **Cierre Automático al Agotar la Última Entrada:**
   - Al cumplirse `ticketsSold >= ticketMax`, la iniciativa pasa automáticamente a `GOAL_REACHED` (`stepIndex: 5`) y muestra **`🎟️ ¡Aforo Completo! Entradas Agotadas`**.

---

## 4. Pases QR Criptográficos (`HMAC-SHA256`) y "Modo Portería" sin Instalar App
1. **Firma Anti-Fotocopia:**
   - Cada compra genera un registro `TicketPass` con código serie (`#PASE-2026-XXXX`) y un payload QR firmado con `QR_HMAC_SECRET` (`korum://v1/pass/{passUuid}?sig={hmac}`).
   - El pase se envía automáticamente al email del comprador (incluso si compró como invitado) y queda accesible en el área privada de la familia (`🎟️ Mis entradas`, dentro de *Mi Hucha* o de *Mi cuenta* según el modo de la Hucha), con un enlace de acceso directo en el email para quien compró como invitado, con impresión limpia `@media print` y botón de compartir en WhatsApp.
2. **Vista Móvil `/panel/[orgSlug]/porteria/{gateCode}` (Escáner de Puerta):** la dirección lleva el **código no adivinable de la puerta** (`Initiative.gateCode`, 50 bits, se crea con el primer PIN; la entidad puede cambiarlo), nunca el identificador numérico, y `/porteria` no lista eventos.
   - Accesible desde cualquier móvil de voluntarios del AMPA/AFA o del club mediante un **PIN de 6 dígitos propio de cada evento** (`Initiative.gatePinHash`, guardado con hash lento y con caducidad `gatePinExpiresAt` = la fecha del evento guardada en la iniciativa (`closesAt`) + 6 h: no la decide quien llama). Sin acceso a datos bancarios, fiscales ni personales del panel.
   - **Protección contra fuerza bruta:** máximo 5 intentos fallidos por IP y evento: la red que llega a 5 queda bloqueada **6 minutos** y las demás siguen entrando (tabla `RateLimit`); con **25** fallos acumulados en el evento, el PIN se revoca y se avisa por email a las dos personas firmantes, que pueden crear uno nuevo desde «Taquilla y portería» (decisión del promotor, 2026-11-11). Cada intento queda en `AuditLog`. Un límite global por red (60 intentos de PIN cada 15 minutos en **todos** los eventos, y 1.200 peticiones por minuto con sesión) actúa antes de escribir nada más que su contador, y de cada bloqueo solo el primero de la ventana deja fila de auditoría (`AuditLog` no se puede purgar). La IP sale de la cabecera de confianza (`src/lib/trusted-ip.ts`).
   - Un PIN correcto crea una `GateSession` (token en cookie `HttpOnly`, solo su hash en base de datos) que la entidad puede revocar desde el panel.
   - **Lector QR:** `BarcodeDetector` donde exista y, como respaldo (Safari en iOS no lo soporta), jsQR sobre un fotograma de la cámara (`getUserMedia`). Además hay un campo para escribir el código (alternativa sin cámara y para lectores de códigos con teclado). La cámara solo se concede a la portería: `Permissions-Policy: camera=(self)` únicamente en `/panel/{slug}/porteria/*`, y `camera=()` en el resto.
   - **Sin cobertura:** al abrir la sesión se descarga la lista de pases del evento (por pase: `uuid`, plazas, usadas y la **huella SHA-256 de la firma del QR**, nunca la firma ni datos de nadie) y se refresca cada minuto; si se pierde la red, el escáner valida contra esa lista, guarda las lecturas en cola local (con un `clientScanId` por lectura) y las envía al volver la conexión. El servidor vuelve a validar cada una con `checkInPass`: reenviar la cola no deja entrar dos veces y un pase que otro móvil ya había dejado entrar vuelve como conflicto, que el voluntario ve. Una lectura que no está en la lista no se admite sin red.
   - **En Eventos (`EVENT`):** verifica el QR, pregunta cuántas personas entran si el pase tiene varias plazas libres y permite check-in parcial (`Entran 2 de 4`) y lanza **alerta roja sonora, visual y con vibración si una entrada ya fue usada** indicando la hora exacta del primer acceso (`TicketCheckIn`), mostrando en vivo `🟢 X / Y asistentes dentro del recinto`.
   - **Rifas retiradas (Sprints 5.12a y 5.12b):** ya no hay sorteo, acta ni ronda extra en la portería; la migración `20261127090000_retire_raffles` convirtió las rifas de las bases de demostración en eventos con entradas sin tocar el libro mayor.


---

## 5. Fecha del evento, cancelación y cambio de fecha (Sprint 5.13, decisión 30)
Reglas puras en `src/core/ticketing/event-schedule-rules.ts`; servicios en `src/services/ticketing/` (`event-schedule.service.ts`, `event-refund-link.service.ts`, `reschedule-window.ts`) y `src/core/ticketing/event-date-reached.ts`.
1. **Llega la fecha** (`CAMPAIGN_EXPIRY` → `closeEventAtDate`): un evento `FUNDRAISING` sin agotar **nunca pasa a `EXPIRED`**. Con dinero de entradas pasa a `GOAL_REACHED` (liquidable por lo vendido con la doble firma de siempre; `approvePayout` ya admite un evento celebrado sin la meta) y el mantenimiento baja en proporción a lo vendido, hacia abajo (`heldEventMaintenanceCents`, decisión del promotor del 2026-11-19). Hasta liquidar, `syncHeldEvent` lo pone al día tras cada cobro tardío, devolución o contracargo, y si se queda sin dinero lo cierra (`CANCELLED`, motivo `EVENT_EMPTIED`); al liquidar, lo no cobrado vuelve al tope anual. Sin ventas pero con un pago en curso, espera a la ejecución siguiente. Sin nada vendido, `CANCELLED` sin asientos y con los cupos de vuelta. El Auto-Impulso que quedara vuelve a KORUM. Aviso `event.dateReached` a quienes firman.
2. **Cancelar** (`cancelEvent`, panel «Taquilla y portería»): una persona firmante con segundo factor, mientras no se haya liquidado (también tras la fecha, si no llegó a celebrarse). Con ventas, `REFUNDING`: `MASS_REFUND` devuelve el 100 % de cada compra (precio y Gastos de gestión digital) al medio de pago original y la iniciativa termina en `REFUNDED` con los cupos de vuelta; aviso `event.cancelledBuyer` a cada persona (por lotes, una vez por persona). Sin ventas, `CANCELLED`. La portería se cierra (PIN y móviles).
3. **Cambiar la fecha** (`rescheduleEvent`): queda una fila `EventReschedule` (historial que la base no deja reescribir ni borrar). Cada persona que compró **antes** del cambio recibe `event.rescheduledBuyer` con un enlace personal firmado (`signEventRefundToken`, `/{slug}/entrada/devolucion?d=`) que devuelve el 100 % de sus compras sin usar durante **14 días** (`FOURTEEN_DAY_RULE_DAYS`, valor único). Cuentan las compras empezadas antes del cambio; quien estaba pagando en ese momento recibe su aviso al terminar (el reparto sigue abierto hasta el final del plazo y localiza esos pagos por `TicketPass.issuedAt`, la hora de emisión del pase). Una compra con alguna entrada ya usada en la puerta no se devuelve; si un móvil sin red la dejó entrar y la devolución se pidió antes de sincronizar, se anota (`gate.refunded_pass_used`) y se avisa a quienes firman. **Mientras haya un plazo abierto no se liquida** (`REFUND_WINDOW_OPEN` en `payoutBlockers` y en `approvePayout`). Se puede aplazar un evento ya celebrado y sin liquidar: vuelve a `FUNDRAISING` hasta la fecha nueva (si no está agotado) con el mantenimiento publicado. La fecha nueva y el final de los 14 días no pasan del máximo de la campaña desde su publicación (`latestEventDate`). El PIN de la portería caduca con la fecha nueva (+6 h).
4. **Portería** (`L-123`, `L-134`): la pantalla del PIN dice qué guarda el móvil, hasta cuándo y que no se reenvíe el enlace; el panel, que el enlace solo se pasa a los voluntarios y se cambia si se filtra. **Plazo** (`L-124`): `DATA_RETENTION_PURGE` borra lecturas (`TicketCheckIn`) y sesiones (`GateSession`) un año después de liquidarse el evento o de terminar de devolverse; queda la cifra de cada pase.
5. Como siempre, el Super-Admin no entra en la portería ni crea su PIN, ni cancela o cambia la fecha de un evento (`L-125`).
