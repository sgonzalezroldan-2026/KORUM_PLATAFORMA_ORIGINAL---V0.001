# Índice Anatómico Exacto de `prototype/Korum_v8.html` (`5.371` Líneas)

Utiliza este mapa con `read_file` (`StartLine` / `EndLine`) para inspeccionar únicamente la sección exacta del prototipo que corresponda a tu Micro-Sprint, garantizando **Paridad Funcional 100% ("Zero Regression")** sin saturar la ventana de contexto.

---

## 1. Estilos Globales, Cabecera Maestra Corporativa y Notificaciones (`L1–244`)
- **`L1–160`**: Configuración Tailwind `corp` + `patio`, `.font-corp`, `.tabular-nums`, `.korum-paper-dots`, `.korum-court-grid`, `.korum-notebook-sheet`, `.die-cut-sticker`, `.tactile-btn`, `.korum-trust-vault`, `.mobile-simulator-wrap`, `.mobile-stack`, `.sortable-th`, `#delayed-tooltip` (`1s`) y reglas `@media print`.
- **`L161–244`**: Barra Superior Maestra KORUM (Nuevo Logotipo Corporativo *"Escudo Ágora-K"*, descriptor institucional `QUÓRUM · ESCROW · COMUNIDAD`, insignia `Custodia Escrow PSD2`, conmutador `🖥️ Web` / `📱 Móvil`, selector rápido de 3 cuentas anti-fraude + invitado, botón `🔐` y Toast `#toast`).

## 2. Markup HTML — Entorno 1: Familias y Comercios (`L245–617`)
- **`L245–305`**: Hero de Patio personalizable (`#school-hero-header`) con ilustración de patio integrada, subrayado de cera en *"mejoras reales"*, co-branding `Custodia Garantizada KORUM Escrow`, botón `🐷 Mi Hucha` (`#header-wallet-pill`) y Barra de Impacto Colectivo con garantía PSD2.
- **`L306–361`**: Pestañas principales (`activas`, `ideas`, `logros`, `comercios`, `faq`), botón `🔍 Filtrar` y `#family-filters-bar` (`hidden` por defecto).
- **`L362–369`**: `#fview-activas` (grid de campañas) y `#fview-detail` (contenedor de ficha detallada `.mobile-stack`).
- **`L370–386`**: `#fview-ideas` (Buzón de Ideas con Quórum y regla Padre/Madre).
- **`L387–398`**: `#fview-logros` (Galería Antes y Después).
- **`L399–418`**: `#fview-comercios` (Directorio Comercios Amigos Oro/Plata/Bronce).
- **`L419–570`**: `#fview-mihucha` (`.mobile-stack`: recarga puntual vs programada mensual, reembolso, entradas QR, chat anónimo `#FAM-XXXX`, autogestión fiscal DNI/NIE y derecho RGPD).
- **`L571–617`**: `#fview-faq` (`.mobile-stack`: acordeones FAQ y buzón inteligente de ayuda).

## 3. Markup HTML — Entorno 2: Panel Colegio / AFA / Club (`L618–1158`)
- **`L618–659`**: Cabecera mancomunada del Centro, selector de centro demo, **Kit de 3 Medallas (`Bronce`, `Plata`, `Oro`)** y sub-navegación (`dashboard`, `moderation`, `studio`, `escrow`, `support`).
- **`L660–712`**: `#sch-sub-dashboard` (KPIs del centro, filtros ocultos tras botón y línea gráfica de 6 estados con ID Escrow).
- **`L713–829`**: `#sch-sub-moderation` (Moderación Fase 0, Doble Check con auditoría de firmas Verificadas/Sospechosas, moderación y renovación de comercios, KYB Paycomet y configuración visual/reglas del centro).
- **`L830–1073`**: `#sch-sub-studio` (Estudio de Edición Dual: selector `Presupuesto` vs `Taquilla/Rifa`, candado semántico, Placa y Reto independientes, Pizarra TCO de 5 líneas en vivo y botón de Cartel A4 + QR).
- **`L1074–1132`**: `#sch-sub-escrow` (Liquidación 100% a proveedor/centro, subida fotos Antes/Después, encuesta de redimensionamiento y reembolso automático 100%).
- **`L1133–1158`**: `#sch-sub-support` (Canal prioritario Centro ➔ Super-Admin).

