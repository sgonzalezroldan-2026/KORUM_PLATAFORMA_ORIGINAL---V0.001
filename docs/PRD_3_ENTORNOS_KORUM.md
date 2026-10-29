# PRD Funcional Maestro · KORUM (v8.5 Next-Level Production Spec)

> **Base Visual e Interactiva:** Conserva el 100% de botones, tablas y flujos de `@[Prototipo Maestro v8.0](prototype/Korum_v8.html)`, elevándolos con precisión bancaria en céntimos enteros, blindaje PSD2/AEAT/Veri\*factu, multi-verticalidad real, tarjetas virales para WhatsApp y Modo Portería QR.

---

## 1. Entorno 1: Web/App Pública Familias, Socios y Comercios (`/[orgSlug]`)

### 1.1 Cabecera Corporativa y Barra de Impacto Colectivo
- **Identidad Dinámica por Organización:** Muestra logotipo (o icono según vertical: `🏫` Colegio / `🏀` Club Deportivo / `🎵` Cultural), nombre, insignia, lema, paleta corporativa (`--brand-primary`, `--brand-secondary`) e imagen de portada opcional.
- **Acceso Único a "Mi Hucha":** Botón superior derecho con píldora de saldo disponible en tiempo real (`35,00 €`).
- **Banner de Impacto del Curso/Temporada:** Suma total recaudada en el curso activo y acceso directo a `Mejoras Logradas (Ver Antes y Después →)`.

### 1.2 Navegación y Filtros Ocultos por Defecto
- **5 Pestañas Públicas:** `🚀 Iniciativas y Taquilla`, `💡 Buzón de Ideas`, `🎉 Logros Conseguidos`, `🏪 Comercios Amigos`, `❓ FAQ y Soporte`.
- **Botón Minimalista `🔍 Filtrar`:** Los filtros (*Categoría*, *Urgencia/Formato* y *Etapa/Categoría Deportiva*) permanecen **ocultos por defecto** en todas las vistas y solo se despliegan al pulsar `🔍 Filtrar`, mostrando contador numérico de filtros activos y `Limpiar filtros`.

### 1.3 Listado de Iniciativas (`status === 'Recaudando'`) y Motor Viral WhatsApp (`next/og`)
- **Filtro Estricto de Estado:** Únicamente se listan iniciativas en `Recaudando` (destacando insignia `⚡ Bono Multiplicador 2x Activo` cuando disponen de bolsa de co-mecenazgo activa). Al alcanzar el 100% se cierran al instante nuevas aportaciones y pasan a `Logro Conseguido`.
- **Contador de Aportaciones Totales:** Bajo la barra de progreso muestra `💛 X aportaciones` (`totalContributions`).
- **Compartición Viral Optimizada para Grupos de WhatsApp (`📤`):** Cada enlace compartido (`/api/og/initiative/[id]?group=...`) autogenera una tarjeta gráfica OpenGraph en vivo con el logo del centro, porcentaje recaudado, días restantes y cuántas familias faltan en ese curso/equipo para desbloquear su premio colectivo.

### 1.4 Ficha Pública de Iniciativa (Diseño Vertical `.mobile-stack`)
- **Constancia de Transparencia Limpia (Sin barra de 6 pasos):** Muestra exclusivamente **Hucha Escrow Garantizada (`WLT-ESC-XXX`)** y **Fecha límite**.
- **Reto Colectivo Multi-Vertical (Condicional `rewardEnabled`):** Muestra el premio colectivo y las barras de progreso por curso escolar o categoría deportiva hacia la meta de familias.
- **Placa Conmemorativa (Condicional Independiente `plaqueEnabled`):** Insignia visible si está activa.
- **Desglose Público Cuadrado al 100% en Céntimos (4 Líneas):**
  - Si `showPublicBreakdown === true`, las 4 partidas suman **exactamente** `TOTAL OBJETIVO A RECAUDAR`:
    1. `Presupuesto Proveedor y Equipamiento` (proveedor elegido con 100% independencia por el centro)
    2. `Instalación y Adecuación Técnica`
    3. `Reserva de Mantenimiento, Riesgos y Contingencia (%)`
    4. `Coste financiero Escrow, plataforma, gestión y garantía de devolución`
  - Al pie incluye la nota oficial de transparencia total. Si `showPublicBreakdown === false`, muestra el sello de presupuesto validado mancomunadamente por Dirección y AFA/Junta.

