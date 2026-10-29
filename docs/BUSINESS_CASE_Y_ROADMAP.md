# Business Case, Unit Economics (Paycomet) y Hoja de Ruta Lean · KORUM

## 1. Filosofía Financiera: Automatización 100% Autónoma, Coste Mínimo e Independencia Total

KORUM está concebido como una **plataforma SaaS/Fintech pura de alta eficiencia operativa ("Zero-Touch Operations")**:
- **Cero Intermediación de Proveedores:** KORUM no gasta recursos humanos buscando, homologando ni gestionando instaladores, manteniendo una estructura fija ultrarrápida y una imagen inmaculada de **100% independencia y transparencia** ante claustros docentes y familias.
- **Cero Coste Hundido de Pasarela (Paycomet en Céntimos Enteros):**
  - **Tarifa Media Negociada Paycomet (Entidad de Pago Banco de España):** `1,00%` variable (`100 bps`) + `0,09 €` fijo (`9 cts`) por transacción.
  - **Cobertura Matemática Exacta:**
    1. **En Iniciativas de Presupuesto (`BUDGET`):** La calculadora TCO incorpora el coste de pasarela en la Línea 5 (incluyendo los céntimos de redondeo al euro superior) dentro de la meta pública.
    2. **En Taquilla y Rifas QR (`TICKETING`):** Los **"Gastos de gestión digital"** (`0,45 € fijo + 2,0%` por defecto = `0,55 €` en una entrada de `5,00 €`) cubren el coste real de Paycomet sobre el cobro bruto (`5,55 € × 1% + 0,09 € = 0,15 €`) y dejan **`+0,40 €` de margen neto limpio por cada entrada vendida**.
    3. **En cargos de Mi Hucha:** el fee por defecto de `0,25 €` solo cubre el coste de Paycomet en cargos de **menos de 16 €** (`0,25 > 1 % × importe + 0,09`). En un cargo de 50 € se pierden 0,34 €. El fee (fijo + porcentaje) es configurable por el Super-Admin y la consola avisa cuando pierde dinero. Ver §5.

---

## 2. Unit Economics por Centro Activo (Colegio de 2 Líneas o Club Deportivo)

Para un centro o club tipo de **450 familias** que ejecuta de forma autónoma **2 campañas de mejora** (`12.000 €` recaudados) + **1 evento de taquilla/rifa QR** (`300 entradas a 5 € = 1.500 €`) + **3 comercios patrocinadores** (`1 Oro de 500 €` + `2 Plata de 250 € = 1.000 €`):

| Fuente de Ingreso KORUM (6 Vías Transparentes) | Cálculo Anual por Centro | Ingreso Neto KORUM / Centro |
| :--- | :--- | :---: |
| **1. 🛡️ Aportaciones Voluntarias a KORUM** | ~320 aportaciones × `1,80 €` × 75% de activación (**supuesto a validar**: con el check desmarcado puede ser bastante menor; al 30% serían 172,80 €) | **432,00 €** |
| **2. 🏗️ Comisión por Tramos (Obras/Equipamiento)** | `12.000 €` menos `2.000 €` exentos (Base + Medalla) al `4%` | **400,00 €** |
| **3. 🏪 Fee de Comercios Patrocinadores (+15%)** | `15%` añadido sobre `1.000 €` de patrocinios íntegros (Veri\*factu) | **150,00 €** |
| **4. 🎟️ Margen Neto en "Gastos de gestión digital" (QR)** | 300 entradas × (`0,55 €` cobrados - `0,15 €` Paycomet bruto) | **120,00 €** |
| **5. ⚙️ Cuota de Mantenimiento con Tope Anual ("La Baza")** | `0,00 €` en captación o hasta `147,00 €/año` en madurez | **0,00 € – 147,00 €** |
| **6. 🐷 Gestión de Mi Hucha** | ~120 cargos × `0,10 €` de margen neto (solo se cumple con cargos de unos 6 €; ver §5) | **12,00 €** |
| **TOTAL INGRESO NETO ANUAL POR CENTRO ACTIVO** | **Sin activar cuota fija / Con cuota fija activa** | **1.114,00 € – 1.261,00 € / año** |

