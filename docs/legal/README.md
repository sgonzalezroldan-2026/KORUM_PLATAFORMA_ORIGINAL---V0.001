# Textos legales de KORUM

> **Qué es esta carpeta:** los textos legales de la plataforma, escritos en la SESIÓN T1 del [plan](../PLAN_IMPLEMENTACION_ATOMICO.md) a partir de lo que la aplicación hace y de las decisiones del promotor ([CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md)).
> **Quién los valida:** el promotor (decisión 41). No son asesoramiento jurídico de un profesional colegiado.
> **Idioma:** castellano. El catalán y el inglés se traducen en la SESIÓN I1, con los textos ya congelados.
> **Dónde se publican:** el Sprint 5.10a los lleva a la consola (`/admin/ajustes`, textos legales versionados) y a sus páginas públicas. Hasta entonces, esta carpeta es la fuente.

## 1. Documentos

| Documento | Archivo | Versión | Estado | Quién lo acepta y cuándo |
| :--- | :--- | :-: | :--- | :--- |
| Aviso legal | [aviso-legal.md](aviso-legal.md) | 2026-11-18 | Borrador por validar | No se acepta: se publica |
| Condiciones de uso | [condiciones-generales.md](condiciones-generales.md) | 2026-11-18 | Borrador por validar | Familias y personas usuarias, con casilla al pagar una donación, y al crear una cuenta |
| Condiciones de entradas y vales | [condiciones-entradas-y-vales.md](condiciones-entradas-y-vales.md) | 2026-11-18 | Borrador por validar | Quien compra, con casilla al pagar |
| Condiciones de la aportación mensual | [condiciones-aportacion-mensual.md](condiciones-aportacion-mensual.md) | 2026-11-18 | Borrador por validar | Quien activa Mi Hucha, con casilla (apagada en el lanzamiento) |
| Condiciones para entidades | [condiciones-entidades.md](condiciones-entidades.md) | 2026-11-18 | Borrador por validar | La entidad, en el alta |
| Condiciones para comercios | [condiciones-comercios.md](condiciones-comercios.md) | 2026-11-18 | Borrador por validar | El comercio, con casilla, en cada pago y en cada renovación |
| Política de privacidad | [politica-de-privacidad.md](politica-de-privacidad.md) | 2026-11-18 | Borrador por validar | No se acepta: se informa |
| Política de cookies | [politica-de-cookies.md](politica-de-cookies.md) | 2026-11-18 | Borrador por validar | No se acepta: se informa |
| Primera capa de cada formulario | [primeras-capas.md](primeras-capas.md) | 2026-11-18 | Borrador por validar | Textos cortos de los formularios (van a los catálogos) |
| Contrato de encargo del tratamiento | `contrato-de-encargo.md` | — | **Segunda entrega de la T1** | La entidad, en el alta |
| Evaluación de impacto (modelo de la AEPD) | `evaluacion-de-impacto.md` | — | **Segunda entrega de la T1** | Documento interno |
| Tabla única de plazos de conservación | `tabla-de-plazos.md` | — | **Segunda entrega de la T1** | Documento interno; actualiza CUMPLIMIENTO §6 |

**Convenciones**

- La **versión** es la fecha de redacción (`AAAA-MM-DD`), el mismo formato que usa la consola. Al validarse un texto, su versión pasa a ser la fecha de la validación.
- El recuadro inicial de cada archivo (las líneas que empiezan por `>` antes de la primera raya) son notas internas: **no se publica**.
- Los textos son Markdown sin HTML, que es lo que admite la página pública.
- Los enlaces entre documentos apuntan a los archivos de esta carpeta; el Sprint 5.10a los cambia por las rutas públicas.

## 2. Datos que faltan y rellena el promotor (P14)

Aparecen entre dobles corchetes y salen del ajuste `platform.company` de la consola:

| Marca | Qué es | De dónde sale |
| :--- | :--- | :--- |
| `[[RAZÓN SOCIAL]]` | Denominación de la sociedad | `platform.company.legalName` |
| `[[NIF]]` | NIF de la sociedad | `platform.company.taxId` |
| `[[DOMICILIO SOCIAL]]` | Domicilio | `platform.company.address` |
| `[[EMAIL DE SOPORTE]]` | Buzón de ayuda | `platform.company.supportEmail` |
| `[[EMAIL DE PRIVACIDAD]]` | Buzón de privacidad | `platform.company.privacyEmail` |
| `[[DATOS REGISTRALES]]` | Registro Mercantil, tomo, folio y hoja | **No existe en la consola:** campo nuevo en el Sprint 5.10a |
| `[[DOMINIO]]` | Dirección del sitio | `NEXT_PUBLIC_APP_URL` |

