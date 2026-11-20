# Textos legales de KORUM

> **Qué es esta carpeta:** los textos legales de la plataforma, escritos en la SESIÓN T1 del [plan](../PLAN_IMPLEMENTACION_ATOMICO.md) a partir de lo que la aplicación hace y de las decisiones del promotor ([CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md)).
> **Quién los valida:** el promotor (decisión 41). No son asesoramiento jurídico de un profesional colegiado.
> **Idioma:** castellano. El catalán y el inglés se traducen en la SESIÓN I1, con los textos ya congelados.
> **Dónde se publican:** el Sprint 5.10a los lleva a la consola (`/admin/ajustes`, textos legales versionados) y a sus páginas públicas. Hasta entonces, esta carpeta es la fuente.

## 1. Documentos

| Documento | Archivo | Versión | Estado | Quién lo acepta y cuándo |
| :--- | :--- | :-: | :--- | :--- |
| Aviso legal | [aviso-legal.md](aviso-legal.md) | 2026-11-18 | Validado por el promotor | No se acepta: se publica |
| Condiciones de uso | [condiciones-generales.md](condiciones-generales.md) | 2026-11-18 | Validado por el promotor | Familias y personas usuarias, con casilla al pagar una donación, y al crear una cuenta |
| Condiciones de entradas y vales | [condiciones-entradas-y-vales.md](condiciones-entradas-y-vales.md) | 2026-11-19 | Validado por el promotor (el añadido del 3.6, el 2026-11-19) | Quien compra, con casilla al pagar |
| Condiciones de la aportación mensual | [condiciones-aportacion-mensual.md](condiciones-aportacion-mensual.md) | 2026-11-18 | Validado por el promotor | Quien activa Mi Hucha, con casilla (apagada en el lanzamiento) |
| Condiciones para entidades | [condiciones-entidades.md](condiciones-entidades.md) | 2026-11-19 | Validado por el promotor (el cargo por cancelación, decisión 63, el 2026-11-19) | La entidad, en el alta |
| Condiciones para comercios | [condiciones-comercios.md](condiciones-comercios.md) | 2026-11-18 | Validado por el promotor | El comercio, con casilla, en cada pago y en cada renovación |
| Política de privacidad | [politica-de-privacidad.md](politica-de-privacidad.md) | 2026-11-18 | Validado por el promotor | No se acepta: se informa |
| Política de cookies | [politica-de-cookies.md](politica-de-cookies.md) | 2026-11-18 | Validado por el promotor | No se acepta: se informa |
| Primera capa de cada formulario | [primeras-capas.md](primeras-capas.md) | 2026-11-18 | Validado por el promotor | Textos cortos de los formularios (van a los catálogos) |
| Contrato de encargo del tratamiento | [contrato-de-encargo.md](contrato-de-encargo.md) | 2026-11-18 | Validado por el promotor | La entidad, en el alta |
| Evaluación de impacto (modelo de la AEPD) | [evaluacion-de-impacto.md](evaluacion-de-impacto.md) | 2026-11-18 | Validado por el promotor | No se acepta ni se publica: documento interno |
| Tabla única de plazos de conservación | [tabla-de-plazos.md](tabla-de-plazos.md) | 2026-11-18 | Validado por el promotor | No se acepta ni se publica: documento interno. Manda sobre CUMPLIMIENTO §6 y sobre la política de privacidad §8 |
| Registro de actividades de tratamiento (RGPD, art. 30) | [registro-de-actividades.md](registro-de-actividades.md) | 2026-11-18 | Validado por el promotor | No se acepta ni se publica: documento interno |

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

Los textos describen la plataforma **como saldrá a cobrar dinero real**, con las decisiones 21 a 65 ya aplicadas. Hasta que cada sprint se cierre, la aplicación hace lo anterior. Ningún texto se publica como definitivo mientras su fila siga abierta, y **el sprint que construye cada regla comprueba que el texto coincide con lo construido**.