> **Objetivos (no datos medidos):** las tarjetas dinámicas para WhatsApp, el modo portería y la automatización del Modelo 182 buscan una tasa de éxito de campañas superior al `90%` y una retención anual de entidades superior al `95%`. Se medirán en el piloto con las métricas de [EXPERIENCIA_DE_PRODUCTO.md](EXPERIENCIA_DE_PRODUCTO.md) §9.

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

El detalle de cada sprint está en [PLAN_IMPLEMENTACION_ATOMICO.md](PLAN_IMPLEMENTACION_ATOMICO.md). El calendario real se fija después del Sprint 1.1, midiendo la velocidad efectiva. **Por decisión del promotor (29-10-2026), las respuestas escritas de Paycomet y la revisión del abogado y de la asesoría fiscal se aplazan hasta ver cómo evoluciona el proyecto** (ver «Tareas externas aplazadas» en el [plan](PLAN_IMPLEMENTACION_ATOMICO.md)). Mientras tanto se construye contra el simulador. **Son requisito antes de cobrar dinero real**: sin ellas no hay preproducción con cobros reales (Sprint 6.1) ni piloto (Sprint 6.2), y el KYB de las primeras entidades tampoco se puede cerrar.

1. **Etapa 1 · Cimientos (Fase 1, 4 sprints):** proyecto, idiomas, arnés QA, libro mayor de doble partida, semilla y motor TCO/BI.
2. **Etapa 2 · Motores de backend (Fase 2, 6 sprints):** Paycomet (sandbox), antifraude y doble firma, taquilla y fiscalidad, operación, privacidad y notificaciones. **Aplazado:** contrato con Paycomet, abogado y asesoría fiscal (se retoman antes de la Etapa 4).
3. **Etapa 3 · Interfaces (Fases 3 a 5, 18 sprints):** landing y SEO, acceso, portal de familias, panel de la entidad, portería, consola del Super-Admin, ajustes, pulido y certificación.
4. **Etapa 4 · Preproducción y piloto (Fase 6):** infraestructura en la UE, pruebas en el sandbox real, visto bueno legal y piloto con las primeras 3 entidades.

---

## 5. Supuestos a recalibrar y decisiones de negocio pendientes

1. **Activación de la aportación voluntaria:** el 75% suponía un check premarcado. Con el check desmarcado hay que medir la tasa real en el piloto y recalcular la vía 1 y la proyección del §3.
2. **Margen de Mi Hucha (resuelto: configurable + aviso):** con `0,25 €` fijos, cualquier cargo de más de 16 € pierde dinero. El fee es **fijo + porcentaje** y lo edita el Super-Admin; mientras la combinación pierda dinero, la consola muestra el aviso `HUCHA_FEE_BELOW_GATEWAY_COST` con la cifra y decide el Super-Admin si ajusta (p. ej. `1% + 0,10 €`) o lo acepta como coste de captación. El valor inicial sigue siendo `0,25 €` + `0 %`; hay que **medir el importe medio real de los cargos en el piloto** antes de fijarlo.
3. **Efecto escalón de los tramos (resuelto: configurable + aviso):** un neto de 5.000,00 € paga más comisión que uno de 5.000,01 € en modo `FLAT` (ver la skill TCO). El Super-Admin puede cambiar a modo `MARGINAL` y editar umbrales y tarifas; mientras esté en `FLAT`, la consola muestra el aviso `BRACKET_CLIFF`. El valor inicial es `FLAT` porque reproduce el prototipo y la semilla.
4. **Campañas fallidas:** se devuelve el 100% de lo cobrado, incluida la aportación voluntaria, así que esas campañas no generan ingresos. Falta conocer el coste de las devoluciones (según el promotor, Paycomet no cobra por ellas; pendiente de confirmar por escrito).
5. **Contracargos:** no estaban modelados. Si llegan tras liquidar, los asume KORUM.
6. **Coste de captación:** el modelo es autónomo, pero las primeras entidades necesitarán acompañamiento comercial; conviene presupuestarlo en el año 1.
7. **Auto-Impulso:** fijar un presupuesto anual máximo para que las alertas 💎 no se conviertan en un coste descontrolado.