### 1.5 Modal de Checkout Dual (Familias, Taquilla QR y Comercios)
- **Modo 1 — Familia / Socio / Vecino (10s sin Registro + Email Ligero en Invitado):**
  - Si el usuario no ha iniciado sesión, incluye un único campo limpio `📧 Tu email para enviarte al instante tu recibo Escrow / entradas QR` (sin pedir contraseña).
  - Botones de donación configurados por el centro con valor premarcado (`⭐`) + importe libre.
  - Desplegable dinámico según vertical: **13 cursos oficiales (+ 2 comunidad)** para Colegios/AFAs o **Categorías Deportivas (+ Afición)** para Clubes Deportivos.
  - Check premarcado **`🛡️ Activar aportación de garantía KORUM (+X,XX €)`** con copywriting condicional en el punto `(3)` según `organization.ley49`: `Certificado Fiscal IRPF (Ley 49/2002)` si `true` o `Justificante Oficial Nominativo de Aportación` si `false`, más selector manual desde `0 €`.
- **Modo 2 — Taquilla Escolar y Rifas Digitales QR:**
  - Selector `-` / `+` con **bloqueo atómico de aforo disponible (`ticketMax - ticketsSold`)** en UI y en transacción de servidor.
  - Desglose de precio unitario + **"Gastos de gestión digital"**.
  - Generación inmediata y envío por email del **Pase / Papeleta Numerada Imprimible con Código QR firmado con HMAC (`#PASE-2026-XXXX` o `#RIFA-2026-XXXX` con números `#0001`–`#N`)**.
- **Modo 3 — Comercio Local (Patrocinio 100% Íntegro + Fee Encima + Veri\*factu):**
  - Categorías `🥉 Bronce`, `🥈 Plata ⭐` u `🥇 Oro` (con opción de destinar patrocinio Oro a bolsa *Matching 2x*). El 100% va íntegro al centro y el `% Fee` se factura encima emitiendo justificante del 100% + **Factura Oficial Veri\*factu**.
  - Datos fiscales, cupón promocional y **Renovación Automática Anual** (`JET-ID`) con preaviso 30 días antes.

### 1.6 Buzón de Ideas (Quórum con Regla Padre/Madre en Servidor `<= 2` Cuentas/Dispositivo)
- Propuestas con alias privado (`Código #FAM-XXXX`).
- `✍️ Firmar Apoyo` exige sesión con email verificado y normalizado (`canonicalEmail`, bloqueando alias `+` y correos temporales), permitiendo `1 firma/usuario` por idea.
- **Regla Doméstica Auditada:** La **1ª y 2ª cuenta familiar** en un mismo dispositivo se registran como `🟢 Verificadas`; a partir de la **3ª cuenta (`>= 3`)** o ante ráfagas IP se etiqueta como `⚠️ Sospechosa`.

### 1.7 Directorio de Comercios Amigos (Solo Categoría y Orden por Rango)
- Cero importes ni fees en público; solo insignia `🥇 ORO`, `🥈 PLATA` o `🥉 BRONCE` ordenados estrictamente **Oro > Plata > Bronce**.

### 1.8 Área Privada "Mi Hucha KORUM" (Cumplimiento PSD2/AML y Rigor Fiscal)
- **Módulo Dual de Recarga:** `⚡ Recarga Puntual Instantánea` y `🔄 Mensual Programada` (`JET-ID`).
- **Retirada Segura al Medio de Pago Original (`Refund` PSD2):** Al solicitar retirar el saldo disponible, muestra la advertencia obligatoria y ejecuta **`Refund` automático en Paycomet hacia la tarjeta/Bizum de origen** (sin pedir IBANs libres para evitar fraude AML y dinero electrónico no regulado), dejando el saldo a `0,00 €` y deshabilitando el botón de Hucha en Checkout hasta nueva recarga.
- **Autogestión Fiscal Estricta y RGPD:** Validador NIF/NIE en vivo, descarga de Certificado IRPF (`ley49: true`) o Justificante Nominativo (`ley49: false`) **computando exclusivamente donaciones puras irrevocables (`DONATION`)** (excluyendo siempre recargas `TOPUP` y entradas `TICKET`), reapertura de QR, chat anónimo con el centro y botón de anonimización RGPD.

---