| Qué dice el texto | Documento | Sprint que lo construye |
| :--- | :--- | :-: |
| No hay rifas | Todos | 5.12a y 5.12b (hecho: retiradas) |
| Entradas: se liquida por lo vendido; cancelación; cambio de fecha con 14 días | Entradas y vales §3; entidades §8 | 5.13 (hecho) |
| Aviso al voluntario, plazo de las lecturas de portería (1 año) y «no reenvíes el enlace» | Privacidad §3.10 y §8; primeras capas §8 | 5.13 (hecho) |
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
| Contrato de encargo publicado con sus anexos y aceptado en el alta; aviso automático de 30 días al cambiar las condiciones para entidades, el contrato o la lista de proveedores | Contrato de encargo §1, §10 y §17; entidades §17 | 5.10a |
| Plazos nuevos: descripción de las ideas y respuestas de la entidad, solicitudes de derechos, altas sin verificar, alertas y tareas; auditoría, relevos, quién lanzó una votación y aportaciones desvinculados de la cuenta a los 6 años; todos los plazos reunidos en un archivo del código | Tabla de plazos §3.1, §3.3, §3.4, §3.9, §3.10 y §4 | 5.10b |
| Compromiso de confidencialidad y revisión semestral de los accesos a la consola; las búsquedas de la consola que cruzan varias entidades anotan de qué entidad son | Contrato de encargo §7 y §8; tabla de plazos §3.10 | 5.10c |
| Baja de la entidad con una sola firma: 30 días para descargar sus datos, cierre del acceso y borrado de lo que no tiene plazo legal. Suspensión por KORUM: la entidad consulta su panel, pero no publica, cambia, firma ni mueve dinero hasta que KORUM levanta la suspensión; cierre con 30 días de aviso | Contrato de encargo §3 y §14; entidades §2 y §15; comercios §5.3; tabla de plazos §3.9 | 5.10d |
| Canjes de vales borrados al año de la liquidación | Tabla de plazos §3.6 | 5.14c |
| El voto sigue unido a la aportación mientras esta se conserve | Privacidad §8; tabla de plazos §3.7 | 5.17 |
| Email general de la entidad (campo nuevo), al que se avisa de la baja y de cada liberación con firma única | Contrato de encargo §17; entidades §4.2 y §15.1 | 5.10d (lo crea y avisa de la baja) y 5.19 (aviso de cada liberación) |
| Destinatario de las facturas de KORUM vaciado a los 6 años | Tabla de plazos §3.1 | 5.20b |
| Contrato de encargo aceptado con cada proveedor (también el de estadísticas y el de facturación) y sus datos en el Anexo III; copias de seguridad y registros con plazo | Contrato de encargo §10 y Anexo III; tabla de plazos §3.14; registro de actividades §1 | 6.1a y 6.1b |
| Procedimientos escritos: brecha de seguridad (48 horas a la entidad, aviso a la Agencia en su nombre y aviso a las personas afectadas), solicitud de derechos fuera de *Mi cuenta*, entrega de la lista de accesos (30 días) y supresiones que se repiten tras restaurar una copia | Contrato de encargo §8, §11 y §12; tabla de plazos §3.14 | 6.1c |
| Prueba de intrusión externa | Contrato de encargo, Anexo II; evaluación de impacto §9.1 | 6.1e |
| Opinión de las personas afectadas: las personas firmantes, antes del primer cobro real; las familias, durante el piloto | Evaluación de impacto §10.3 | 6.2 |

## 5. De dónde sale cada cláusula obligatoria de la ficha

| Cláusula (punto de CUMPLIMIENTO §9) | Dónde está |
| :--- | :--- |
| Firma única (`L-046`) | Entidades §4.2; primeras capas §9 |
| Tarifas a 30 días y baja libre y sin coste (`L-056`) | Entidades §2, §6.3 y §15 |
| El dinero de un comercio admitido no se devuelve (`L-076`) | Comercios §5.3 y §6; entidades §10.3 |
| KORUM no media si la entidad retira el anuncio (`L-091`) | Comercios §5.3; entidades §10.3 |
| Textos que escribe la entidad (`L-037`) | Entidades §5.1; comercios §5.2 |
| Cartel del escaparate (`L-038`) | Comercios §5.3; entidades §10.2 |
| Registro de accesos de KORUM como encargado (`L-065`) | Entidades §13; contrato de encargo §7 y §8 |
| Destino del Fondo sin datos personales (`L-086`) | Entidades §10.4; contrato de encargo §5 |
| Móviles personales en la portería y lectura sin conexión (`L-123`, `L-126`) | Entidades §8; privacidad §3.10; primeras capas §8; contrato de encargo §5.1 |
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