## 3. Qué necesita el Sprint 5.10a para publicarlos

1. **Más tipos de documento.** La consola tiene hoy cuatro (`terminos`, `privacidad`, `cookies` y `aviso-legal`). Hacen falta nueve: los cuatro actuales (`terminos` pasa a ser las condiciones de uso), `condiciones-entidades`, `condiciones-comercios`, `condiciones-entradas-y-vales`, `condiciones-aportacion-mensual` y `contrato-de-encargo`. Cada uno con su versión, porque cada aceptación guarda la del texto que aceptó.
2. **Un campo nuevo** en `platform.company`: los datos registrales. No hay cláusula de sumisión a unos juzgados concretos: en condiciones generales no tendría efecto (LEC, art. 54.2).
3. **Sustitución de las marcas** `[[…]]` y de los enlaces entre documentos al pintar cada página.
4. **`privacy.policyVersion`** deja de valer `2026-11-01`: apuntará a la versión publicada de la política.
5. **La pantalla de acceso** (`/login`) lleva su línea de aceptación y su primera capa (primeras capas §11): al entrar por primera vez se crea la cuenta.

## 4. Lo que estos textos describen y el código todavía no hace

Los textos describen la plataforma **como saldrá a cobrar dinero real**, con las decisiones 21 a 54 ya aplicadas. Hasta que cada sprint se cierre, la aplicación hace lo anterior. Ningún texto se publica como definitivo mientras su fila siga abierta, y **el sprint que construye cada regla comprueba que el texto coincide con lo construido**.

| Qué dice el texto | Documento | Sprint que lo construye |
| :--- | :--- | :-: |
| No hay rifas | Todos | 5.12 |
| Entradas: se liquida por lo vendido; cancelación; cambio de fecha con 14 días | Entradas y vales §3; entidades §8 | 5.13 |
| Aviso al voluntario, plazo de las lecturas de portería (1 año) y «no reenvíes el enlace» | Privacidad §3.10 y §8; primeras capas §8 | 5.13 |
| Vales (todo el apartado), con la validez que fija la entidad y la cancelación antes y después de liquidar | Entradas y vales §4; entidades §9 | 5.14 |
| Quién vende entradas y vales (una empresa o una entidad sin ánimo de lucro), dentro de la ventana de resumen | Entradas y vales §1; primeras capas §2 | 5.15 |
| Páginas públicas, archivo de versiones, aceptación del alta, línea de la pantalla de acceso | Todos; primeras capas §4 y §11 | 5.10a |
| Rastros de seguridad a 12 meses y dentro de la copia de datos; texto de la supresión | Privacidad §8, §9 y §10 | 5.10b |
| Documento de identidad visible solo para quien lo sube, con aviso por email a la persona representante si lo sube otra; párrafo de la invitación; cookie del buzón con su plazo | Privacidad §3.9; primeras capas §4 y §5 | 5.10c |
| Casilla obligatoria y ventana de resumen en cada pago, versión guardada y resumen en el recibo | Primeras capas §1, §2, §3 y §7 | 5.15 (comercios, 5.16b) |
| Aportación voluntaria recuperable 14 días; Mi Hucha apagada, con condiciones propias y devolución de la gestión | Generales §5; aportación mensual | 5.15 |
| Comercios en dos modos, casilla, 14 días de moderación, ampliaciones, renovación doble, baja de los emails, datos que recibe la entidad (el contacto, en los dos modos), plazo del contacto (5 años si dona) | Comercios; entidades §10; privacidad §3.8 y §8 | 5.16 |
| Campaña vencida: 14 días y devolución automática; email con la fecha exacta; vínculo del voto | Generales §4.3; entidades §7.3 | 5.17 |
| Tarifas a 30 días y tarifa guardada; versión anterior de los textos de una campaña | Entidades §5.3 y §6.3 | 5.18 |
| Liquidación solo a la entidad, entrega automática y aviso de cada liberación con firma única | Entidades §4.2 y §7.2 | 5.19 |
| Contracargo de una campaña ya liquidada: revisión y decisión de KORUM, sin descuento automático | Entidades §7.4 | 5.19b |
| IVA incluido y facturas; una sola factura a la entidad por todo lo retenido, pasarela incluida | Generales §11; entidades §6.1; comercios §8 | 5.20 |
| Auto-Impulso siempre visible y compensado en el reparto | Generales §4.7; entidades §6.4 | 5.21 |
| Certificado al conseguirse la campaña (el de un comercio, desde el pago); colegios con ánimo de lucro con entradas, vales y patrocinio con publicidad, que entra en su Fondo de actividades | Generales §6; comercios §4 y §7; entidades §3, §10.4 y §12 | 5.22 |
| Retirada de una imagen en 72 horas; denuncia de una respuesta; aviso del formulario de soporte; plantillas orientativas | Entidades §5.1 y §11; aviso legal §4; primeras capas §6 | 5.24a |
| Estadísticas de visitas sin cookies | Privacidad §3.12; cookies §5 | 5.26 |

