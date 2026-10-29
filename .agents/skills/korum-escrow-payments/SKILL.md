---
name: korum-escrow-payments
description: Integración bancaria con Paycomet REST API (Marketplace, Split, Escrow y Refund PSD2) y Libro Mayor de Doble Partida. Cargar siempre que se implementen pagos Bizum/Tarjeta, onboarding KYB, recargas o reembolsos al origen de Mi Hucha, patrocinios Veri*factu o liquidaciones mancomunadas.
---

# Skill · Motor Bancario Escrow Paycomet, Ledger Contable y Cumplimiento PSD2

## 1. Arquitectura del Adaptador Paycomet y Libro Mayor (`EscrowLedgerEntry`)
- Toda comunicación con Paycomet se encapsula en `src/services/payments/paycomet.adapter.ts` operando **siempre en céntimos enteros (`amountCents: Int`)**:
  - Header requerido: `PAYCOMET-API-TOKEN: process.env.PAYCOMET_API_KEY`
  - Base URL: `https://rest.paycomet.com`
- **Webhooks Idempotentes y Doble Partida:** Todo webhook entrante de Paycomet valida la firma HMAC con `PAYCOMET_WEBHOOK_SECRET` y registra un asiento inmutable en `EscrowLedgerEntry` con `idempotencyKey` única dentro de una transacción `prisma.$transaction`. Nunca se actualiza `raisedCents` sin su correspondiente asiento en el Ledger.

---

## 2. Onboarding KYB del Centro / AFA / Club y Billeteras Escrow
1. **Alta de Subcomercio (`KYB`):**
   - El centro registra `Titular Legal`, `CIF` e `IBAN Oficial` y sube los 4 documentos obligatorios (CIF, Estatutos/Acta, DNI del representante y Certificado de titularidad IBAN).
   - Se almacena `paycometSubmerchantId` y `walletId` (ej. `WLT-CERV-01`).
2. **Billetera por Iniciativa (`Escrow Wallet`):**
   - Cada iniciativa o taquilla genera un `walletEscrowId` único (ej. `WLT-ESC-101`).
   - Todos los cobros (`Pay-In`) quedan custodiados en Paycomet bajo esa referencia hasta alcanzar el 100% de la meta o vencer la fecha límite.

---

## 3. Flujos de Cobro (`Pay-In`) en Checkout Dual + Matching 2x

### A. Aportación de Familia / Socio / Vecino (Con Email Ligero en Modo Invitado)
- **Fricción Cero:** No exige crear cuenta ni contraseña. Si el usuario es invitado (`!isLoggedIn`), solicita únicamente `guestEmail` para enviarle al instante su recibo Escrow o sus entradas QR y vincular futuras consultas.
- **Cálculo del cargo en céntimos:**
  `totalChargeCents = donationAmountCents + guaranteeContributionCents`
- **Métodos soportados:**
  - **Bizum (`methodId: 11` en Paycomet)** y **Tarjeta / Apple Pay / Google Pay (`methodId: 1`)**.
  - **Saldo Pre-Asignado de Mi Hucha KORUM:** Descuento atómico si `user.walletBalanceCents >= totalChargeCents` (deshabilitado si el saldo es `<= 0`).
- **Reto Multiplicador Opcional (*Matching 2x*):**
  - Si la iniciativa tiene `matchingPoolRemainingCents > 0`, al confirmarse la donación familiar se libera automáticamente `matchedCents = Math.min(donationAmountCents, matchingPoolRemainingCents)` desde la bolsa del patrocinador multiplicador hacia `initiative.raisedCents`.
- **Excedente en Frontera del 100% (`Over-funding`):**
  - Si con esta aportación `raisedCents >= goalCents`, la campaña pasa inmediatamente a `Logro Conseguido`, bloquea nuevos cobros y cualquier euro por encima de `goalCents` queda consolidado 100% íntegro para el centro como *Reserva Adicional del Proyecto*.