## 2. Entorno 2: Panel Gestor Colegio / AFA / Club (`/school/[orgSlug]`)

1. **Cabecera, Kit de Medallas y Exportador Modelo 182 AEAT:** Muestra estado KYB Paycomet, cupo exento base restante, beca por medalla disponible, botón `🏅 Sello + Post Redes` y (si `ley49 === true`) botón `📥 Exportar Fichero Oficial Modelo 182 AEAT (.BOE)` para presentar en enero sin gestoría.
2. **Cuadro de Mandos e Histórico:** Filtros ocultos tras `🔍 Filtrar Cuadro de Mandos`, 5 KPIs y línea gráfica de 6 estados con `Wallet ID` y acceso directo al Estudio.
3. **Gestor de Aprobaciones, Doble Firma Real y Configuraciones:**
   - Bandeja de ideas con desplegable de Auditoría (`🟢 Verificadas` vs `⚠️ Sospechosas`), chat anónimo y **Doble Check mancomunado real (`1/2` → `2/2` entre `ROLE_DIRECTOR` y `ROLE_AFA_PRESIDENT` con envío de enlace OTP en 1 clic)**.
   - Conexión bancaria KYB Paycomet (4 documentos), moderación de comercios (incluyendo bolsa `CREDIT_POOL` y regla de renovación anual) y configurador de botones de donación, grupos de participación e identidad visual.
4. **Estudio de Edición Dual (`Presupuesto` Libre de Proveedor vs. `Taquilla QR`):**
   - Independencia 100% de proveedores, candado semántico `\b` sin falsos positivos, aviso normativo DGOJ/CCAA al elegir `RAFFLE`, selectores independientes de Reto Colectivo y Placa, y pizarra TCO dual en céntimos (mostrando solo `0,00 €` cuando mantenimiento está apagado).
5. **Logros, Liquidaciones Mancomunadas, Modo Portería QR y Cartel A4:**
   - Liquidación al IBAN del proveedor (exigiendo factura PDF adjunta) o cuenta del centro **con doble firma mancomunada obligatoria**, subida de fotos Antes/Después, o votación de redimensionamiento / reembolso 100% (liberando cupos exentos reservados y reasignando comercios o enviándolos a `CREDIT_POOL`).
   - Generador de **PIN temporal para `/school/[orgSlug]/porteria`** (escáner móvil de cámara contra entradas QR fotocopiadas + pantalla de sorteo certificado en vivo para rifas) y Configurador de Cartel A4 + QR real.

---

## 3. Entorno 3: Consola Ejecutiva Super-Admin KORUM (`/admin`)

1. **BI Ejecutivo Cuadrado (Real vs. Proyectado) y Gráfico de 6 Fuentes de Ingresos:**
   - Filtros globales por Provincia, Centro, Salud y Trimestre.
   - **Gráfico de Procedencia de Ingresos por Tipología:** 6 vías cuadradas al céntimo con `netRevenue` sin constantes mágicas inventadas, distinguiendo ingresos reales devengados en el Ledger de la proyección al 100%.
2. **Tablas Interactivas Ordenables (`↕`) y Alertas Algorítmicas:**
   - **Tabla de Rendimiento por Centro:** Con `Cerradas (Año / Hist.)` y `Comercios (Act. / Hist.)`.
   - **Tabla Top 10 Iniciativas y Listado Global:** Con columna `💛 Aportaciones`, ordenación clicable en todas las columnas (`↕`) y alertas en vivo `💎 ¡Auto-Impulso Rentable!` y `🚨 ¡Peligro Retorno Negativo!`.
3. **Pop-up Ejecutivo de Iniciativa:** Link público directo, comercios participantes en esa iniciativa y ejecución en 1 clic de Auto-Impulso o corrección de tarifas deficitarias.
4. **Ficha 360º Ampliada de Centro:** Contacto, KYB/IBAN, categorías personalizadas, condiciones económicas individuales, facturas Veri\*factu, gráfico de ingresos del centro y tabla ordenable (`↕`) de todas sus iniciativas activas e históricas.
5. **Motor de Reglas Globales y Tickets:** Categorías globales (`0% Exenta / Por Tramos`), costes Paycomet, *"Gastos de gestión digital"* con validador de cobertura sobre cobro bruto real, interruptor de mantenimiento con tope anual auto-desactivable, medallas y bandeja central de soporte.