## 5. De dónde sale cada cláusula obligatoria de la ficha

| Cláusula (punto de CUMPLIMIENTO §9) | Dónde está |
| :--- | :--- |
| Firma única (`L-046`) | Entidades §4.2; primeras capas §9 |
| Tarifas a 30 días y baja libre y sin coste (`L-056`) | Entidades §2, §6.3 y §15 |
| El dinero de un comercio admitido no se devuelve (`L-076`) | Comercios §5.3 y §6; entidades §10.3 |
| KORUM no media si la entidad retira el anuncio (`L-091`) | Comercios §5.3; entidades §10.3 |
| Textos que escribe la entidad (`L-037`) | Entidades §5.1; comercios §5.2 |
| Cartel del escaparate (`L-038`) | Comercios §5.3; entidades §10.2 |
| Registro de accesos de KORUM como encargado (`L-065`) | Entidades §13; se desarrolla en el contrato de encargo (segunda entrega) |
| Destino del Fondo sin datos personales (`L-086`) | Entidades §10.4; contrato de encargo (segunda entrega) |
| Móviles personales en la portería y lectura sin conexión (`L-123`, `L-126`) | Entidades §8; privacidad §3.10; primeras capas §8 |
| Buzón de ideas: bases y anonimato (`L-006`) | Privacidad §3.4 |
| Rastros de seguridad (`L-063`) | Privacidad §3.11 |
| Reenvío del enlace de voto (`L-074`) | Privacidad §3.6; generales §4.4 |
| IndexNow (`L-075`) | Entidades §14 |
| Cámara de la portería (`L-127`) | Privacidad §3.10 |
| Obligaciones fiscales de la entidad | Entidades §12 |
| Mayoría de edad | Generales §2; privacidad §4 |
| Regla de los 14 días: aportación voluntaria | Generales §5 |
| Regla de los 14 días: gestión de Mi Hucha | Aportación mensual §6 |
| Regla de los 14 días: vales | Entradas y vales §4.4 |
| Regla de los 14 días: cambio de fecha | Entradas y vales §3.6 y §4.5 |
| Entradas sin desistimiento | Entradas y vales §3.3 |
| Reparto de papeles del §5.1 | Privacidad §2; entidades §13 |

## 6. Decisiones validadas por el promotor (2026-11-18)

Al escribir los textos salieron doce puntos que las decisiones del §8 de CUMPLIMIENTO no cubrían. El promotor los contestó el 2026-11-18 y sus respuestas están ya en los textos. Quedan anotadas como decisiones 48 a 54 en [CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md).