### B. Patrocinio de Comercio Amigo (100% Íntegro + Fee Encima + Veri\*factu)
- **Regla de oro:** El 100% del nivel elegido (`10000`, `25000` o `50000` cts) suma íntegro a `initiative.raisedCents`.
- **Facturación Dual Cumpliendo Veri\*factu (RD 1007/2023):**
  1. Se emite **Justificante de Patrocinio/Convenio** por el 100% destinado al centro.
  2. Se emite **Factura Oficial Veri\*factu** de KORUM por el Fee de gestión publicitaria (`feeCents` + IVA aplicable), generando huella encadenada SHA-256 (`verifactuHash`) y URL de verificación QR tributaria de la AEAT.
- **Renovación Anual y Bolsa de Respaldo (`CREDIT_POOL`):**
  - Tokenización `JET-ID` (`idUser` + `tokenUser`) con preaviso automático por email 30 días antes.
  - En renovaciones o cuando una campaña apoyada vence sin éxito, el 100% se reasigna según la regla del centro (`SOONEST`, `PROPORTIONAL`, `MANUAL`). Si en ese instante el centro **no tiene ninguna otra iniciativa activa**, pasa a estado `CREDIT_POOL` (Bolsa Reservada del Centro) notificando al comercio, con derecho a reembolso `Refund` del 100% si no se asigna en 60 días.

---

## 4. "Mi Hucha KORUM": Cumplimiento Estricto PSD2 y Prevención de Blanqueo (AML)

1. **⚡ Recarga Puntual Instantánea y 🔄 Recarga Mensual Programada (`JET-ID`):**
   - El saldo se constituye como **Saldo Pre-Asignado de Mecenazgo Comunitario** vinculado a órdenes `Pay-In` trazables en Paycomet (`paycometOrder`), sin almacenar jamás numeración PAN de tarjetas (PCI-DSS Nivel 1).
2. **🏦 Retirada Segura Mediante `Refund` al Medio de Pago Original (Prohibido IBAN Libre):**
   - **Regla Regulatoria Inquebrantable:** Está prohibido enviar transferencias SEPA de saldo de *Mi Hucha* a IBANs tecleados libremente (evita constituir Dinero Electrónico no regulado y elimina el fraude de *cash-out* con tarjetas robadas).
   - Al confirmar la retirada tras aceptar el aviso obligatorio de UX, el servidor ejecuta `/v1/payments/{order}/refund` en Paycomet contra las órdenes de recarga no consumidas (orden FIFO), devolviendo el 100% a la **misma tarjeta o cuenta Bizum de origen**, dejando `walletBalanceCents = 0` y deshabilitando el botón de Hucha en futuros checkouts hasta nueva recarga.
   - Únicamente si Paycomet devuelve error por tarjeta cancelada/expirada se abre un flujo administrativo de excepción con verificación documental de titularidad bancaria.

---

## 5. Liquidación Mancomunada al 100% (`Split Transfer`) e Independencia de Proveedores

- **Cuando `initiative.raisedCents >= initiative.goalCents`:**
  1. **Independencia Total:** El centro elige libremente pagar al **IBAN de su proveedor local** (siendo obligatorio adjuntar el PDF de la factura oficial para trazabilidad contable) o transferir a la **cuenta corriente KYB del Centro/AFA**.
  2. **Doble Firma Mancomunada Obligatoria (`2-Man Rule`):** Ningún `Split Transfer` se ejecuta en Paycomet sin que consten las firmas digitales verificadas tanto de `ROLE_DIRECTOR` como de `ROLE_AFA_PRESIDENT` en `DoubleCheckSignature`.
  3. Al completarse la transferencia y subirse las fotos del *Antes* y *Después*, pasa a `Cerrada` y se publica en `Logros Conseguidos`.
- **Cuando vence el plazo sin llegar al 100%:**
  - El centro lanza votación de presupuesto redimensionado a los mecenas o ejecuta el reembolso masivo `/v1/payments/{order}/refund` devolviendo el 100% a cada familia en su Bizum/Tarjeta original y liberando los cupos de exención reservados de esa campaña.