Tras la validación del promotor (el mismo día) los dos revisaron de nuevo solo los pasajes cambiados: el revisor legal, 12 hallazgos y después 0; el de comprensión, 4, después 1 y después 0. Los dos terminan otra vez en **APROBADO**. De esa revisión salen dos cosas para más adelante: comprobar en el Sprint 5.15 a qué grupo («empresa» o «entidad sin ánimo de lucro») va cada forma jurídica, y preguntar al promotor, al abrir el Sprint 5.14a, si el pago «sin producto» de los vales es una compra o una donación. **Respondido el 2026-11-19 (decisiones 64 y 65):** es una aportación sin certificado, y no se ofrece a los colegios con ánimo de lucro; condiciones de entradas y vales §4.6 al día.

**Segunda entrega (2026-11-18).** Los cuatro documentos (contrato de encargo, evaluación de impacto, tabla de plazos y registro de actividades) y los pasajes tocados de la primera entrega los revisaron los mismos dos agentes, cada uno en su contexto. `korum-legal-fiscal-prereviewer`: cuatro pasadas y una confirmación (39 hallazgos, 13, 3 y 0). `korum-community-target-psychologist`: seis pasadas (45 hallazgos, 15, 19, 6, 3 y 0). Los dos terminan en **APROBADO**, sin ningún hallazgo pendiente. De la revisión legal salieron el registro de actividades, que no estaba previsto, y cinco de los puntos que valida el promotor (§8.3, §8.5, §8.6, §8.7 y §8.10).

**Tras la validación del promotor de la segunda entrega (2026-11-18)** los dos revisaron solo los pasajes cambiados: la baja con una firma, la suspensión por el Super-Admin (condiciones para entidades §15, que pasa a tener tres apartados) y las decisiones 55 a 62. `korum-legal-fiscal-prereviewer`: tres pasadas y una confirmación (13 hallazgos, 5 y 0). `korum-community-target-psychologist`: cuatro pasadas (8 hallazgos, 3, 1 y 0). Los dos terminan en **APROBADO**, sin ningún hallazgo pendiente. De esta revisión salen los tres matices de la suspensión que el promotor puede cambiar (§8.1), la frase nueva de las condiciones para comercios §5.3 y el título del aviso legal §4.2.

## 8. Segunda entrega (2026-11-18): decisiones validadas por el promotor

Los documentos de la segunda entrega son el [contrato de encargo](contrato-de-encargo.md), la [evaluación de impacto](evaluacion-de-impacto.md), la [tabla única de plazos](tabla-de-plazos.md) y el [registro de actividades de tratamiento](registro-de-actividades.md). Al escribirlos y revisarlos salieron nueve puntos que ninguna decisión anterior cubría (8.1 a 8.9), más dos apartados informativos (8.10 y 8.11).

**El promotor los contestó el 2026-11-18.** Aprobó siete como estaban (8.2, 8.3, 8.4, 8.6, 8.7, 8.8 y 8.9), cambió el 8.1 (basta una firma, y añade la suspensión por el Super-Admin) y puso una condición al 8.5 (solo lo que la ley obliga). Sus respuestas están ya en los textos y quedan anotadas como **decisiones 55 a 62** en [CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md). Cada apartado conserva cómo se le planteó y termina con lo que decidió.

### 8.1 La aplicación no tiene baja de la entidad

