# Regla 02 · Invariantes Financieros, Regulatorios (PSD2/AEAT) y Reglas Contables

## 1. Operaciones en Céntimos Enteros y Cuadre al 100% en Ficha Pública (4 Líneas = Meta)
Todo cálculo financiero se ejecuta en **céntimos enteros (`Int`)**. Si la meta pública se redondea al euro entero superior (`Math.ceil` a múltiplo de `100` céntimos), los céntimos de redondeo (`0–99 cts`) se integran en `gatewayBufferCents` para que **jamás exista descuadre ni en la pizarra interna ni en la ficha pública**.
Si el centro activa `showPublicBreakdown`, la ficha pública **nunca expone tramos internos**, pero sus **4 líneas visibles suman exactamente `goalCents` (100% de la Meta Total)**:
1. `Presupuesto Proveedor y Equipamiento` (`costMatCents`)
2. `Instalación y Adecuación Técnica` (`costInstCents`)
3. `Reserva de Mantenimiento, Riesgos y Contingencia` (`Math.round((costMatCents + costInstCents) * contingencyBps / 10000)`)
4. `Coste financiero Escrow, plataforma, gestión y garantía de devolución` (`goalCents - (costMatCents + costInstCents + contingencyCents)`)
- **Suma obligatoria:** `Línea 1 + Línea 2 + Línea 3 + Línea 4 === goalCents`.
- **Excedente en frontera del 100%:** Si la última aportación o patrocinio hace que `raisedCents > goalCents`, la iniciativa cierra al instante nuevas aportaciones (`Logro Conseguido`) y el excedente neto se liquida 100% íntegro al centro como *Reserva Adicional del Proyecto*.

## 2. Desglose Interno en el Estudio de Edición del Centro (Pizarra TCO Dual e Independencia)
- **Independencia 100% de Proveedores:** El centro introduce libremente el presupuesto de su proveedor elegido; KORUM jamás cobra comisiones ocultas a proveedores.
- **Reserva Reversible de Cupos:** El cupo exento anual (`exemptLimitCents`), la beca de medalla y el tope anual de mantenimiento se reservan al publicar (`Recaudando`) y **se restituyen automáticamente al centro si la campaña se cancela o reembolsa sin éxito**.
- **En modo Presupuesto (`BUDGET`):** Mostrar en líneas separadas cuadradas al céntimo con `goalCents`:
  1. `Importe Exento por Defecto` (ej. `1.000,00 € al 0%`).
  2. `Beca Exenta por Medalla` (`Bronce`, `Plata` u `Oro` al `0%`, indicando el ahorro exacto en euros generado para el centro).
  3. `Resto sujeto a tramo` (aplicando el tramo global o personalizado del centro).
  4. `Cargo Mantenimiento Plataforma`: Si es `0`, mostrar **únicamente `0,00 €`** (prohibido añadir *"(Desactivado)"*). Si está activo, aplicar hasta el **Tope Anual Auto-Desactivable**, pasando a `0,00 €` automáticamente el resto del curso.
  5. `Coste Pasarela Escrow (Paycomet)`: Importe exacto (incluyendo redondeo al euro superior si aplica) y debajo la explicación explícita (`% variable sobre subtotal + € fijo por nº estimado de aportaciones según el botón premarcado del centro`).
- **En modo Taquilla / Rifas (`TICKETING`):** Mostrar el desglose exclusivo de eventos (`Recaudación Bruta Aforo`, `Gastos de gestión digital por entrada`, `Coste Pasarela cubierto por gestión`, `Mantenimiento` y `Neto Garantizado para el Centro`), añadiendo aviso normativo sobre rifas ocasionales cuando `ticketSubtype === 'RAFFLE'`.

## 3. Patrocinio de Comercios 100% Íntegro, Facturación Veri\*factu y Bolsa de Respaldo
- El **100% del nivel elegido** (`100 €`, `250 €` o `500 €`) se suma íntegro a la iniciativa del centro.
- El Fee de gestión publicitaria (`15%` por defecto + impuestos aplicables) se **suma encima** (`250,00 € íntegros al centro + 37,50 € Fee`), emitiendo justificante del 100% de patrocinio más **factura con huella hash y QR Veri\*factu (RD 1007/2023)** por el servicio de KORUM.
- Si una campaña vence sin éxito y se ejecuta reembolso a familias, el patrocinio se reasigna según la regla del centro; si no hay otra campaña activa en ese instante, queda custodiado en la **Bolsa de Patrocinio Reservada (`CREDIT_POOL`)** avisando al comercio (con opción de reembolso si no se asigna en 60 días).

## 4. "Gastos de gestión digital" en Entradas y Papeletas QR (Cálculo Real Paycomet)
- Se denomina única y estrictamente **"Gastos de gestión digital"** y se configura exclusivamente desde Super-Admin (`Fijo + % sobre precio entrada`).
- En modo `ADD`, el validador en vivo calcula el coste porcentual de Paycomet sobre el **importe bruto total cobrado al comprador (`precio + gasto de gestión digital`)** más el fijo por transacción, garantizando margen neto real positivo en cada entrada.

## 5. Cumplimiento PSD2/AML en "Mi Hucha" y Rigor Fiscal IRPF (Ley 49/2002)
- **Prohibición de SEPA a IBAN libre:** Para cumplir con PSD2 (evitar emisión de dinero electrónico no regulado) y prevención de blanqueo de capitales (AML), toda retirada de saldo disponible en *Mi Hucha* se ejecuta mediante **`Refund` automático en Paycomet al medio de pago original** (tarjeta/Bizum de recarga). Solo ante tarjeta caducada/rechazada se tramita excepción documental verificada.
- **Separación Fiscal Estricta (Modelo 182 AEAT):** Ni las recargas de *Mi Hucha* (`TOPUP`) ni la compra de entradas/rifas (`TICKET`) computan jamás en el certificado fiscal anual; únicamente computan las **donaciones puras irrevocables (`DONATION`)** en campañas no reembolsadas.

## 6. Analítica BI Real vs. Proyectada y Alertas Algorítmicas en Super-Admin
- Prohibido inyectar ingresos ficticios (`8,00 €` fijos de Hucha o `1%` de comercios inexistentes). El BI separa **Ingresos Reales Devengados** (leídos del Ledger contable real) de **Ingresos Proyectados al 100%**, asegurando que la suma de las **6 vías del Gráfico de Fuentes de Ingresos coincida al céntimo con el KPI de Ingreso Neto**.
- Toda tabla e informe de iniciativas calcula en tiempo real:
  1. **🚨 Alerta de Peligro de Retorno Negativo (`netRevenueCents < 0`):** Muestra `🚨 ¡Peligro Retorno Negativo! (-X,XX €) · Ajustar Precios` con corrección en 1 clic.
  2. **💎 Alerta de Auto-Impulso Rentable (`missingTo100Cents > 0 && netRevenueCents - missingTo100Cents > 0`):** Muestra `💎 ¡Auto-Impulso Rentable! Aportar X € ➔ Retorno +Y €` con ejecución auditada en 1 clic.