| # | Qué había que decidir | Qué decidió el promotor | Decisión | Dónde queda |
| :-: | :--- | :--- | :-: | :--- |
| 1 | La línea junto al botón de pago | **Casilla obligatoria** con la que se aceptan las condiciones y, al pulsar sobre ellas, una **ventana con su resumen**, bien explicado | 48 | Primeras capas §1, §2, §3 y §7 |
| 2 | Vales: la entidad cancela la venta después de haber cobrado | Antes de cerrar la venta devuelve la plataforma; después, la entidad asume lo que haga | 49 | Entradas y vales §4.5; entidades §9 |
| 3 | Vales: validez mínima | No hay mínimo: la validez la marca la entidad y es su responsabilidad | 49 | Entradas y vales §4.3; entidades §9 |
| 4 | Vales: pagos «sin producto» | No se devuelven, salvo que la entidad cancele la venta | 49 | Entradas y vales §4.6 |
| 5 | Avisar de que la entidad no es una empresa | Se explica dentro de la ventana de resumen, como condición de contexto | 48 | Entradas y vales §1; primeras capas §2 |
| 6 | Colegios con ánimo de lucro y comercios | Pueden recibir patrocinios con publicidad; el dinero va a la bolsa de la propia entidad (su Fondo de actividades) | 51 | Entidades §3 y §10.4; comercios §7 |
| 7 | Datos del comercio que recibe la entidad en el modo donación | También el contacto: persona, email, teléfono, dirección y página web, para ubicarlo, contactarlo y agradecérselo | 52 | Comercios §4 y §10; entidades §10.5; privacidad §3.8 |
| 8 | Cuánto se guarda el contacto de un comercio que dona | 5 años desde su última donación | 52 | Privacidad §8 |
| 9 | Contracargo de una campaña ya liquidada | No es automático: se abre una revisión con el banco y con la entidad, y lo aprueba el Super-Admin al terminar, porque puede haber engaño o fraude | 53 | Entidades §7.4 |
| 10 | Preaviso de los cambios en las condiciones de uso | A las familias no se les notifica; solo a las entidades | 54 | Generales §17; entidades §17 |
| 11 | Delegado de protección de datos | Conforme con la redacción propuesta: no se designa mientras no sea obligatorio | 54 | Privacidad §12 |
| 12 | El coste de la pasarela y el IVA | La entidad ve una sola factura de KORUM, por un importe y su IVA; KORUM separa por dentro lo que es para PAYCOMET, lo que es IVA y lo que es suyo | 50 | Entidades §6.1 |

**Cómo se ha llevado cada respuesta a los textos** (lo que el promotor puede querer comprobar):

- **Texto de la casilla (1).** Dice «He leído y acepto las condiciones», la misma fórmula que ya tenía la casilla de comercios, porque una casilla es una declaración en primera persona. La ventana se llama «Las condiciones, en resumen» y tiene dos bloques: «Lo que aceptas» y «Tus datos».
- **Quién vende (5).** La ventana de entradas y vales dice si el titular es una empresa (el titular de un colegio) o una entidad sin ánimo de lucro (el resto), a partir de la forma jurídica que la entidad ya declara en el alta. No hace falta una casilla nueva en el alta.
- **Familias sin aviso (10).** Las condiciones de uso ya no prometen ningún aviso: la versión nueva se publica con su fecha y se acepta con la casilla en cada pago. Se conservan dos avisos que no son de las condiciones de uso: el de la **aportación mensual** (30 días, porque es un cobro que se repite y no se puede cambiar sin avisar) y el de la **política de privacidad** cuando cambia algo importante en el uso de los datos, que exige la ley.
- **Contracargo (9).** El banco ejecuta el contracargo sin pedir permiso a KORUM: eso no se puede parar, solo discutir. Lo que queda a la espera de la aprobación del Super-Admin es **quién lo asume**: KORUM, o la entidad si hubo engaño o incumplimiento. Mientras tanto a la entidad no se le descuenta nada.
- **Pasarela (12).** Queda un cuadre de números para el Sprint 5.20a: si la línea de la pasarela lleva el IVA dentro y la meta no sube, KORUM ingresa por esa línea algo menos de lo que le cobra PAYCOMET (unos 17 € por cada 100 € de pasarela), salvo que PAYCOMET facture con un IVA que KORUM pueda deducir. Se le plantea al promotor al abrir ese sprint.

También van en el borrador, y quedan validados con la lectura del promotor: el punto de contacto del Reglamento europeo de Servicios Digitales en el aviso legal (obligatorio también para una microempresa), la retirada en 72 horas de una imagen con un menor reconocible (la hace la entidad y, si no, KORUM), los motivos por los que KORUM puede suspender a una entidad (entidades §15) y el límite de responsabilidad de KORUM frente a entidades (entidades §16).

## 7. Revisión de esta entrega

Revisada el 2026-11-18 por `korum-legal-fiscal-prereviewer` (tres pasadas: 36 hallazgos, 2 y 0) y por `korum-community-target-psychologist` (tres pasadas: 36 hallazgos, 10 y 0). Los dos terminan en **APROBADO**.

Tras la validación del promotor (el mismo día) los dos revisaron de nuevo solo los pasajes cambiados: el revisor legal, 12 hallazgos y después 0; el de comprensión, 4, después 1 y después 0. Los dos terminan otra vez en **APROBADO**. De esa revisión salen dos cosas para más adelante: comprobar en el Sprint 5.15 a qué grupo («empresa» o «entidad sin ánimo de lucro») va cada forma jurídica, y preguntar al promotor, al abrir el Sprint 5.14a, si el pago «sin producto» de los vales es una compra o una donación.