- **Qué pasa hoy:** las condiciones dicen «podéis dejar KORUM cuando queráis y sin coste», pero en la aplicación no existe ningún botón ni proceso para dar de baja a una entidad.
- **Ejemplo:** el AMPA de un colegio cambia de junta y decide dejar KORUM. Hoy solo podría escribir a soporte, y nadie tiene un procedimiento para cerrar su página, entregarle sus datos y borrar el resto.
- **Opciones:** (a) baja desde el panel, con las firmas de su modo de firma y sin el Super-Admin, en una entrega nueva (Sprint 5.10d, 4–6 h); (b) meterla en el Sprint 5.10c, que ya va cargado; (c) baja a mano por el Super-Admin cuando alguien la pida.
- **Recomendación:** (a). Es coherente con que la entidad se gestiona sola, y sin baja no se pueden devolver ni suprimir los datos al terminar el servicio, como exige la ley (RGPD, art. 28.3.g). Queda anotado como N22 en el registro, con su ficha en el plan y el criterio `QA-LEG08`.
- **Decidido por el promotor (decisión 55):** (a), con un cambio que sustituye lo que decía esa opción: **basta una firma**, sea cual sea el modo de firma de la entidad. La baja la pide desde el panel cualquiera de las personas firmantes, sin el Super-Admin; se avisa por email a la otra persona firmante, si la hay, y al email general de la entidad, y queda en la auditoría.
- **Añadido por el promotor (decisión 56): suspensión por el Super-Admin.** Desde su consola, el Super-Admin puede suspender la actividad de una entidad por uso fraudulento de la plataforma o por usarla para algo contrario a la ley, a las normas o a la ética. Mientras dura, la entidad entra en su panel y lo consulta todo, pero no puede publicar, cambiar, firmar ni mover dinero. El Super-Admin puede levantar la suspensión en cualquier momento. Está en las condiciones para entidades §15.2 y se construye en el mismo Sprint 5.10d, que pasa de 4–6 h a 5–7 h.
- **Lo que ya estaba en las condiciones y se conserva** (validado con la primera entrega): KORUM también puede suspender una sola campaña, y hay tres motivos más: documentos del titular incorrectos, incumplimiento grave de las condiciones y exigencia de PAYCOMET o de una autoridad.
- **Tres matices que añadió la revisión legal al texto, comunicados al promotor al cerrar la sesión; puede cambiarlos:**
  1. *Lo imprescindible sigue abierto.* Una entidad suspendida sigue respondiendo de los datos de su comunidad y tiene que poder corregir la causa. Por eso conserva lo mínimo: descargar sus datos, retirar contenidos, atender peticiones de derechos, subir documentos, relevar a quien firma y pedir la baja. Todo lo demás queda parado.
  2. *«La ética» se concreta en una lista cerrada:* publicar contenidos ofensivos, discriminatorios, violentos o que inciten al odio; usar la plataforma para fines ajenos a los de la entidad; y engañar a las familias sobre el destino del dinero. Un motivo abierto dejaría la suspensión al criterio de KORUM y podría no ser válido (Reglamento de Servicios Digitales, art. 14; Código Civil, art. 1256).
  3. *El aviso y el cierre.* La suspensión se comunica por email en el momento, con el motivo, los hechos y la forma de pedir la revisión. Si la causa no se corrige y KORUM cierra la entidad, avisa 30 días antes, salvo fraude, incumplimientos graves repetidos o exigencia de una ley o de una autoridad (Reglamento de Servicios Digitales, art. 17, para el aviso; Reglamento (UE) 2019/1150, art. 4, para el preaviso del cierre, aplicable al menos a los colegios con ánimo de lucro).
- **Tres detalles que se le plantean al abrir el Sprint 5.10d:** si la página pública y las campañas en marcha de una entidad suspendida siguen visibles y admitiendo aportaciones; qué pasa con el dinero retenido si la suspensión se alarga; y si una baja pedida con una sola firma se puede anular antes de que empiecen a contar los 30 días.

### 8.2 Cuánto tiempo tiene la entidad para llevarse sus datos al irse

- **Qué pasa hoy:** no está definido.
- **Ejemplo:** el club se da de baja el 1 de junio. ¿Hasta cuándo puede descargar el registro de actividad, los expedientes, los datos fiscales de sus donantes y sus facturas?
- **Opciones:** 30 días; 60 días; 90 días.
- **Recomendación:** 30 días. Es suficiente para descargar, y cuanto antes se cierra, antes se borran los datos de las familias que ya no hacen falta. De lo que la entidad está obligada a conservar, KORUM guarda además una copia bloqueada hasta que vence su plazo, por si la pierde.
- **Decidido por el promotor (decisión 55):** 30 días, que cuentan desde que termina lo último que la entidad tenía en marcha.

### 8.3 Brechas de seguridad: cuándo avisa KORUM y quién avisa a la Agencia

- **Qué pasa hoy:** no está definido. La ley dice que KORUM avisa a la entidad «sin dilación indebida» y que la entidad avisa a la Agencia Española de Protección de Datos en 72 horas.
- **Ejemplo:** KORUM descubre un martes que alguien ha podido ver las consultas de las familias de 160 entidades. Si cada entidad presenta su aviso, salen 160 avisos del mismo incidente, escritos por personas voluntarias.
- **Opciones para el aviso a la entidad:** 24, 48 o 72 horas.
- **Opciones para el aviso a la Agencia:** (a) cada entidad presenta el suyo, con el texto que le prepara KORUM; (b) la entidad autoriza en el contrato a KORUM para presentarlo en su nombre, con copia, salvo que diga que prefiere hacerlo ella; (c) solo KORUM, sin opción.
- **Recomendación:** 48 horas y (b). Da tiempo a saber qué ha pasado, evita avisos duplicados y la entidad no pierde el control. El aviso a las personas afectadas, cuando la ley lo pide, lo envía KORUM, porque es la única que tiene sus emails.
- **Decidido por el promotor (decisión 57):** 48 horas y (b).

