---
name: korum-ticketing-qr
description: Motor de Taquilla Escolar, Eventos con Control Atómico de Aforo, Rifas Numeradas, Códigos QR Firmados (HMAC) y Modo Portería Móvil de KORUM. Cargar siempre que se programen eventos de entradas, papeletas de rifa, Gastos de gestión digital, pases QR o el escáner de puerta.
---

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
2. **Aviso Normativo Automático en Rifas:** Cuando el centro selecciona `'RAFFLE'`, el Estudio muestra una nota preventiva recordando los umbrales de comunicación/autorización administrativa de rifas ocasionales o benéficas (Ley 13/2011 DGOJ / normativa autonómica) y que los premios en especie nunca deben canjearse por dinero.
3. `ticketFeeMode`: `'ADD'` (por defecto: suma los *Gastos de gestión digital* al comprador, dejando el 100% del precio íntegro al centro) o `'INC'` (incluidos dentro del precio facial).

---

## 3. Bloqueo Atómico de Aforo (Cero Sobreventa en Ráfagas de WhatsApp)
1. **Validación en Cliente y Bloqueo Atómico en Servidor:**
   - En la UI, `+` nunca supera `availableTickets = Math.max(0, ticketMax - ticketsSold)`.
   - En el servidor, la reserva de entradas se ejecuta dentro de `prisma.$transaction` con actualización condicional atómica (`WHERE id = $1 AND ticketsSold + $qty <= ticketMax`) para impedir sobreventa incluso si 50 familias pagan con Bizum en el mismo segundo.
2. **Cierre Automático al Agotar la Última Entrada:**
   - Al cumplirse `ticketsSold >= ticketMax`, la iniciativa pasa automáticamente a `Logro Conseguido` (`stepIndex: 5`) y muestra **`🎟️ ¡Aforo Completo! Entradas Agotadas`**.

---

## 4. Pases QR Criptográficos (`HMAC-SHA256`) y "Modo Portería" sin Instalar App
1. **Firma Anti-Fotocopia:**
   - Cada compra genera un registro `TicketPass` con código serie (`#PASE-2026-XXXX` o `#RIFA-2026-XXXX`), números asignados si es rifa (`#0197, #0198`) y un payload QR firmado con `QR_HMAC_SECRET` (`korum://v1/pass/{passUuid}?sig={hmac}`).
   - El pase se envía automáticamente al email del comprador (incluso si compró como invitado) y queda accesible en `🐷 Mi Hucha` (`🎟️ Ver QR`) con impresión limpia `@media print` y botón de compartir en WhatsApp.
2. **Vista Móvil `/school/[orgSlug]/porteria` (Escáner de Puerta + Sorteador en Vivo):**
   - Accesible desde cualquier móvil de voluntarios del AFA/Club mediante un **PIN temporal de 6 dígitos** generado por el centro (sin darles acceso a datos bancarios del panel).
   - **En Eventos (`EVENT`):** Escanea el QR con la cámara (`BarcodeDetector` / WebRTC), verifica el HMAC, permite check-in parcial (`Entran 2 de 4`) y lanza **alerta roja sonora/visual si una entrada fotocopiada ya fue validada** indicando la hora exacta del primer acceso, mostrando en vivo `🟢 X / Y asistentes dentro del recinto`.
   - **En Rifas (`RAFFLE`):** Incluye modo **Sorteador Aleatorio Certificado en Pantalla Completa** para proyectar en la fiesta del colegio y extraer papeletas ganadoras únicamente entre las realmente vendidas y pagadas, generando acta auditable.