## 4. Markup HTML — Entorno 3: Consola Super-Admin KORUM (`L1159–1478`)
- **`L1159–1182`**: Cabecera ejecutiva Super-Admin y sub-pestañas (`bi`, `crm`, `rules`, `tickets`).
- **`L1183–1321`**: `#sa-sub-bi` (KPIs globales, Gráfico de las 6 Fuentes de Ingresos, Tabla de Centros con `Cerradas Año/Hist.` y `Comercios Act./Hist.`, Top 10 e Iniciativas Globales con `💛 Aportaciones` y cabeceras ordenables `↕`).
- **`L1322–1332`**: `#sa-sub-crm` (Contenedor de la Ficha 360º Ampliada del Centro).
- **`L1333–1468`**: `#sa-sub-rules` (Tramos globales, costes reales Paycomet, validador en vivo de *Gastos de gestión digital*, mantenimiento con tope anual, medallas y gestor de categorías globales).
- **`L1469–1478`**: `#sa-sub-tickets` (Bandeja centralizada de soporte).

## 5. Modales Globales e Imprimibles (`L1479–1915`)
- **`L1479–1635`**: `#checkout-modal` (Checkout Dual Familia / Taquilla / Comercio con escudo KORUM, custodia Escrow regulada PSD2, check `🛡️ Activar aportación de garantía KORUM`, selector de cursos y métodos de pago).
- **`L1636–1679`**: `#withdraw-iban-modal` *(Nota v8.5: migrado en producción a modal de Reembolso `Refund` PSD2 al medio de pago original con advertencia oficial)*.
- **`L1680–1738`**: `#printable-ticket-modal` (Entrada / Papeleta QR imprimible con cabecera y pie oficial KORUM Escrow).
- **`L1739–1785`**: `#medal-kit-modal` (Kit Oficial de Medalla descargable con sello web e informe).
- **`L1786–1808`**: `#new-idea-modal` y `#sponsor-detail-modal`.
- **`L1809–1867`**: `#poster-modal` (Cartel Oficial A4 imprimible con QR real y marco institucional KORUM Escrow).
- **`L1868–1915`**: `#share-modal` (WhatsApp / redes) y `#login-modal`.

## 6. Estado y Lógica JavaScript de Referencia (`L1916–5371`)
- **`L1916–2351`**: Estado maestro (`globalRules`, `medalsConfig`, `schoolsDB`, `initiatives`, `sponsors`, `ideas`, `tickets`).
- **`L2352–2446`**: Categorías efectivas, exenciones, cálculo tarifa digital taquilla y candado semántico.
- **`L2447–2750`**: Renderizado de portada de Familias (`renderFamilyCampaigns` con `.die-cut-sticker`, `.tactile-btn`, `tabular-nums`) y Ficha Detallada (`openInitiativeDetail` con `.korum-trust-vault` y 4 líneas auditadas).
- **`L2751–3115`**: Lógica completa del Checkout (`openCheckoutModal`, `updateChkSummary`, `completeDonation`).
- **`L3116–3312`**: Buzón de Ideas (`renderFamilyIdeas` con `.korum-notebook-sheet`, `votePublicIdea`, `submitAnonymousIdeaPhase0`), Logros (`renderFamilyAchievements`) y Comercios (`renderFamilySponsors`).
- **`L3313–3504`**: Lógica de *Mi Hucha*, DNI/NIE módulo 23, certificados fiscales y olvido RGPD.
- **`L3505–3806`**: Cuadro de Mandos del Centro, Kit de Medallas, Moderación, Renovación de Comercios y Ajustes del Centro.
- **`L3807–4230`**: Estudio Dual (`loadInitiativeIntoStudio`, `recalcStudioTCO`, `saveInitiativeFromStudio`), Liquidaciones, Fotos Antes/Después y Cartel A4.
- **`L4231–4709`**: Analítica BI Super-Admin, Gráfico de 6 Fuentes, Ordenación `↕` (`sortSaTable`), Alertas `💎`/`🚨`, Auto-Impulso y Pop-up Ejecutivo.
- **`L4710–5188`**: Ficha 360º (`renderSchoolCRM360`), Reglas Globales, Validador de Gestión Digital y Soporte/Moderación.
- **`L5189–5371`**: Navegación de entornos, simulador móvil `430px`, perfiles demo y tooltip diferido de `1000ms`.
