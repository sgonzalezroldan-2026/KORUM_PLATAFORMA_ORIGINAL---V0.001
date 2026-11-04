---
name: korum-escrow-payments
description: Integración con Paycomet REST API (cobros Bizum/tarjeta, split transfer de marketplace, reembolsos al origen), libro mayor de doble partida con asientos tipo, Mi Hucha por modos (PLEDGE / REGULATED_WALLET), liquidaciones con doble firma, contracargos, conciliación diaria y facturación Veri*factu. Cargar siempre que se implementen pagos, KYB, recargas, reembolsos, patrocinios, liquidaciones o facturas.
---

# Skill · Pagos con Paycomet, libro mayor y Mi Hucha

> Antes de implementar cualquier endpoint, compruébalo en la documentación oficial (`docs.paycomet.com`) y en el contrato firmado. Lo que aquí figura como **"a confirmar"** no se da por hecho en código: va detrás de un ajuste de la consola o falla de forma explícita.

## 1. Adaptador y principios

- Toda comunicación con Paycomet pasa por `src/services/payments/paycomet.adapter.ts`, que implementa la interfaz `PaymentProvider`. Siempre en **céntimos enteros**.
  - Base: `https://rest.paycomet.com` · Cabecera: `PAYCOMET-API-TOKEN` (valor leído de `PlatformSecret` `paycomet.apiKey`, con respaldo en `PAYCOMET_API_KEY`).
  - Métodos: tarjeta / Apple Pay / Google Pay (`methodId: 1`) y Bizum (`methodId: 11`).
- `PAYCOMET_MODE=mock` usa un simulador local determinista que firma sus webhooks igual que Paycomet, para tests E2E sin red.
- **Webhooks** (`paycomet-webhook.service.ts`): se verifica la firma (SHA-512 con `md5(contraseña)`, fórmula oficial en `paycomet-notification.ts`), con un identificador sacado solo de campos firmados; se guarda en `WebhookEvent` (único por `provider + externalEventId`) y se procesa en una `prisma.$transaction` que crea el asiento y actualiza los contadores. Un webhook repetido no hace nada. Con firma inválida no se guarda el cuerpo ni un identificador sacado de él, solo un recuento por hora y motivo (`rejected:<hora>:<motivo>`): no está verificado, alguien podría reservar el identificador de un pago real y el número de filas no debe crecer con cada petición.
- **Resultado desconocido:** si se corta la conexión con Paycomet, `PaymentProviderError.outcomeUnknown` es `true` y la operación nunca se reintenta a ciegas, porque podría mover dinero dos veces.
- **Nunca** se actualiza `raisedCents`, un estado de pago o un saldo sin su asiento.

## 2. Libro mayor de doble partida

Modelo: `LedgerJournal` (asiento, con `idempotencyKey` única) + `EscrowLedgerEntry` (apuntes con `account`, `direction`, `amountCents > 0`). En cada asiento, `Σ DEBIT === Σ CREDIT`. Inmutable: los errores se corrigen con un asiento `REVERSAL`.

Implementación (Sprint 1.2), que es la única puerta de entrada al libro:

- `postJournal(db, input)` en `src/core/finance/ledger.service.ts`: valida, escribe asiento y apuntes en una sola escritura y es idempotente (misma clave + mismo contenido → devuelve el existente; mismo clave + otro contenido → `IdempotencyConflictError`). Dentro de una transacción ajena, una carrera por la clave aborta esa transacción: quien la abrió reintenta. `reverseJournal` crea el contra-asiento (solo uno por asiento). `getAccountBalance` / `getBalancesByAccount` / `getTrialBalance` reconstruyen saldos solo desde los apuntes.
- **Dimensiones obligatorias** (`ACCOUNT_RULES` en `ledger-accounts.ts`): `INITIATIVE_ESCROW` lleva entidad e iniciativa; `ORG_PAYABLE`, entidad; `FAMILY_WALLET`, familia; `SPONSOR_CREDIT_POOL` y `MATCHING_POOL`, comercio. Conviene poner también `organizationId` en el resto de apuntes para los saldos por entidad del BI.
- **Defensa en la base de datos** (migraciones `*_ledger_immutability` y `*_ledger_append_guard`): `UPDATE`/`DELETE`/`TRUNCATE` prohibidos en asientos, apuntes y auditoría; cuadre comprobado por un trigger diferido al confirmar; **ningún apunte puede añadirse a un asiento ya registrado** (cada asiento lleva sellada su transacción); claves foráneas en las dimensiones de los apuntes; `CHECK (amountCents > 0)` y solo euros. Desde la aplicación, la extensión `korum-append-only` de `src/lib/prisma.ts` impide editar, borrar, crear apuntes sueltos o asientos en bloque. En producción la aplicación usa el rol sin privilegios `korum_app` (`prisma/sql/runtime-role.sql`).
- **Idempotencia completa:** la misma clave solo vale para la misma operación: tipo, apuntes, entidad, iniciativa, aportación, movimiento de Mi Hucha, liquidación y referencia de Paycomet. `postJournal` comprueba además que cada iniciativa citada existe y es de la entidad del asiento.
- **Cupos** (`quota-reservation.ts`): se devuelve la instantánea reservada, solo dentro del mismo curso (`Organization.quotaPeriod`); ningún error deja la iniciativa marcada sin el descuento.
- `amountCents` es `Int` (hasta 21.474.836,47 € por apunte); los saldos se suman sin desbordar.

### Asientos tipo (ejemplos con importes en céntimos)

