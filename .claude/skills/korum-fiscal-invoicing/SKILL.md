---
name: korum-fiscal-invoicing
description: Fiscalidad y facturación de KORUM. IVA del 21 % incluido en los ingresos de KORUM (cuota 21/121 en céntimos), facturas completas y simplificadas, rectificativas, registro Veri*factu, certificado fiscal de donación (Ley 49/2002), justificante nominativo y Modelo 182. Cargar siempre que se programen o modifiquen ingresos de KORUM con IVA, facturas, recibos con datos fiscales, certificados, el Modelo 182 o el adaptador de Veri*factu (Sprints 5.15, 5.16, 5.20, 5.21, 5.22 y 5.23).
---

<!-- GENERADO AUTOMÁTICAMENTE desde .agents/skills/korum-fiscal-invoicing/SKILL.md por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->

# Skill · Fiscalidad y facturación (IVA, facturas, Veri\*factu, certificados y Modelo 182)

> **De dónde sale:** decisiones del promotor del 2026-11-17 y del 2026-11-18 ([CUMPLIMIENTO §8](../../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md), decisiones 21, 22, 23, 27, 28, 42, 44 y 46; detalle en [PRERREVISION_LEGAL_Y_FISCAL.md](../../../docs/PRERREVISION_LEGAL_Y_FISCAL.md) §3.1). Las reglas de dinero mandan en la [Regla 02](../../rules/02-invariantes-financieros.md) §9, §11 y §12; aquí está el cómo.
> **Estado:** casi todo está **decidido y pendiente de construir**. Cada apartado dice su sprint y qué hace el código hoy. No se adelanta una regla fuera de su sprint.
> **Quién valida:** el promotor. Una duda fiscal nueva se le plantea primero a él (Regla 04 §2). Hay tres consultas a la asesoría que no bloquean nada: la aportación voluntaria sin IVA, el año del donativo «todo o nada» y si el Auto-Impulso es gasto deducible.

## 1. IVA incluido en los ingresos de KORUM (Sprint 5.20a)

| Ingreso de KORUM | IVA | Quién recibe la factura |
| :--- | :--- | :--- |
| Comisión por tramos y mantenimiento | 21 % **dentro** del importe | La entidad: factura completa por liquidación |
| «Gastos de gestión digital» (entradas y vales) | 21 % **dentro** del importe | Quien compra: factura simplificada en su recibo |
| Gestión de Mi Hucha | 21 % **dentro** del importe | La familia: factura simplificada en su recibo |
| Gestión de comercios (los dos modos) | 21 % **encima**, como hoy | El comercio: factura completa |
| **Aportación voluntaria a KORUM** | **No sujeta: sin IVA y sin factura** | Nadie |
| Auto-Impulso | No es un ingreso: gasto promocional de KORUM | Nadie (la factura a la entidad es por la comisión entera) |

- **Fórmula, en céntimos enteros:** `vatCents = Math.round(grossCents * 21 / 121)` y `baseCents = grossCents - vatCents`. Siempre `baseCents + vatCents === grossCents`. Nada de `Float`.
- **Nadie paga más:** metas, pizarra TCO, desglose público y textos oficiales no cambian. Quien ingresa menos es KORUM.
- **Libro mayor:** la cuota va a su cuenta de IVA repercutido en el **mismo asiento** que el ingreso (el asiento sigue cuadrando: `Σ DEBIT === Σ CREDIT`). Un reembolso o un contra-asiento revierte también su cuota.
- **BI y alertas:** ingresos reales, proyección, seis fuentes, 🚨 y 💎 cuentan la **base sin IVA** ([korum-tco-calculator](../korum-tco-calculator/SKILL.md)). Ejemplo del 💎: comisión de 350,00 € = 289,26 € de base; si faltan 300,00 €, el retorno es −10,74 € y el aviso no sale.
- **Aportación voluntaria sin IVA:** solo vale si se mantiene voluntaria, con la casilla desmarcada, de importe libre desde 0 € y sin ninguna ventaja para quien la da. Cambiar cualquiera de las cuatro cosas obliga a volver a preguntarlo.
- **Hoy:** solo la gestión de comercios calcula IVA (`SPONSOR_FEE_VAT_BPS`) y factura.

## 2. Facturas (Sprint 5.20b)