### 8.4 Qué pasa si KORUM cambia de proveedor

- **Qué pasa hoy:** no está definido.
- **Ejemplo:** KORUM cambia de proveedor de emails: el nuevo recibirá los emails de las familias de sus 160 entidades. ¿Hay que pedir permiso a cada entidad, o basta con avisarlas?
- **Opciones:** (a) aviso por email 30 días antes y, si la entidad no está de acuerdo, puede irse sin coste; (b) pedir permiso a cada entidad antes de cada cambio.
- **Recomendación:** (a), con una excepción para las urgencias (un proveedor que cierra o que tiene un problema de seguridad): se avisa en cuanto se produce. Es el mismo plazo que ya vale para los cambios de condiciones y de tarifas (decisiones 34 y 54).
- **Decidido por el promotor (decisión 58):** (a), con la excepción de las urgencias.

### 8.5 Auditorías de una entidad a KORUM

- **Qué pasa hoy:** no está definido. La ley obliga a KORUM a permitirlas, incluidas las inspecciones; se pueden organizar con reglas, pero no prohibir.
- **Ejemplo:** el titular de un colegio grande quiere comprobar que KORUM cumple, sin que haya pasado nada.
- **Opciones:** (a) una vez al año (y siempre que haya una brecha o lo pida una autoridad): primero un cuestionario, que KORUM contesta en 30 días con su documentación; si no basta, una inspección acordada con 30 días de antelación, pagada por la entidad salvo que descubra un incumplimiento de KORUM; (b) inspección siempre que la pidan, sin límite.
- **Recomendación:** (a). Cumple la ley y es manejable para una microempresa con cientos de entidades.
- **Decidido por el promotor (decisión 59):** (a), **solo porque la ley lo exige**; si las entidades no tuvieran ese derecho, no se les daría. Comprobado: lo tienen. El RGPD (art. 28.3.h) obliga a que el contrato permita al responsable hacer auditorías, «incluidas inspecciones», por sí mismo o por un auditor que él elija. La cláusula 13 del contrato no concede nada más que eso y ordena lo que la ley deja abierto: una vez al año, cuestionario primero, inspección solo si no basta y gastos a cargo de la entidad, salvo que la inspección descubra un incumplimiento de KORUM.

### 8.6 De quién son los datos de las personas firmantes

- **Qué pasa hoy:** el reparto aprobado el 2026-11-17 dice que los datos de quienes firman son de la entidad. Pero KORUM usa su email para cosas propias: avisarles de un cambio de tarifas, de condiciones o de proveedor, y enviarles las facturas.
- **Ejemplo:** KORUM avisa a la tesorera de un club de que cambian las tarifas. Ese aviso es de KORUM, no un encargo del club.
- **Opciones:** (a) repartirlos: la entidad responde de quién firma por ella (cargos, invitaciones, relevos y firmas) y KORUM, de los datos de contacto que usa para su relación con la entidad; (b) dejarlos todos en la entidad y quitar del contrato «KORUM no los usa para fines propios».
- **Recomendación:** (a). La (b) no sería verdad. Cambia una frase de la política de privacidad (§2.2 y §3.9) y de las condiciones para entidades (§13).
- **Decidido por el promotor (decisión 60):** (a).

### 8.7 Lo que sigue unido a una cuenta pasados 6 años

- **Qué pasa hoy:** a los 6 años se quitan los emails de una aportación, pero si se hizo con una cuenta, sigue unida a esa cuenta mientras exista.
- **Ejemplo:** una familia que sigue usando KORUM ve en *Mi cuenta* una donación de hace 8 años.
- **Opciones:** (a) dejarlo así y decirlo («es tu historial»); (b) a los 6 años, separar de la cuenta lo que se puede cambiar (las aportaciones, el historial de relevos, quién lanzó una votación y el registro de auditoría). Se queda unido a la cuenta solo lo que no admite cambios (los apuntes contables, las firmas y quién pidió una liquidación) y la aportación mensual, que es el historial de la persona. Todo ello queda sin nadie detrás cuando la cuenta se suprime.
- **Recomendación:** (b). Es lo que ya promete la política de privacidad («después se conservan los importes y las fechas, sin nada que te identifique»). Se construye en el Sprint 5.10b.
- **Decidido por el promotor (decisión 61):** (b).

### 8.8 Los plazos que son nuevos