| Operación | Apuntes |
| :--- | :--- |
| **Donación** de 2.500 + aportación voluntaria a KORUM de 180 (cobro confirmado) | DEBIT `PSP_CLEARING` 2.680 · CREDIT `INITIATIVE_ESCROW` 2.500 · CREDIT `KORUM_REVENUE_GUARANTEE` 180 |
| **Comisión de Paycomet** de ese cobro (1 % + 9 = 36) | DEBIT `GATEWAY_FEES_EXPENSE` 36 · CREDIT `PSP_CLEARING` 36 |
| **Entrada** de 500 + gastos de gestión digital 55 (modo `ADD`) | DEBIT `PSP_CLEARING` 555 · CREDIT `INITIATIVE_ESCROW` 500 · CREDIT `KORUM_REVENUE_TICKET_FEE` 55 |
| **Patrocinio** de 25.000 + fee 3.750 + IVA del fee 788 | DEBIT `PSP_CLEARING` 29.538 · CREDIT `INITIATIVE_ESCROW` 25.000 · CREDIT `KORUM_REVENUE_SPONSOR_FEE` 3.750 · CREDIT `TAX_PAYABLE_VAT` 788 |
| **Aprobación de liquidación** (iniciativa #1 del seed: meta 583.300 = neto 561.000 + tramo 14.440 + pasarela 7.860) | DEBIT `INITIATIVE_ESCROW` 583.300 · CREDIT `ORG_PAYABLE` 561.000 · CREDIT `KORUM_REVENUE_BRACKET` 14.440 · CREDIT `GATEWAY_FEES_RECOVERED` 7.860 |
| **Ejecución del split transfer** a la entidad | DEBIT `ORG_PAYABLE` 561.000 · CREDIT `PSP_CLEARING` 561.000 |
| **Reembolso** de una donación (campaña fallida) | Aprobación: DEBIT `INITIATIVE_ESCROW` 2.500 · DEBIT `KORUM_REVENUE_GUARANTEE` 180 · CREDIT `REFUNDS_PAYABLE` 2.680 → Ejecución: DEBIT `REFUNDS_PAYABLE` 2.680 · CREDIT `PSP_CLEARING` 2.680 |
| **Auto-Impulso** de 15.000 | DEBIT `AUTO_BOOST_EXPENSE` 15.000 · CREDIT `INITIATIVE_ESCROW` 15.000 (y `Contribution` `SELF_BOOST` con `publiclyDisclosed` según la decisión del Super-Admin) |
| **Contracargo** de 2.500 antes de liquidar | DEBIT `INITIATIVE_ESCROW` 2.500 · CREDIT `PSP_CLEARING` 2.500 (si ya se liquidó: DEBIT `CHARGEBACK_LOSSES`) |

> El patrocinio con IVA es un ejemplo de estructura: el tipo y la base del IVA los confirma la asesoría fiscal.

## 3. KYB y cuentas destino

1. **Alta de la entidad titular** (la que cobra: AMPA/AFA, titular del colegio, fundación, club o asociación): razón social, forma jurídica, CIF, IBAN y 4 documentos (CIF, estatutos o acta, DNI del representante y certificado de titularidad del IBAN) guardados como `FileAsset` privados (`KYB_DOCUMENT`). Si la entidad declara régimen Ley 49/2002, se añade el documento que lo acredita y el Super-Admin rellena `ley49VerifiedAt`.
2. Paycomet crea la **cuenta destino** de la entidad, identificada por su `paycometSplitId`.
3. Cada iniciativa tiene su referencia de hucha `walletEscrowId` (`WLT-ESC-101`). Los cobros quedan como saldo del producto de KORUM en Paycomet hasta que se reparten.

## 4. Cobros en el checkout

- **Sin registro:** el invitado solo da su email (`guestEmail`) para recibir el recibo o las entradas.
- `totalChargeCents = donationAmountCents + guaranteeContributionCents`. **El check de la aportación voluntaria va desmarcado**: `guaranteeContributionCents` es `0` salvo que la persona lo active.
- **NIF opcional** ("Quiero mi certificado fiscal"): solo en entidades con Ley 49/2002 verificada. Se cifra y se guarda junto a la provincia.
- **Pagar con Mi Hucha** solo existe en modo `REGULATED_WALLET` y si el saldo cubre el total.
- **Matching 2x:** si `matchingPoolRemainingCents > 0`, al confirmarse la donación se libera `Math.min(donationAmountCents, matchingPoolRemainingCents)` de la bolsa del patrocinador (asiento `MATCHING_RELEASE`).
- **Excedente al cruzar el 100 %:** la iniciativa pasa a `GOAL_REACHED`, bloquea nuevos cobros y el excedente se liquida íntegro a la entidad.

## 5. Ventana de 90 días (restricción de Paycomet)

Según la documentación de *split transfer* de Paycomet, un reparto solo puede ejecutarse **si no han pasado más de 90 días desde el cobro inicial**. Consecuencias obligatorias:

- **Se reparte cobro a cobro:** `/v1/marketplace/split-transfer` exige el pedido original y su código de autorización, así que una liquidación son muchos repartos, cada uno con su propia ventana (`planPayoutSplits`, tabla `EscrowPayoutSplit`). **A confirmar con Paycomet:** que el tope de cada reparto es lo cobrado en ese pedido.
- Campañas de **60 días como máximo** (`GlobalConfig.maxCampaignDays`, nunca más de 75; `publishInitiative` lo comprueba).
- `Initiative.firstPayinAt` se rellena con el primer cobro; la tarea `SPLIT_WINDOW_GUARD` avisa cuando quedan 15 días.
- `CREDIT_POOL`: plazo `min(creditPoolMaxDays, 85 − días desde Sponsor.paidAt)`; al vencer, reembolso al comercio.

## 6. Patrocinio de comercios

- El 100 % del nivel elegido suma a la iniciativa; el fee (`15 %` + IVA) se cobra encima.
- Documentos: justificante del patrocinio y factura de KORUM por el fee, registrada en Veri\*factu (§10).
- Renovación anual con token `JET-ID` (`PaymentMethodToken`, cifrado) y preaviso por email 30 días antes (`SPONSOR_RENEWAL_NOTICE`).
- Si la campaña patrocinada falla, el importe se reasigna según la regla de la entidad (`SOONEST`, `PROPORTIONAL`, `MANUAL`); si no hay campaña activa, pasa a `CREDIT_POOL` con aviso al comercio.

## 7. Mi Hucha según `hucha.mode`

- **`PLEDGE` (por defecto):** la familia programa una aportación mensual a una entidad (`WalletSubscription` con `organizationId`). Cada mes, `MONTHLY_TOPUP` cobra con su token y crea una `Contribution` `DONATION` en la iniciativa activa que elija la familia (o, si no eligió, la que cierre antes). Si la entidad no tiene ninguna iniciativa activa, **no se cobra** ese mes y se avisa. No existe saldo.
- **`REGULATED_WALLET`:** el saldo vive en un monedero de la familia custodiado por una entidad autorizada para ello (modelo Wallapop + Mangopay). `User.walletBalanceCents` es solo un espejo que se concilia a diario. Retirada: **reembolso al medio de pago original** (orden FIFO de recargas no gastadas) con el aviso de la Regla 03; nunca a un IBAN tecleado.
- **`DISABLED`:** no se muestra.
- Activar `REGULATED_WALLET` exige que el proveedor confirme por escrito que puede custodiar saldos de usuarios (ver [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §3). Paycomet es entidad de pago; si no ofrece monederos, el adaptador `PaymentProvider` permite usar un proveedor de monederos solo para esta función.

## 8. Liquidación con doble firma

- Cuando `raisedCents >= goalCents`:
  1. La entidad elige destino: **su propia cuenta** o **el proveedor** que haya elegido libremente. En ambos casos adjunta la factura del proveedor (`PROVIDER_INVOICE`).
  2. **Doble firma obligatoria:** dos registros en `DoubleCheckSignature` de dos personas distintas (`DIRECTOR` y `COSIGNER`). Sin ellas no se ejecuta ningún reparto.
  3. Se aprueba (`approvePayout`: firmas, cifras, hucha y plan de repartos, todo en una transacción) y se ejecuta (`executeApprovedPayout`) el *split transfer* a la cuenta destino de la entidad. Cada reparto se registra antes de enviarlo: se puede reanudar sin repetir lo ya hecho, y uno de resultado desconocido queda en `SENDING` hasta que una persona lo resuelve (`resolveUnknownSplit`). **A confirmar con Paycomet:** si se puede pagar directamente al IBAN de un tercero (proveedor). Si no se puede, el dinero va a la entidad y el pago al proveedor lo hace la entidad, con la factura adjunta como justificante.
  4. Con la transferencia hecha y las fotos Antes/Después subidas, la iniciativa pasa a `CLOSED` y aparece en *Logros conseguidos*.

## 9. Campañas fallidas, contracargos y conciliación

- **Vencimiento sin meta** (`CAMPAIGN_EXPIRY` → `EXPIRED`): la entidad elige votación de redimensionamiento (`RESIZE_VOTING`) o reembolso (`REFUNDING`). El reembolso (`MASS_REFUND`) devuelve el **100 % de lo cobrado** a cada persona por `/v1/payments/{order}/refund`, en lotes idempotentes con reintentos; al terminar, `REFUNDED` y se liberan los cupos reservados. **A confirmar con Paycomet:** coste de cada devolución y plazo máximo de devolución por Bizum y por tarjeta.
- **Contracargos:** webhook específico → asiento `CHARGEBACK` (§2), aviso al Super-Admin y a la entidad (Sprint 2.6), y la contribución pasa a `CHARGEBACK`. El asiento depende de dónde esté el dinero: en la hucha, sale de ella y de los ingresos de ese cobro; con la devolución pendiente, la cancela; ya liquidado o devuelto, lo asume KORUM.
- **Reserva de cada devolución:** `refundSendingAt` se pone antes de llamar a Paycomet, así que dos ejecuciones no devuelven dos veces. Tras un rechazo definitivo se libera. Con el resultado desconocido, no se reintenta hasta que llegue su notificación o una persona lo compruebe (`resolveUnknownRefund`). Un aviso de fallo solo libera la reserva si es posterior a ella.
- **Devolver refleja el cobro:** reembolsos y contracargos reflejan línea a línea el asiento del cobro original, así que incluyen exactamente lo cobrado. Si la donación liberó bolsa Matching, ese bonus vuelve a la bolsa.
- **Cobro confirmado con la campaña cerrada:** el dinero entró, así que se asienta y queda en `REFUND_PENDING` para devolverlo entero. Si la campaña ya logró la meta y no se ha liquidado, es excedente de la entidad.
- **Conciliación diaria** (`PSP_RECONCILIATION`): compara **cobro a cobro** los cobros confirmados de Paycomet (`PaymentProvider.listCharges`, `POST /v1/payments/search`) con los de KORUM desde la última conciliación buena (mínimo 48 h; tras una caída recupera hasta 14 días, y parte el rango si Paycomet alcanza su tope de resultados), sin las últimas 3 horas. Cada diferencia abre su propia alerta `OpsAlert` crítica con el detalle: `MISSING_LOCALLY` (Paycomet cobró y KORUM no lo tiene), `MISSING_AT_PSP`, `AMOUNT_MISMATCH` y `AUTHCODE_MISMATCH` (el `AuthCode` es lo que luego permite devolver y repartir). No usa el saldo global de Paycomet: un saldo que cuadra puede esconder dos errores que se compensan. Además: `PSP_CLEARING` nunca puede ser negativo, `Initiative.raisedCents` debe coincidir con `getRaisedFromLedger`, y los contracargos que Paycomet notificó sin confirmar (`IGNORED`) aparecen como `CHARGEBACK_UNCONFIRMED`. Si Paycomet no puede dar la lista completa, la tarea falla y se reintenta. Se asume UTC en sus fechas y está sin probar en el sandbox real.
- **Tareas de devolución** (`MASS_REFUND`): recoge todo `REFUND_PENDING` sin devolución en curso (también los cobros tardíos en campañas cerradas) y las donaciones y entradas de iniciativas `REFUNDING`/`CANCELLED`; no toca patrocinios. Una devolución rechazada cuenta en su alerta `REFUND_REJECTED` y se reintenta con espera creciente (10, 20, 40 y 80 min) hasta 5 fallos y una persona puede reactivarla (`reactivateRejectedRefund`); los fallos propios no gastan intentos; una de resultado desconocido o con la reserva `refundSendingAt` de más de 2 h abre `REFUND_STUCK` y no se reintenta. Con la iniciativa `REFUNDING` sin nada pendiente, pasa a `REFUNDED`, libera sus cupos y, si en su hucha queda dinero de patrocinio o Auto-Impulso, abre `ESCROW_LEFTOVER`. `EXPIRED → REFUNDING` lo decide la entidad, no el cron.
- **Evento ya celebrado y contracargo** (decisión del 01-11-2026): un evento de taquilla cuya fecha ya pasó **no se reabre** a `FUNDRAISING` por un contracargo y se liquida lo recaudado, como una rifa sorteada (`removeFromInitiative` y `approveSignedPayout`). Las rifas siguen exigiendo el sorteo completo.

## 10. Facturación Veri\*factu

- KORUM factura sus servicios (fee de comercios, mantenimiento, etc.). Las facturas se emiten a través de un **proveedor de facturación homologado para Veri\*factu** detrás de la interfaz `InvoicingProvider` (`src/services/invoicing/`); KORUM guarda una copia (`Invoice`) con número, huella encadenada, URL del QR, estado del envío y PDF (`KORUM_INVOICE_PDF`).
- Obligatoriedad según el BOE vigente: 1 de enero de 2027 para sociedades. Hay un aplazamiento anunciado que no estaba aprobado en octubre de 2026; diseñar como si aplicara desde el primer día.
