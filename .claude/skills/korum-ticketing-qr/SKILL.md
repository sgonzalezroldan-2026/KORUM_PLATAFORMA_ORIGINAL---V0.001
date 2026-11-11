---
name: korum-ticketing-qr
description: Motor de Taquilla Escolar, Eventos con Control Atómico de Aforo, Rifas Numeradas, Códigos QR Firmados (HMAC) y Modo Portería Móvil de KORUM. Cargar siempre que se programen eventos de entradas, papeletas de rifa, Gastos de gestión digital, pases QR o el escáner de puerta.
---

<!-- GENERADO AUTOMÁTICAMENTE desde .agents/skills/korum-ticketing-qr/SKILL.md por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->

# Skill · Taquilla Escolar, Rifas Numeradas, QR Criptográfico y Modo Portería

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

## 2. Modalidades en el Estudio de Edición y Marco Legal de Rifas (`RAFFLE`)
1. `ticketSubtype`: `'EVENT'` (Entrada con control de aforo) o `'RAFFLE'` (Papeleta de rifa solidaria numerada correlativamente desde `#0001` hasta `ticketMax`).
2. **Aviso Normativo Automático en Rifas:** Cuando el centro selecciona `'RAFFLE'`, el Estudio muestra una nota preventiva recordando que las rifas y tómbolas son competencia de cada comunidad autónoma, que pueden requerir comunicación o autorización previa según su importe, y que los premios en especie nunca deben canjearse por dinero. El Estudio exige marcar la casilla *"Confirmamos que la rifa cumple la normativa de nuestra comunidad autónoma"* antes de publicar (queda en `AuditLog`). El texto exacto del aviso lo valida el abogado (ver la lista de comprobación legal).
3. `ticketFeeMode`: `'ADD'` (por defecto: suma los *Gastos de gestión digital* al comprador, dejando el 100% del precio íntegro al centro) o `'INC'` (incluidos dentro del precio facial).

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
   - Cada compra genera un registro `TicketPass` con código serie (`#PASE-2026-XXXX` o `#RIFA-2026-XXXX`), números asignados si es rifa (`#0197, #0198`) y un payload QR firmado con `QR_HMAC_SECRET` (`korum://v1/pass/{passUuid}?sig={hmac}`).
   - El pase se envía automáticamente al email del comprador (incluso si compró como invitado) y queda accesible en el área privada de la familia (`🎟️ Mis entradas`, dentro de *Mi Hucha* o de *Mi cuenta* según el modo de la Hucha), con un enlace de acceso directo en el email para quien compró como invitado, con impresión limpia `@media print` y botón de compartir en WhatsApp.
2. **Vista Móvil `/panel/[orgSlug]/porteria/{gateCode}` (Escáner de Puerta + Sorteador en Vivo):** la dirección lleva el **código no adivinable de la puerta** (`Initiative.gateCode`, 50 bits, se crea con el primer PIN; la entidad puede cambiarlo), nunca el identificador numérico, y `/porteria` no lista eventos.
   - Accesible desde cualquier móvil de voluntarios del AMPA/AFA o del club mediante un **PIN de 6 dígitos propio de cada evento** (`Initiative.gatePinHash`, guardado con hash lento y con caducidad `gatePinExpiresAt` = la fecha del evento guardada en la iniciativa (`closesAt`) + 6 h: no la decide quien llama). Sin acceso a datos bancarios, fiscales ni personales del panel.
   - **Protección contra fuerza bruta:** máximo 5 intentos fallidos por IP y evento: la red que llega a 5 queda bloqueada **6 minutos** y las demás siguen entrando (tabla `RateLimit`); con **25** fallos acumulados en el evento, el PIN se revoca y se avisa por email a las dos personas firmantes, que pueden crear uno nuevo desde «Taquilla y portería» (decisión del promotor, 2026-11-11). Cada intento queda en `AuditLog`. Un límite global por red (60 intentos de PIN cada 15 minutos en **todos** los eventos, y 1.200 peticiones por minuto con sesión) actúa antes de escribir nada más que su contador, y de cada bloqueo solo el primero de la ventana deja fila de auditoría (`AuditLog` no se puede purgar). La IP sale de la cabecera de confianza (`src/lib/trusted-ip.ts`).
   - Un PIN correcto crea una `GateSession` (token en cookie `HttpOnly`, solo su hash en base de datos) que la entidad puede revocar desde el panel.
   - **Lector QR:** `BarcodeDetector` donde exista y, como respaldo (Safari en iOS no lo soporta), jsQR sobre un fotograma de la cámara (`getUserMedia`). Además hay un campo para escribir el código (alternativa sin cámara y para lectores de códigos con teclado). La cámara solo se concede a la portería: `Permissions-Policy: camera=(self)` únicamente en `/panel/{slug}/porteria/*`, y `camera=()` en el resto.
   - **Sin cobertura:** al abrir la sesión se descarga la lista de pases del evento (por pase: `uuid`, plazas, usadas y la **huella SHA-256 de la firma del QR**, nunca la firma ni datos de nadie) y se refresca cada minuto; si se pierde la red, el escáner valida contra esa lista, guarda las lecturas en cola local (con un `clientScanId` por lectura) y las envía al volver la conexión. El servidor vuelve a validar cada una con `checkInPass`: reenviar la cola no deja entrar dos veces y un pase que otro móvil ya había dejado entrar vuelve como conflicto, que el voluntario ve. Una lectura que no está en la lista no se admite sin red.
   - **En Eventos (`EVENT`):** verifica el QR, pregunta cuántas personas entran si el pase tiene varias plazas libres y permite check-in parcial (`Entran 2 de 4`) y lanza **alerta roja sonora, visual y con vibración si una entrada ya fue usada** indicando la hora exacta del primer acceso (`TicketCheckIn`), mostrando en vivo `🟢 X / Y asistentes dentro del recinto`.
   - **En Rifas (`RAFFLE`):** Incluye modo **Sorteador Aleatorio Certificado en Pantalla Completa** para proyectar en la fiesta y extraer papeletas ganadoras únicamente entre las realmente vendidas y pagadas (`crypto.randomInt`), generando un acta con la lista de papeletas participantes, su huella SHA-256 y el resultado. El número de premios (`rafflePrizeCount`) se fija antes de vender y un trigger impide cambiarlo; `drawRaffle` nunca sortea más, y la misma `idempotencyKey` devuelve la misma acta: repetir hasta que salga quien se quiere no es posible. Una ronda extra (`PRIZE_UNCLAIMED`, `WINNER_REFUNDED`) solo la hace **una** de las dos personas firmantes (no hace falta doble firma: decisión del promotor, 2026-11-11), con segundo factor, desde «Taquilla y portería»; como mucho una por premio, y la otra persona firmante recibe un aviso con los números y quién la hizo. La ronda **dice qué número ganador sustituye** (`replacedNumbers`, de una papeleta en una en la pantalla), y un premio sin reclamar solo se sustituye pasado el plazo mínimo de la plataforma (`raffle.extraRoundMinHours`) **desde la ronda en que ganó esa papeleta**. Solo se sortea en `GOAL_REACHED` y **no antes del día del evento** (desde las 00:00, hora de España, del día de `closesAt`); una rifa sorteada no vuelve a vender ni se reabre, y sin sorteo no se liquida. La pantalla proyectable (`/panel/{slug}/porteria/{id}/sorteo`) genera la clave de idempotencia al preparar cada ronda y permite descargar o imprimir el acta.