La [tabla de plazos §6.1](tabla-de-plazos.md) marca con «Decidir: propuesta nueva» los que no estaban decididos:

| Dato | Qué pasa hoy | Propuesta |
| :--- | :--- | :--- |
| Alta que nunca verificó su email | Se trata como una cuenta sin actividad (3 años) | 7 días |
| Descripción de una idea | Se conserva sin plazo | Se vacía al año del fin de la idea. El título y el número de firmas se conservan como historial |
| Respuestas de la entidad en la conversación de una idea | Se conservan sin plazo | Se borran al año, con los mensajes de la familia |
| Solicitudes de derechos | Se conservan sin plazo | 3 años desde que se cierran |
| Alertas de operación y tareas del sistema | Se conservan sin plazo | 12 meses desde que se resuelven o terminan |
| Registro de auditoría e historial de relevos | Se conservan sin plazo | A los 6 años se desvinculan de la cuenta; la anotación se conserva |
| Destinatario de las facturas de KORUM | Se conserva sin plazo | A los 6 años se vacían el nombre y el NIF |
| Copias de seguridad y registros del alojamiento | Sin configurar | 30 días como máximo |

**Recomendación:** aprobarlos como están. Todos siguen las cinco reglas de la tabla y cada uno tiene sprint.

**Decidido por el promotor (decisión 61):** aprobados como están.

### 8.9 La evaluación de impacto

- **Conclusión que se valida:** favorable, con la condición de que las 19 medidas de su plan de acción estén hechas antes de cobrar dinero real. De los 19 riesgos analizados ninguno queda alto, así que no hace falta consultar antes a la Agencia.
- **Opinión de las personas afectadas:** la ley pide recabarla «cuando proceda». Hoy no hay personas usuarias reales. Opciones: (a) recogerla con un cuestionario breve: a las personas firmantes de las tres entidades piloto durante su alta, antes del primer cobro real, y a una muestra de familias durante el piloto; (b) no recogerla. **Recomendación:** (a).
- **Revisión:** una vez al año, antes de encender Mi Hucha y cuando cambie quién ve qué.
- **Decidido por el promotor (decisión 62):** conclusión aceptada y opción (a) para la opinión de las personas afectadas.

### 8.10 El registro de actividades de tratamiento

La ley obliga a tener por escrito la lista de todo lo que se hace con datos personales (RGPD, art. 30), y el contrato de encargo se compromete a llevarla. No existía. Está escrita en esta entrega, a partir de la evaluación de impacto y de la tabla de plazos. El promotor lo validó el 2026-11-18, junto con la evaluación de impacto (decisión 62).

### 8.11 Frases de la primera entrega que se han ajustado

Para que coincidan con el contrato, con la tabla de plazos y con lo que hace el código:

- **Política de privacidad §2.2 y §3.9.** La entidad responde de «quién firma por ella» (punto 8.6). La base legal de los datos de las personas firmantes y de la documentación del titular pasa a ser el interés legítimo: quien firma no es parte del contrato, lo es la entidad, y la obligación de identificar al titular es de PAYCOMET, no de KORUM.
- **Política de privacidad §8.** El voto sigue unido a la aportación mientras esta se conserve (así lo decidió el promotor, `L-112`); la frase anterior daba a entender que quedaba anónimo al año. La huella del navegador se conserva hasta 12 meses después de la última vez que se usa el dispositivo en el buzón, que es lo que hace el código.
- **Política de cookies §5.** La misma precisión sobre la huella del navegador.
- **Condiciones para entidades §13 y §15.** La lista de accesos del equipo de KORUM se entrega en 30 días; la lista de datos de los que responde la entidad coincide con la del contrato; al irse, la entidad tiene 30 días para descargar sus datos; y si una suspensión no se corrige, KORUM puede cerrar la entidad con las mismas reglas que una baja. Tras la validación del promotor, el §15 se reparte en tres apartados (baja, suspensión y datos al irse) y recoge las decisiones 55 y 56.
- **Condiciones para comercios §5.3.** Una frase nueva: si la entidad se da de baja o KORUM la suspende o la cierra, el anuncio del comercio puede dejar de verse y KORUM no devuelve nada ni media. Es lo que ya decía la decisión 26 para la retirada del anuncio (`L-091`).
- **Aviso legal §4.2.** Su título pasa a ser «Si retiramos un contenido o suspendemos una cuenta», que es lo que ya decía su texto: las condiciones para entidades §15.2 remiten a él.
