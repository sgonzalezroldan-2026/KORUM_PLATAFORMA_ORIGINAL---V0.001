# Business Case, Unit Economics (Paycomet) y Hoja de Ruta Lean · KORUM

## 1. Filosofía Financiera: Automatización 100% Autónoma, Coste Mínimo e Independencia Total

KORUM está concebido como una **plataforma SaaS/Fintech pura de alta eficiencia operativa ("Zero-Touch Operations")**:
- **Cero Intermediación de Proveedores:** KORUM no gasta recursos humanos buscando, homologando ni gestionando instaladores, manteniendo una estructura fija ultrarrápida y una imagen inmaculada de **100% independencia y transparencia** ante claustros docentes y familias.
- **Cero Coste Hundido de Pasarela (Paycomet en Céntimos Enteros):**
  - **Tarifa Media Negociada Paycomet (Entidad de Pago Banco de España):** `1,00%` variable (`100 bps`) + `0,09 €` fijo (`9 cts`) por transacción.
  - **Cobertura Matemática Exacta:**
    1. **En Iniciativas de Presupuesto (`BUDGET`):** La calculadora TCO incorpora el coste de pasarela en la Línea 5 (incluyendo los céntimos de redondeo al euro superior) dentro de la meta pública.
    2. **En Taquilla y Rifas QR (`TICKETING`):** Los **"Gastos de gestión digital"** (`0,45 € fijo + 2,0%` por defecto = `0,55 €` en una entrada de `5,00 €`) cubren el coste real de Paycomet sobre el cobro bruto (`5,55 € × 1% + 0,09 € = 0,15 €`) y dejan **`+0,40 €` de margen neto limpio por cada entrada vendida**.
    3. **En Recargas de Mi Hucha:** El fee de recarga (`0,25 €`) cubre la transacción `JET-ID` y aporta margen positivo.

---

## 2. Unit Economics por Centro Activo (Colegio de 2 Líneas o Club Deportivo)

Para un centro o club tipo de **450 familias** que ejecuta de forma autónoma **2 campañas de mejora** (`12.000 €` recaudados) + **1 evento de taquilla/rifa QR** (`300 entradas a 5 € = 1.500 €`) + **3 comercios patrocinadores** (`1 Oro de 500 €` + `2 Plata de 250 € = 1.000 €`):

| Fuente de Ingreso KORUM (6 Vías Transparentes) | Cálculo Anual por Centro | Ingreso Neto KORUM / Centro |
| :--- | :--- | :---: |
| **1. 🛡️ Aportaciones Voluntarias de Garantía KORUM** | ~320 aportaciones × `1,80 €` × 75% conversión | **432,00 €** |
| **2. 🏗️ Comisión por Tramos (Obras/Equipamiento)** | `12.000 €` menos `2.000 €` exentos (Base + Medalla) al `4%` | **400,00 €** |
| **3. 🏪 Fee de Comercios Patrocinadores (+15%)** | `15%` añadido sobre `1.000 €` de patrocinios íntegros (Veri\*factu) | **150,00 €** |
| **4. 🎟️ Margen Neto en "Gastos de gestión digital" (QR)** | 300 entradas × (`0,55 €` cobrados - `0,15 €` Paycomet bruto) | **120,00 €** |
| **5. ⚙️ Cuota de Mantenimiento con Tope Anual ("La Baza")** | `0,00 €` en captación o hasta `147,00 €/año` en madurez | **0,00 € – 147,00 €** |
| **6. 🐷 Gestión de Recargas de Mi Hucha** | ~120 recargas × `0,10 €` margen neto | **12,00 €** |
| **TOTAL INGRESO NETO ANUAL POR CENTRO ACTIVO** | **Sin activar cuota fija / Con cuota fija activa** | **1.114,00 € – 1.261,00 € / año** |

> **Multiplicador de Conversión Viral (`next/og` WhatsApp + Modo Portería QR + Modelo 182 AEAT):** Sin añadir costes fijos a KORUM, las tarjetas dinámicas en grupos de WhatsApp y la automatización del fichero Modelo 182 elevan la tasa de éxito de campañas al `>92%` y la retención anual B2B por encima del `95%`.

---

## 3. Proyección Financiera Lean a 3 Años (Colegios + Clubes Deportivos)

| Métrica | Año 1 (Lanzamiento) | Año 2 (Tracción Viral) | Año 3 (Consolidación) |
| :--- | :---: | :---: | :---: |
| **Centros y Clubes Activos en Red** | 45 centros | 160 centros | 420 centros |
| **Volumen Transaccionado (GMV Escrow)** | 650.000 € | 2.320.000 € | 6.090.000 € |
| **Ingresos Netos KORUM (Net Revenue)** | **52.400 €** | **188.800 €** | **512.000 €** |
| **Infraestructura Cloud, Paycomet Compliance y Veri\*factu** | -6.200 € | -14.500 € | -28.000 € |
| **Estructura Lean (Automatización Self-Service)** | -36.000 € | -92.000 € | -185.000 € |
| **EBITDA (Beneficio Operativo Antes de Impuestos)** | **+10.200 €** | **+82.300 €** | **+299.000 €** |

---

## 4. Hoja de Ruta de Paso a Producción

1. **Etapa 1 (Semanas 1-2): Core Contable en Céntimos & PostgreSQL Completo (Sprints 1.1 a 1.4)**
   - Inicialización Next.js + Tailwind, despliegue de `schema/schema.prisma` completo (15 modelos en céntimos enteros), semilla completa de 8 iniciativas y suite Vitest al 100% del motor TCO y Ledger.
2. **Etapa 2 (Semanas 3-4): Paycomet Sandbox, Veri\*factu y Gobernanza Anti-Fraude (Sprints 2.1 y 2.2)**
   - Adaptador Paycomet (`Pay-In`, `Split`, `JET-ID` y `Refund` PSD2 en *Mi Hucha*), facturación Veri\*factu, normalización de emails, candado `\b` sin falsos positivos y Doble Firma Mancomunada.
3. **Etapa 3 (Semanas 5-6): Migración UI de los Entornos + Viralidad WhatsApp + Modo Portería (Sprints 3.1 a 5.3)**
   - Transformación modular de `prototype/Korum_v8.html` a Next.js incorporando tarjetas dinámicas `next/og`, plantillas multi-verticales, escáner QR `/porteria` y exportador Modelo 182 AEAT.
4. **Etapa 4 (Semana 7): Piloto Real con los Primeros 3 Centros / Clubes**
   - Alta KYB real en Paycomet Producción y lanzamiento de la primera campaña de presupuesto y la primera taquilla/rifa QR auditada.