- **El emisor es siempre KORUM** en la plataforma (`invoicing.issuerNif`, `invoicing.issuerName`). La factura de una entidad a su comercio (modo publicidad) la emite la entidad con su programa y la **sube**; KORUM no la genera.
- **Completa** (entidades y comercios): base, IVA y total, NIF y domicilio fiscal del destinatario (el del comercio se pide en su alta, Sprint 5.16b).
- **Simplificada** (familias y compradores): los datos van dentro del email del recibo, con «IVA incluido» y un enlace para descargarla en PDF. Un solo email, sin adjuntos.
- **Rectificativa:** identifica siempre la factura que corrige. Se emite al **no admitir** a un comercio (no al devolver) y al devolver la gestión de Mi Hucha en sus 14 días.
- **Contracargo de un comercio ya facturado:** la factura se anula con una rectificativa automática **solo si el banco indica fraude** (el titular no autorizó el pago). En cualquier otro caso se mantiene.
- **Cuadre:** cada factura corresponde a un asiento y sus importes coinciden al céntimo. Una prueba recorre todas las facturas y las compara con el libro mayor.
- La numeración y cualquier valor de una factura usan `node:crypto`, nunca `Math.random` (lo vigila el escáner).

## 3. Veri\*factu (Sprint 5.23)

- Se cuenta con la obligación **desde la primera factura real** (antes del 1 de enero de 2027 para sociedades; se vuelve a comprobar en el BOE al abrir el sprint).
- **Dos vías, a decidir por el promotor al abrir el sprint**, con precios reales: un proveedor (coste por factura) o el envío directo a la Agencia Tributaria con el certificado digital de KORUM.
- El adaptador vive detrás de `InvoicingProvider` (`src/services/invoicing/`). Hoy es simulado y `provider-factory.ts` falla a propósito con `PAYCOMET_MODE=live`.
- El registro de una rectificativa lleva `TipoFactura = R1`, `TipoRectificativa = I` y `FacturasRectificadas` (número y fecha de la original); `ImporteRectificacion` solo en las de sustitución. La huella encadenada no cambia.
- El envío va en el propio flujo de emisión; la tarea diaria es solo respaldo. Un envío de resultado desconocido se consulta antes de reintentar.

## 4. Donativos: certificado, justificante y Modelo 182 (Sprint 5.22)

- **Certificado fiscal** solo si `organization.ley49 === true` y `ley49VerifiedAt` no es nulo. En otro caso, **justificante nominativo de aportación**, sin efectos fiscales.
- **Cuándo existe:** solo cuando la campaña **se consigue** (meta alcanzada o redimensionamiento cerrado). Mientras tanto, *Mi cuenta* dice que estará disponible entonces. El justificante no cambia.
- **En qué año cuenta:** el de la consolidación de la campaña, no el del pago. El Modelo 182 de cada ejercicio recoge las campañas consolidadas en él.
- **Campaña que un contracargo reabre:** sus certificados quedan en suspenso hasta que vuelva a consolidarse.
- **Texto del certificado** (art. 24 de la Ley 49/2002): identificación de donante y entidad, mención de que la entidad está entre las del art. 16, fecha e importe, **destino** (el proyecto final, también tras un redimensionamiento) y carácter irrevocable.
- **Donación de un comercio** (modo donación) a una entidad con la Ley 49/2002 acreditada: donativo con certificado y dentro del Modelo 182; es firme desde el pago y cuenta en el año del pago.
- **Nunca cuentan:** entradas, vales, recargas, gestión, aportación voluntaria, Auto-Impulso ni el dinero de un comercio en modo publicidad.
- **Colegios privados con ánimo de lucro:** solo entradas y vales; no publican campañas de donación.
- **Modelo 182:** se comprueba campo a campo contra el diseño oficial vigente (la Orden HAC/1430/2025 redactó de nuevo la recurrencia, posición 132) y se valida subiendo un fichero con un caso de cada tipo al entorno de pruebas de la Agencia Tributaria, con el certificado digital del promotor. Admite declaración complementaria y sustitutiva. El NIF se guarda cifrado y se busca por HMAC; el Super-Admin no descarga el fichero de ninguna entidad.
- **Hoy:** el certificado está disponible desde el pago y el fichero incluye, señaladas, las donaciones de campañas sin resolver.

## 5. Lo que no se hace

- No se promete en ningún texto que algo «desgrava» o «es deducible» más allá del certificado de una entidad con la Ley 49/2002 acreditada. La gestión de KORUM a un comercio: él recibe su factura y decide con su asesor.
- KORUM no asesora a las entidades sobre sus obligaciones fiscales (Modelo 347, Impuesto sobre Sociedades): son suyas, y las condiciones lo dicen en una línea.
- No se añade un tercer modo de «convenio de colaboración» para comercios.
