# Evaluación de impacto en la protección de datos

> **Documento:** `evaluacion-de-impacto` (interno) · **Versión:** 2026-11-18 · **Estado:** VALIDADO por el promotor (2026-11-18) · **Idioma:** castellano
> **Qué es:** el análisis de qué puede salir mal con los datos personales en KORUM, qué se hace para evitarlo y qué riesgo queda. La exige el artículo 35 del Reglamento General de Protección de Datos (RGPD) cuando un tratamiento puede suponer un riesgo alto.
> **Modelo seguido:** el *Modelo de informe de evaluación de impacto para el sector privado* de la Agencia Española de Protección de Datos (AEPD), con sus diez apartados, y la matriz de riesgo de su *Guía de gestión del riesgo y evaluación de impacto en tratamientos de datos personales* (2021).
> **Quién la valida:** el promotor (decisión 41). No se publica. Se entrega a la AEPD si la pide, y a una entidad la información que necesite de ella según su [contrato de encargo](contrato-de-encargo.md).
> **Qué evalúa:** la plataforma tal como saldrá a cobrar dinero real, con las decisiones 21 a 62 de [CUMPLIMIENTO §8](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) aplicadas. Lo que todavía no está construido figura en el plan de acción (apartado 9) con su sprint.

---

## Resumen

- **Qué se evalúa:** todos los tratamientos de datos personales de la plataforma KORUM.
- **Por qué se hace:** la AEPD pide esta evaluación cuando se dan dos o más circunstancias de una lista de once. En KORUM se da con claridad una (se reconoce el dispositivo de quien firma una idea, para evitar el fraude en las votaciones) y otras tres en parte. Si el plan de crecimiento se cumple, se dará una más (muchas personas). En caso de duda, la AEPD aconseja hacerla (apartado 5).
- **Riesgos analizados:** 19. Antes de aplicar medidas, 4 son muy altos, 11 altos, 3 medios y 1 bajo.
- **Resultado con las medidas:** ningún riesgo queda alto. Quedan 7 en nivel medio y 12 en nivel bajo.
- **Conclusión:** la evaluación es **favorable, con una condición**. Quiere decir que el riesgo que queda se puede asumir, siempre que todas las medidas del apartado 9.1 estén hechas antes de cobrar dinero real, salvo la opinión de las familias, que se recoge durante el piloto. No es un permiso de la AEPD: es el análisis propio de KORUM, que valida el promotor.
- **Qué falta:** 19 medidas, todas con su sprint, y recoger la opinión de las personas afectadas. Las más importantes: la revisión de seguridad externa (Sprint 6.1e), el usuario de base de datos con los permisos justos y las copias de seguridad probadas (6.1a), los plazos automáticos que faltan (5.10b), la baja de una entidad (5.10d) y la retirada de imágenes en 72 horas (5.24a). Solo dos necesitan a alguien de fuera: la revisión externa y los contratos con los proveedores.
- **No hace falta consultar antes a la AEPD** (RGPD, art. 36), porque no queda ningún riesgo alto.
- **Lo que más protege a las personas:** se pide lo mínimo; de los menores no se guarda nada que los identifique; la entidad no ve quién aporta ni cuánto (salvo los datos de quien le pide certificado fiscal y los de los comercios que la apoyan); lo sensible va cifrado; y cada dato tiene un plazo.

### Palabras que se usan aquí

| Palabra | Qué quiere decir |
| :--- | :--- |
| **Tratamiento** | Cualquier cosa que se haga con datos personales: recogerlos, guardarlos, consultarlos, enviarlos o borrarlos |
| **Responsable** | Quien decide para qué se usan unos datos y responde de ellos |
| **Encargado** | Quien trata unos datos por cuenta del responsable, sin decidir sobre ellos |
| **Interés legítimo** | Una de las razones que la ley admite para usar datos sin pedir permiso. Vale si el interés de quien los usa pesa más que el perjuicio para la persona; por eso se pondera en el apartado 2.2 |
| **Código seudónimo** | Un código calculado con una clave secreta, que por sí solo no dice de quién es |
| **Código seudónimo de la conexión** | El que se calcula a partir de la red desde la que se conecta una persona. Sustituye a la dirección IP, que KORUM no guarda en su base de datos |
| **Huella del navegador** | Un código seudónimo calculado con datos técnicos del navegador (idioma, pantalla, zona horaria). Reconoce el dispositivo aunque se borren las cookies. Solo se usa con permiso |
| **Comprobación de acceso** | La que hace el servidor antes de enseñar datos de una entidad: mira quién eres y de qué entidad eres según tu sesión, sin fiarse de lo que envía el navegador |
| **Libro mayor** | El registro contable de cada movimiento de dinero. No admite cambios ni borrados |
| **Registro de auditoría** | La lista de quién hizo qué y cuándo en lo que mueve dinero o lleva firma. Tampoco admite cambios. El «registro de actividad» del panel de una entidad es la parte que le corresponde |
| **Rastros de seguridad** | Los intentos fallidos de entrar y los accesos denegados, que se guardan para proteger las cuentas |
| **Cadena de huellas** | Cada anotación del registro lleva una marca calculada con la anterior. Si alguien altera una, la cadena se rompe y se nota |
| **Conciliación diaria** | La comprobación, cada día, de que lo que KORUM dice que se ha cobrado coincide con lo que dice PAYCOMET |
| **Indexar** | Que un buscador guarde una página para enseñarla en sus resultados |
| **Datos ocultos de una imagen** | La fecha, el lugar y el dispositivo que una foto lleva dentro sin que se vean (sus metadatos) |
| **Prueba de intrusión** | Un experto intenta entrar en la plataforma como lo haría un atacante, para encontrar fallos |
| **Brecha de seguridad** | Cualquier incidente en el que alguien ve, pierde o cambia datos personales sin permiso |

## 1. Descripción del tratamiento

### 1.1 Datos del informe

| Dato | Valor |
| :--- | :--- |
| **Fecha** | 18 de noviembre de 2026 |
| **Responsable** | [[RAZÓN SOCIAL]], NIF [[NIF]], [[DOMICILIO SOCIAL]] («KORUM») |
| **Contacto de privacidad** | [[EMAIL DE PRIVACIDAD]] |
| **Delegado de protección de datos** | No designado: KORUM no está obligada (decisión 54) |
| **Momento** | Antes de empezar a tratar datos reales. Hasta hoy la plataforma solo ha funcionado con datos de demostración |

### 1.2 Qué es KORUM

KORUM es una plataforma con la que un AMPA o AFA, el titular de un colegio, un club deportivo o una entidad cultural:

- recoge las **ideas** de su comunidad y las somete a firmas;
- publica **campañas** «todo o nada» para pagar un proyecto;
- vende **entradas y vales** con código QR y controla el acceso con el móvil;
- recibe el apoyo de los **comercios** de su entorno;
- emite **certificados fiscales** de donación, si está acogida a la Ley 49/2002.

KORUM es una plataforma tecnológica. Los cobros, la retención del dinero, los repartos y las devoluciones los ejecuta PAYCOMET, entidad de pago autorizada por el Banco de España.

### 1.3 Los tratamientos

| # | Tratamiento | Quién es responsable | Para qué |
| :-: | :--- | :--- | :--- |
| T1 | Cuentas y acceso | KORUM | Identificar a la persona y darle acceso a lo suyo |
| T2 | Aportaciones, compras y devoluciones | KORUM | Registrar el pago, enviar el recibo o la entrada y devolver el dinero si procede |
| T3 | Prevención del fraude y seguridad | KORUM | Que cada familia firme una vez; detectar abusos; proteger las cuentas |
| T4 | Facturación de KORUM | KORUM | Emitir sus facturas y registrarlas ante la Agencia Tributaria |
| T5 | Soporte de KORUM y solicitudes de derechos | KORUM | Contestar y atender los derechos de las personas |
| T6 | Comprobación de cada entidad (documentación del titular) y relación con sus personas firmantes | KORUM | Saber que la entidad existe y puede recibir pagos; avisar a quienes firman de lo que requiere su firma, de los cambios del servicio y de las facturas |
| T7 | Aportación mensual (Mi Hucha), apagada en el lanzamiento | KORUM | Cobrar cada mes la donación que la persona programa |
| T8 | Buzón de ideas: moderación y conversación | La entidad (KORUM, encargado) | Escuchar a su comunidad |
| T9 | Consultas de las familias a la entidad | La entidad (KORUM, encargado) | Contestar dudas sobre una campaña o un evento |
| T10 | Certificados fiscales y Modelo 182 | La entidad (KORUM, encargado) | Cumplir la Ley 49/2002 |
| T11 | Cargos de las personas firmantes (quién firma, invitaciones y relevos), voluntarios y portería | La entidad (KORUM, encargado) | Gestionar la entidad y controlar el acceso a sus eventos |
| T12 | Imágenes y textos publicados | La entidad (KORUM, encargado) | Dar a conocer sus campañas y sus logros |
| T13 | Relación con los comercios | KORUM (su pago, sus facturas y su contacto) y la entidad (lo que hace con los datos que recibe, y su publicidad) | Recibir su apoyo y agradecérselo |
| T14 | Estadísticas de visitas | KORUM | Saber cuánto se usa la web, sin identificar a nadie |
| T15 | Equipo de KORUM | KORUM | Dar acceso a la consola y registrar lo que hace cada persona |
| T16 | Mensajes enviados en nombre de la entidad | La entidad (KORUM, encargado) | Hacer llegar a familias y comercios lo que la entidad les escribe, sin que vea su email |

### 1.4 De quién son los datos y qué datos son

| Personas | Datos |
| :--- | :--- |
| Familias, socios y vecinos que aportan o compran | Email; importe, fecha y medio de pago (sin sus números); curso, equipo o grupo elegido (opcional); el código seudónimo de la conexión; la versión de las condiciones que aceptan |
| Quien pide certificado fiscal | NIF, nombre y apellidos, provincia |
| Quien crea una cuenta | Nombre, email, idioma, sesiones |
| Quien propone o firma una idea | Email (no se muestra), textos, la cookie del dispositivo, el código seudónimo de la conexión y, solo con su consentimiento, la huella del navegador |
| Personas firmantes de una entidad | Nombre, email, teléfono, cargo; y de quien la representa, su documento de identidad |
| Voluntarios de portería | El nombre que dan a su móvil (no tiene por qué ser el suyo) y el código seudónimo de la conexión |
| Personas de contacto de los comercios, y comercios que son autónomos | Nombre, teléfono, email, dirección; NIF y domicilio fiscal |
| Equipo de KORUM | Nombre, email y registro de sus accesos |

**No se tratan** categorías especiales de datos (salud, creencias, origen, orientación) ni datos de condenas.

**De los menores no se trata ningún dato que los identifique.** Solo consta el curso, equipo o grupo que la familia elige al aportar. KORUM es para mayores de 18 años: la persona lo declara al aceptar las condiciones; no se comprueba con un documento, porque pedirlo sería desproporcionado.

### 1.5 Terceros que intervienen

| Quién | Papel |
| :--- | :--- |
| Las entidades | Responsables de los tratamientos T8 a T13 y T16; reciben los datos fiscales de quien pide certificado y los datos de sus comercios |
| PAYCOMET | Responsable de sus propios tratamientos de pago. KORUM nunca ve el número de una tarjeta |
| Agencia Tributaria | Recibe el Modelo 182 de cada entidad y el registro de las facturas de KORUM |
| Vercel, Supabase, Brevo y Sentry | Encargados de KORUM: alojamiento, base de datos y ficheros, emails y registro de errores. Datos alojados en la Unión Europea |
| Herramienta de estadísticas (Plausible) y proveedor de facturación | Encargados de KORUM. Plausible recibe la dirección IP y el tipo de navegador de cada visita para calcular un código diario, que no guarda. El proveedor de facturación recibe los datos de los destinatarios de las facturas de KORUM |

### 1.6 Contexto interno

KORUM es una microempresa. Tienen acceso a la consola de administración muy pocas personas, todas con contraseña y verificación en dos pasos. No hay delegado de protección de datos; las cuestiones de privacidad las decide el administrador de la sociedad. La plataforma se ha desarrollado con herramientas de inteligencia artificial bajo la dirección del promotor, con revisiones de seguridad y de privacidad en cada entrega y una revisión de seguridad externa antes de operar con dinero real.

### 1.7 Contexto externo

- **Entorno escolar y deportivo de menores.** Las personas usuarias son adultas, pero todo gira alrededor de los niños: el riesgo de que un menor acabe identificado (en una foto, en un texto) es el más delicado.
- **Comunidades pequeñas.** En un colegio todo el mundo se conoce. Un dato que en otro sitio sería anónimo aquí puede no serlo.
- **Presión social.** Saber quién ha aportado y quién no podría señalar a una familia.
- **Dinero.** Hay incentivo para el fraude (firmas falsas, pagos con tarjetas robadas, suplantación de una entidad).
- **Tamaño previsto.** El plan de negocio habla de 45 entidades el primer año, 160 el segundo y 420 el tercero, con unas 450 familias cada una. El piloto empieza con 3.

## 2. Licitud del tratamiento y cumplimiento normativo

### 2.1 Bases jurídicas

| Tratamiento | Base (RGPD, art. 6.1) |
| :--- | :--- |
| Aportar, comprar, recibir el recibo y los avisos sobre la propia aportación, y la devolución | b) Ejecución de lo que la persona contrata |
| Contabilidad, facturas y datos fiscales del donativo | c) Obligación legal (Código de Comercio, normativa tributaria, Ley 49/2002) |
| Cuenta de usuario | b) Ejecución de lo contratado |
| Email y cookie del dispositivo en el buzón de ideas | b) Ejecución del servicio que la persona pide (una votación en la que cada familia cuenta una vez) y f) interés legítimo en evitar el fraude |
| Huella del navegador | a) Consentimiento, con casilla desmarcada y retirada con un clic |
| Códigos seudónimos de la conexión, rastros de seguridad y auditoría | f) Interés legítimo en la seguridad de la red y del servicio (considerando 49 del RGPD) |
| Documentación del titular de la entidad | f) Interés legítimo en entregar el dinero solo a quien corresponde, en evitar el fraude y en cumplir lo que pide PAYCOMET para dar de alta a la entidad (LOPDGDD, art. 19, para los datos de quien la representa) |
| Datos de las personas firmantes | f) Interés legítimo de KORUM y de la entidad en mantener su relación (LOPDGDD, art. 19). La cuenta con la que entran, como cualquier cuenta: b) |
| Datos de los voluntarios y lecturas de portería | f) Interés legítimo de la entidad en controlar el acceso a sus eventos |
| Textos de ideas, mensajes y consultas | b) Ejecución del servicio que la persona pide |
| Imágenes publicadas | La base la fija la entidad, que es la responsable. En su contrato declara que tiene los permisos de imagen necesarios (cláusula 5). KORUM solo las aloja y las publica |
| Solicitudes de derechos | c) Obligación legal (RGPD, arts. 12 a 22) |
| Datos de contacto de los comercios | b) Lo que el comercio contrata y f) interés legítimo en mantener la relación (LOPDGDD, art. 19) |
| Comunicaciones que no son del servicio | a) Consentimiento. Hoy no se envía ninguna |

### 2.2 Ponderación de los intereses legítimos

Cuando la base es el interés legítimo, hay que comprobar que ese interés pesa más que el perjuicio para la persona. Esta es la comprobación:

| Tratamiento | Interés que se protege | ¿Hace falta? | Qué supone para la persona | Garantías | Resultado |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Cookie del dispositivo y código seudónimo de la conexión en el buzón de ideas | Que la votación sea limpia: una familia, una firma | Sí. Sin ellos basta con crear emails para firmar muchas veces | Poco: se reconoce su dispositivo dentro del buzón, y nada más | Se crean solo al firmar o proponer una idea, con aviso; son códigos, no la IP; 12 y 13 meses; no sirven fuera de KORUM; una firma dudosa la revisa una persona | Prevalece el interés |
| Código seudónimo de la conexión al pagar | Detectar pagos fraudulentos y abusos automáticos | Sí. Es la señal mínima para frenar un ataque | Muy poco: no identifica a nadie por sí solo | 12 meses; solo para seguridad | Prevalece el interés |
| Rastros de seguridad y registro de auditoría | Proteger las cuentas y poder demostrar quién firmó cada salida de dinero | Sí. Es lo que espera cualquier persona de un servicio que mueve dinero | Poco: queda constancia de sus propias acciones | Sin contraseñas ni emails tecleados; 12 meses los rastros; la persona los recibe en la copia de sus datos | Prevalece el interés |
| Nombre del móvil del voluntario y lecturas de portería (interés de la entidad) | Controlar el acceso y evitar que una entrada se use dos veces | Sí | Muy poco: el nombre es libre y las lecturas no llevan el nombre de nadie | 90 días y 1 año | Prevalece el interés |
| Datos de contacto de las personas firmantes | Poder prestar el servicio a la entidad: avisar de lo que requiere firma, de los cambios y de las facturas | Sí: la entidad actúa a través de ellas | Poco: son datos profesionales, del cargo que ocupan | Solo para esa relación; se sustituyen en el relevo; la persona lo sabe desde la invitación o, quien da de alta a la entidad, desde la información del formulario de alta | Prevalece el interés |
| Documento de identidad de quien representa a la entidad | Entregar el dinero solo a quien corresponde y evitar que alguien suplante a una entidad | Sí: es lo mínimo para comprobar quién puede actuar por ella | Medio: es un documento sensible | Almacén privado; solo lo ven quien lo sube y el equipo de KORUM; cada apertura queda registrada; plazo propio | Prevalece el interés, con esas garantías |
| Persona de contacto de un comercio | Mantener la relación con el comercio | Sí: sin contacto no se le puede avisar ni facturar | Poco: son datos profesionales | Solo para esa relación; plazo propio; el comercio lo sabe antes de pagar | Prevalece el interés |

La persona puede oponerse en cualquier momento escribiendo a [[EMAIL DE PRIVACIDAD]].

### 2.3 Los principios del artículo 5

| Principio | Cómo se cumple |
| :--- | :--- |
| Licitud, lealtad y transparencia | [Política de privacidad](politica-de-privacidad.md) en lenguaje claro; [primera capa](primeras-capas.md) en cada formulario; casilla de aceptación y ventana de resumen en cada pago |
| Limitación de la finalidad | Cada dato se usa para lo que se pidió. La entidad recibe por contrato la prohibición de usar los datos para otra cosa |
| Minimización | Para aportar basta el email. El NIF solo si se quiere certificado. De los menores, solo el grupo. La entidad no ve emails |
| Exactitud | La persona corrige sus datos desde su cuenta o desde el formulario de ayuda, con verificación |
| Limitación del plazo | [Tabla única de plazos](tabla-de-plazos.md) y tarea automática semanal |
| Integridad y confidencialidad | Cifrado, códigos seudónimos, verificación en dos pasos, separación entre entidades y un registro de auditoría que no se puede alterar |
| Responsabilidad proactiva | Este informe, el registro de consentimientos con su versión, el registro de auditoría y el plan de acción |

### 2.4 Derechos de las personas

Acceso, descarga y supresión en autoservicio desde *Mi cuenta*, con un código por email antes de descargar o suprimir. Rectificación desde el formulario de ayuda. Para quien no tiene cuenta, el buzón de privacidad. Plazo: un mes, con alerta crítica en la consola si una solicitud lo supera.

### 2.5 Otras normas

- **LSSI, art. 22.2 (cookies):** solo cookies propias y necesarias. La cookie del buzón de ideas se crea únicamente al firmar o proponer una idea, con aviso en ese momento.
- **Reglamento de Servicios Digitales:** punto de contacto y vía para denunciar contenidos, en el aviso legal.
- **Decisiones automatizadas (RGPD, art. 22):** no hay ninguna que produzca efectos jurídicos o similares. El buzón de ideas deja firmas «en revisión» de forma automática, pero la firma no se pierde y la decide una persona de la entidad.

## 3. Metodología

- **Equipo:** el promotor, como administrador de la sociedad, decide y valida. El texto se ha escrito a partir del código de la aplicación (qué se guarda, dónde y cuánto tiempo) y de los documentos del proyecto. Lo han revisado dos revisores independientes: uno con perfil jurídico y otro que comprueba que se entiende.
- **Recursos:** RGPD y LOPDGDD; *Guía de gestión del riesgo y evaluación de impacto* (AEPD, 2021); *Modelo de informe de EIPD para el sector privado* (AEPD); *Lista de tipos de tratamientos que requieren evaluación de impacto* (AEPD, art. 35.4); *Directrices para la elaboración de contratos entre responsables y encargados* (AEPD); directrices WP248 y WP243 del Grupo de Trabajo del Artículo 29.
- **Alcance:** toda la plataforma, incluidos los tratamientos en los que KORUM es encargado, porque el riesgo para las personas es el mismo sea quien sea el responsable. En los tratamientos T8 a T13 y T16 la evaluación le corresponde a cada entidad; KORUM le aporta este análisis como encargado (RGPD, art. 28.3.f). No incluye lo que PAYCOMET hace con los datos del pago.
- **Cómo se mide el riesgo:** para cada riesgo se estima su **probabilidad** (improbable, baja, alta o muy alta) y su **impacto** en las personas (muy limitado, limitado, significativo o muy significativo). Se hace dos veces: sin medidas (riesgo inherente) y con ellas (riesgo residual). El nivel sale de la matriz de la AEPD:

| Probabilidad ↓ · Impacto → | Muy limitado | Limitado | Significativo | Muy significativo |
| :--- | :-: | :-: | :-: | :-: |
| **Muy alta** | Medio | Alto | Muy alto | Muy alto |
| **Alta** | Bajo | Alto | Muy alto | Muy alto |
| **Baja** | Bajo | Medio | Alto | Muy alto |
| **Improbable** | Bajo | Bajo | Medio | Muy alto |

**Cómo leerla:** se busca la fila de la probabilidad y la columna del impacto; donde se cruzan está el nivel. Ejemplo: probabilidad alta e impacto significativo da «Muy alto»; probabilidad improbable e impacto limitado da «Bajo».

## 4. Análisis del tratamiento: el recorrido de los datos

| Fase | Qué pasa | Dónde puede haber riesgo |
| :--- | :--- | :--- |
| **Recogida** | La persona escribe sus datos en un formulario (pago, cuenta, idea, consulta, alta de entidad). Una persona firmante escribe los de otra al invitarla. La entidad sube imágenes y documentos. El servidor calcula códigos seudónimos a partir de la conexión | Textos libres con datos que sobran; imágenes con menores; datos de una persona escritos por otra; identificadores del dispositivo |
| **Almacenamiento** | Base de datos y almacén de ficheros en Fráncfort. NIF, identificadores de pago y claves, cifrados. Conexión y dispositivo, como códigos seudónimos. Ficheros privados, en un almacén aparte | Filtración de la base de datos; claves mal guardadas; copias de seguridad |
| **Uso** | Cada persona ve lo suyo. Cada entidad ve solo sus datos, sin emails de familias. El equipo de KORUM ve lo necesario desde la consola, con registro. Se envían emails. El móvil del voluntario lee códigos QR | Que una entidad vea datos de otra; acceso excesivo del equipo; emails o enlaces que llegan a quien no deben; móviles personales |
| **Comunicación** | A la entidad: datos fiscales de quien pide certificado y datos de sus comercios. A PAYCOMET: lo necesario para el pago y para dar de alta a la entidad. A la Agencia Tributaria: lo que exige la ley. A los proveedores: lo que alojan o envían | Que la entidad use los datos para otra cosa; proveedores de grupos de fuera de la Unión Europea |
| **Destrucción** | Tarea semanal que borra o anonimiza al vencer cada plazo; supresión a petición; cuentas sin actividad | Que algo se guarde más de la cuenta; que un borrado falle sin que nadie se entere |

## 5. Análisis de la obligación de realizar la evaluación

**Supuestos del artículo 35.3 del RGPD.** No se da ninguno: no hay decisiones automatizadas con efectos jurídicos, ni categorías especiales a gran escala, ni observación sistemática de una zona pública.

**Lista de la AEPD (art. 35.4).** La evaluación es necesaria, en la mayoría de los casos, cuando se cumplen dos o más de sus once criterios:

| # | Criterio | ¿Se da en KORUM? |
| :-: | :--- | :--- |
| 1 | Perfilado o valoración de personas | **En parte.** El buzón de ideas valora si una firma es fiable (cuántas cuentas hay en un dispositivo). No se elaboran perfiles de hábitos ni de personalidad |
| 2 | Decisiones automatizadas que impiden ejercer un derecho o acceder a un servicio | No. Una firma en revisión no se pierde y la decide una persona |
| 3 | Observación sistemática o tratamiento de identificadores únicos de usuarios de servicios web | **Sí.** La cookie del dispositivo y, con consentimiento, la huella del navegador |
| 4 | Categorías especiales, o datos que permitan deducir la situación económica o información de categorías especiales | **En parte.** No se tratan categorías especiales. Un donativo no revela la solvencia de nadie, pero donar a la entidad de un centro confesional podría sugerir unas creencias |
| 5 | Datos biométricos para identificar | No. Las llaves de acceso se comprueban en el dispositivo; KORUM solo recibe una clave pública |
| 6 | Datos genéticos | No |
| 7 | Gran escala | **Todavía no; sí si el plan se cumple.** El piloto son 3 entidades, pero el plan de negocio prevé unas 20.000 familias el primer año, 72.000 el segundo y unas 190.000 el tercero |
| 8 | Combinación de registros de tratamientos con fines distintos o de responsables distintos | No. Los datos de cada entidad están separados y no se cruzan |
| 9 | Personas vulnerables, incluidos menores de 14 años | No se tratan sus datos, pero **el contexto es el de menores** y el riesgo de identificarlos existe |
| 10 | Nuevas tecnologías o uso innovador | **En parte:** la huella del navegador y la lectura de códigos sin conexión |
| 11 | Tratamientos que impiden ejercer derechos o usar un servicio | No |

**Conclusión.** Se cumple con claridad el criterio 3 y, en parte, el 1, el 4 y el 10; el 7 se cumplirá si la plataforma crece como está previsto. **La evaluación es obligatoria:** se dan dos o más criterios en cuanto se cuenta cualquiera de los parciales, y la AEPD pide hacerla en caso de duda. El tratamiento no figura en la lista de los que no la necesitan (art. 35.5).

## 6. Análisis de la necesidad del tratamiento

### 6.1 ¿Sirve y hace falta?

| Dato | ¿Sirve para su fin? | ¿Se podría hacer con menos? |
| :--- | :--- | :--- |
| Email al aportar | Sí: sin él no hay recibo, ni entrada, ni devolución | No. Ya es el único dato obligatorio |
| NIF, nombre y provincia | Sí: los exige el certificado y el Modelo 182 | No. Y solo se piden a quien quiere certificado |
| Curso, equipo o grupo | Sí: para el reto colectivo | Sí, y por eso es opcional y la entidad puede desactivar los retos |
| Cookie del dispositivo en el buzón | Sí: sin ella una persona firmaría muchas veces con emails distintos | Se descartó pedir el documento de identidad o el teléfono: sería mucho más invasivo |
| Huella del navegador | Sí: reconoce el dispositivo aunque se borren las cookies | Sí, y por eso solo se usa con consentimiento |
| Código seudónimo de la conexión | Sí: detecta muchas firmas o pagos desde el mismo sitio | Ya es lo mínimo: un código seudónimo, nunca la dirección IP |
| Documento de identidad de quien representa a la entidad | Sí: comprobar que la entidad existe y quién puede actuar por ella antes de entregarle dinero | No: es lo mínimo que exige la entrega de fondos |
| Registro de auditoría | Sí: demostrar quién firmó cada salida de dinero | Guarda solo quién, qué y cuándo; a los 6 años se desvincula de la cuenta y no queda nadie detrás |
| Lecturas de la portería | Sí: que una entrada no se use dos veces | Se guardan 1 año y no llevan el nombre de nadie |

### 6.2 Beneficios

- **Para las personas:** aportar en segundos sin crear una cuenta; recuperar el 100 % si la campaña no sale; saber a dónde va el dinero; proponer ideas sin dar la cara; tener su certificado fiscal sin papeleo; que la entidad no sepa cuánto han aportado, salvo quien pide su certificado fiscal.
- **Para las entidades:** financiar proyectos sin llevar efectivo ni listas en papel; dos firmas para sacar dinero; cumplir sus obligaciones fiscales.
- **Para KORUM:** prestar el servicio del que vive, con el fraude bajo control.

### 6.3 Alternativas descartadas

| Alternativa | Por qué no |
| :--- | :--- |
| Obligar a registrarse para aportar | Pide más datos de los necesarios y aleja a abuelos y vecinos |
| Enseñar a la entidad quién ha aportado y cuánto | Abre la puerta a la presión social sobre las familias |
| Mostrar el nombre en las ideas | Quita libertad para proponer y criticar |
| Verificar a cada persona que firma una idea con su documento de identidad o su móvil | Desproporcionado para una votación de barrio |
| Usar la huella del navegador sin pedir permiso | No es imprescindible: la cookie basta en la mayoría de los casos |
| Guardar la dirección IP | Un código seudónimo de la conexión sirve igual para detectar abusos |
| Pedir el nombre o la edad del menor para los retos | No hace falta: basta el grupo |
| Publicidad o analítica con cookies de terceros | No aporta nada al servicio y obligaría a rastrear a las familias |
| Guardar saldo de las familias (monedero) | Descartado por el promotor (decisión 38) |

## 7. Medidas para reducir los riesgos

### 7.1 Privacidad desde el diseño y por defecto

- **Por defecto, lo más protector:** la casilla de la aportación voluntaria, la de la huella del navegador y la de aceptación empiezan desmarcadas; el comercio que dona no tiene publicidad; las aportaciones son anónimas.
- **Anonimato de serie:** ideas y consultas llegan a la entidad con un código.
- **Separación entre entidades:** todos los accesos a datos de una entidad pasan por una única comprobación de acceso, que toma la entidad y el cargo de la sesión, nunca de lo que envía el navegador.
- **Cifrado y códigos seudónimos:** NIF, identificadores de pago y claves, cifrados; conexión y dispositivo, como códigos seudónimos.
- **Plazos automáticos:** una tarea semanal aplica la [tabla de plazos](tabla-de-plazos.md).
- **Derechos en autoservicio.**
- **Nada personal en buscadores** ni en asistentes de inteligencia artificial.

### 7.2 Los riesgos, de un vistazo

*P = probabilidad · I = impacto. Los niveles salen de la matriz del apartado 3. Las medidas de cada riesgo están en el apartado 7.3.*

| # | Qué puede pasar | Riesgo sin medidas | Riesgo con medidas |
| :-: | :--- | :--- | :--- |
| R1 | Una entidad, o cualquier persona, ve datos de otra entidad | P alta · I significativo → **Muy alto** | P improbable · I significativo → **Medio** |
| R2 | Robo o filtración de la base de datos o de los ficheros | P baja · I significativo → **Alto** | P improbable · I significativo → **Medio** |
| R3 | Un menor acaba identificado en una foto o en un texto | P alta · I significativo → **Muy alto** | P baja · I limitado → **Medio** |
| R4 | Se sabe quién ha aportado y quién no, o cuánto (presión social) | P alta · I significativo → **Muy alto** | P improbable · I limitado → **Bajo** |
| R5 | Una firma legítima queda en revisión, o el dispositivo se identifica más de lo necesario | P alta · I limitado → **Alto** | P baja · I muy limitado → **Bajo** |
| R6 | La entidad deduce quién escribió una idea o una consulta | P alta · I limitado → **Alto** | P baja · I limitado → **Medio** |
| R7 | Uso indebido de los datos fiscales (NIF y donativo) | P baja · I significativo → **Alto** | P improbable · I significativo → **Medio** |
| R8 | Alguien del equipo de KORUM mira datos que no necesita | P baja · I significativo → **Alto** | P improbable · I limitado → **Bajo** |
| R9 | Datos guardados más tiempo del necesario | P muy alta · I limitado → **Alto** | P baja · I muy limitado → **Bajo** |
| R10 | Suplantación con el documento de identidad de quien representa a una entidad | P baja · I significativo → **Alto** | P improbable · I significativo → **Medio** |
| R11 | Acceso a los datos desde fuera de la Unión Europea a través de un proveedor | P baja · I limitado → **Medio** | P improbable · I limitado → **Bajo** |
| R12 | Un enlace personal llega a quien no debe (voto, entrada, portería) | P alta · I limitado → **Alto** | P baja · I muy limitado → **Bajo** |
| R13 | Datos en los móviles personales de los voluntarios y registro de quién entra a un evento | P alta · I limitado → **Alto** | P baja · I muy limitado → **Bajo** |
| R14 | Se pierden o se alteran datos y no se puede acreditar un donativo o devolver un dinero | P baja · I significativo → **Alto** | P improbable · I limitado → **Bajo** |
| R15 | Datos de una persona que ha escrito otra (invitación a firmar, contacto de un comercio) | P alta · I muy limitado → **Bajo** | P baja · I muy limitado → **Bajo** |
| R16 | Datos personales en buscadores o en asistentes de inteligencia artificial | P baja · I significativo → **Alto** | P improbable · I limitado → **Bajo** |
| R17 | Alguien pide o borra los datos de otra persona, o quien no tiene cuenta no logra ejercer sus derechos | P baja · I limitado → **Medio** | P improbable · I limitado → **Bajo** |
| R18 | La entidad usa para otra cosa los datos que recibe (fiscales, comercios) | P baja · I limitado → **Medio** | P improbable · I limitado → **Bajo** |
| R19 | Alguien roba la cuenta de una persona firmante (con un email falso, por ejemplo) y entra en el panel de la entidad | P alta · I significativo → **Muy alto** | P improbable · I significativo → **Medio** |

### 7.3 Las medidas de cada riesgo

#### R1 · Una entidad ve datos de otra

- Una única comprobación de acceso por entidad; la entidad y el cargo salen de la sesión.
- Pruebas automáticas de intrusión entre entidades en cada entrega.
- Los intentos denegados quedan registrados.
- Prueba de intrusión externa antes de operar con dinero real.

#### R2 · Robo o filtración de la base de datos

- NIF, identificadores de pago y claves, cifrados, con la clave fuera de la base de datos.
- Códigos seudónimos en lugar de la dirección IP.
- Ficheros privados en un almacén aparte, con enlaces de corta duración.
- Datos en la Unión Europea.
- Verificación en dos pasos para quien administra.
- Usuario de base de datos con los permisos justos.
- KORUM no tiene números de tarjeta.
- Si aun así ocurre: aviso a las entidades afectadas en 48 horas, a la AEPD en 72 y a las personas afectadas si el riesgo es alto (KORUM es quien tiene sus emails).

#### R3 · Un menor identificado

- No se recoge ningún dato de menores.
- Casilla obligatoria «no aparece ningún menor reconocible» al subir una imagen, que queda registrada.
- Imágenes sin sus datos ocultos.
- Avisos en los textos libres.
- Retirada de una imagen en 72 horas.
- Cláusula en el contrato con la entidad.

#### R4 · Presión social

- La entidad no ve quién aporta ni cuánto. La única excepción es quien pide certificado fiscal: las personas firmantes ven su nombre, su NIF y su importe, para el certificado y el Modelo 182 (ese caso es el riesgo R7).
- Los retos por curso solo muestran avances en positivo, sin nombres ni importes, y se pueden desactivar.
- El contador público es un total.

#### R5 · Firma en revisión o dispositivo demasiado identificado

- Dos cuentas por dispositivo se admiten sin más (padre y madre).
- La firma en revisión no se pierde y la decide una persona de la entidad.
- Huella del navegador solo con consentimiento.
- Todo se guarda como códigos seudónimos, 12 y 13 meses.
- No sirve para seguir a nadie por otras webs.

#### R6 · La entidad deduce quién escribió

- Código en lugar de nombre; la entidad no ve el email.
- Aviso «no escribas datos de salud ni de menores».
- Los textos se borran al año (ideas) o a los dos años (consultas).
- KORUM no revela la autoría aunque la entidad lo pida.

#### R7 · Uso indebido de los datos fiscales

- Solo se piden a quien quiere certificado.
- NIF cifrado.
- Solo los ven las personas firmantes, para el certificado y el Modelo 182.
- El contrato prohíbe otros usos.
- 6 años y se borran.

#### R8 · Acceso excesivo del equipo de KORUM

- Muy pocas personas, con verificación en dos pasos.
- Cada acceso queda en un registro que no se puede borrar, y la entidad puede pedirlo.
- Compromiso de confidencialidad y revisión de accesos cada seis meses.

#### R9 · Datos guardados de más

- Tabla única de plazos.
- Tarea semanal con pasos independientes y alerta si falla.
- Cuentas sin actividad suprimidas.
- Revisión anual de la tabla.

#### R10 · Suplantación con el documento de identidad

- Almacén privado; el documento se guarda sin sus datos ocultos.
- Solo lo ven quien lo sube y el equipo de KORUM.
- Cada apertura queda registrada.
- Aviso a la persona si lo sube otra.

#### R11 · Acceso desde fuera de la Unión Europea

- Datos alojados en Fráncfort.
- Contrato de encargo con cada proveedor.
- Marco de Privacidad de Datos o cláusulas contractuales tipo.
- El registro de errores va sin datos personales.

#### R12 · Un enlace llega a quien no debe

- Enlaces firmados, que no se pueden inventar.
- El de voto solo se reenvía al email guardado, y la respuesta es la misma exista o no la aportación.
- La portería pide PIN, dura 48 horas como mucho y el PIN se cambia desde el panel.

#### R13 · Móviles personales y registro de asistencia

- El móvil solo guarda la lista de entradas del evento y, de lo leído sin cobertura, el código completo de cada entrada. Nunca nombres ni emails, y como mucho 3 días.
- La cámara no graba ni envía imágenes.
- Las lecturas se borran al año.
- Instrucciones a la entidad en su contrato.

#### R14 · Pérdida o alteración de datos

- Libro mayor que no admite cambios.
- Conciliación diaria con PAYCOMET.
- Copias de seguridad diarias con restauración probada.
- Cadena de huellas del registro de auditoría.

#### R15 · Datos escritos por otra persona

- La invitación explica quién la envía y para qué.
- Si no se acepta, los datos se borran a los 30 días.
- El comercio sabe antes de pagar qué datos recibe la entidad.

#### R16 · Datos personales en buscadores

- Las páginas personales, las ideas y los recibos no se indexan.
- Las páginas públicas no llevan nombres de personas.
- La entidad puede sacar su página de los buscadores.
- Los avisos a los buscadores no llevan datos personales.

#### R17 · Derechos ejercidos por quien no debe, o que no se logran ejercer

- Código por email antes de descargar o suprimir.
- Rectificación con verificación.
- Buzón de privacidad para quien no tiene cuenta.
- Alerta si una solicitud pasa del mes.

#### R18 · La entidad usa los datos para otra cosa

- Recibe solo lo necesario.
- Prohibición expresa en el contrato de encargo y en las condiciones.
- Las descargas quedan registradas.

#### R19 · Robo de la cuenta de una persona firmante

- Verificación en dos pasos obligatoria: la contraseña sola no basta.
- Cada firma pide, además, un código de un solo uso.
- El dinero solo se entrega a la cuenta verificada de la entidad: quien robe una cuenta no puede desviarlo.
- Con la doble firma hace falta una segunda persona; con la firma única, cada liberación se avisa al email general de la entidad (Sprint 5.19).
- Cada cambio de personas firmantes se avisa por email y queda registrado.

**Mi Hucha** (aportación mensual con la tarjeta guardada en PAYCOMET) sale apagada. Sus riesgos (cobros que la persona no recuerda, tarjeta guardada) se evalúan en una revisión de este informe antes de encenderla.

### 7.4 Resultado

| Nivel | Sin medidas | Con medidas |
| :--- | :-: | :-: |
| Muy alto | 4 | 0 |
| Alto | 11 | 0 |
| Medio | 3 | 7 |
| Bajo | 1 | 12 |

Los siete riesgos que quedan en nivel medio (R1, R2, R3, R6, R7, R10 y R19) lo están por el daño que harían si ocurrieran, no porque sea fácil que ocurran. En cinco de ellos la probabilidad ya está en el nivel más bajo de la escala. Son riesgos que se pueden asumir, con el seguimiento del apartado 9.

## 8. Balance entre riesgo y beneficio

- **Es idóneo** (sirve para su fin): sin estos datos no se puede cobrar, devolver, certificar ni garantizar una votación limpia.
- **Es necesario** (no hay otra forma con menos datos): en cada punto se ha elegido la opción que pide menos datos (apartado 6.3).
- **Es proporcionado** (lo que se gana compensa lo que se arriesga): las personas obtienen ventajas claras (devolución garantizada, anonimato ante la entidad salvo para quien pide certificado, certificado sin papeleo) y los riesgos que quedan son bajos o medios, con medidas concretas para cada uno. El tratamiento más intrusivo, el identificador del dispositivo en el buzón de ideas, afecta solo a quien decide firmar, se le avisa en ese momento, no identifica por sí solo y dura 13 meses.

**El balance es favorable, siempre que se cumplan las medidas del apartado 9.1.** Hoy varias de las que reducen los riesgos más altos (la prueba de intrusión externa, los plazos automáticos que faltan, la retirada de imágenes) todavía no están hechas.

## 9. Plan de acción

### 9.1 Medidas que faltan por construir o por poner en marcha

Todas tienen sprint en el [plan](../PLAN_IMPLEMENTACION_ATOMICO.md). **Ninguna puede quedar abierta cuando se cobre dinero real** (Sprint 6.2), salvo la opinión de las familias, que se recoge durante el piloto.

| Medida | Riesgos | Sprint |
| :--- | :-: | :-: |
| Textos legales publicados, con versión, y primera capa en cada formulario | Todos | 5.10a |
| Aviso automático a las entidades, 30 días antes, de un cambio en sus condiciones, en su contrato de encargo o en la lista de proveedores | R11 | 5.10a |
| Plazos pendientes de la tabla (rastros de seguridad, auditoría, historial de relevos, aportaciones separadas de la cuenta a los 6 años, altas sin verificar, textos de ideas, solicitudes de derechos, alertas y tareas) | R9 | 5.10b |
| Copia de «mis datos» con los rastros de seguridad propios | R17 | 5.10b |
| Documento de identidad visible solo para quien lo sube y para KORUM, con aviso a la persona; párrafo informativo en la invitación a firmar | R10, R15 | 5.10c |
| Compromiso de confidencialidad y revisión semestral de los accesos a la consola | R8 | 5.10c |
| Las búsquedas de la consola que cruzan varias entidades anotan de qué entidad son, para que la lista de accesos esté completa | R8 | 5.10c |
| Baja de una entidad: copia de sus datos, cierre y borrado | R9 | 5.10d |
| Claves de ejemplo rechazadas; códigos de acceso cifrados en la cola de emails; cadena de huellas de la auditoría | R2, R14 | 5.11a |
| Plazo de las lecturas de portería y de los canjes de vales; aviso al voluntario | R13 | 5.13 y 5.14c |
| Casilla de aceptación y ventana de resumen en cada pago | Todos | 5.15 |
| Plazos del contacto y de la facturación de los comercios | R9 | 5.16c |
| Aviso de cada liberación de dinero al email general de la entidad, cuando firma una sola persona | R19 | 5.19 |
| Destinatario de las facturas vaciado a los 6 años | R9 | 5.20b |
| Retirada de una imagen en 72 horas y limpieza de ficheros retirados | R3 | 5.24a |
| Usuario de base de datos con permisos justos; copias de seguridad y restauración probada; plazos en las cuentas de los proveedores; contrato de encargo aceptado con cada proveedor, incluidos el de estadísticas y el de facturación | R2, R11, R14 | 6.1a |
| Plazo de los registros de envío de emails en el proveedor | R9 | 6.1b |
| Manual de operación con cuatro procedimientos: brechas (con el aviso a las entidades, a la AEPD y a las personas afectadas), solicitudes de derechos, entrega a una entidad de la lista de accesos y supresiones que hay que repetir tras restaurar una copia | R2, R8, R9, R17 | 6.1c |
| Prueba de intrusión externa y corrección de lo que encuentre | R1, R2 | 6.1e |
| Opinión de las personas afectadas (apartado 10.3) | — | 6.2 (las personas firmantes, antes del primer cobro; las familias, durante el piloto) |

### 9.2 Seguimiento

- **Quién:** el administrador de KORUM.
- **Cuándo se revisa este informe:**
  - una vez al año;
  - antes de encender Mi Hucha;
  - antes de activar el pago directo a proveedores, si algún día se activa;
  - cuando se añada un dato personal nuevo, un proveedor nuevo o una función que cambie quién ve qué;
  - después de una brecha de seguridad;
  - cuando la plataforma supere las 50 entidades, para volver a valorar la escala.
- **Qué se mira:** el estado del plan de acción; las alertas de la tarea de plazos; las solicitudes de derechos y su tiempo de respuesta; las peticiones de retirada de imágenes; los accesos del equipo a datos de entidades; los incidentes.

## 10. Conclusiones y recomendaciones

### 10.1 Resultado

Con las medidas descritas, **ningún riesgo queda en nivel alto o muy alto**. El nivel de riesgo del tratamiento en su conjunto es **medio** (el más alto de los que quedan), que es asumible. El tratamiento es necesario y proporcionado.

**La evaluación es favorable, con una condición:** que las medidas del apartado 9.1 estén hechas antes de cobrar dinero real (la opinión de las familias, durante el piloto).

### 10.2 Consulta previa a la AEPD

**No hace falta** (RGPD, art. 36): solo se exige cuando, después de aplicar las medidas, queda un riesgo alto.

### 10.3 Opinión de las personas afectadas

El artículo 35.9 pide recabarla «cuando proceda». Todavía no hay personas usuarias reales. Se recabará en dos momentos del Sprint 6.2, con un cuestionario breve: a las personas firmantes de las tres entidades, durante su alta acompañada y **antes del primer cobro real**; y a una muestra de sus familias, durante el piloto. Se les pregunta si entienden qué datos se piden y para qué, si echan en falta algo y si algo les incomoda. El resultado se añade a este informe.

### 10.4 Recomendaciones

1. No añadir ningún campo de texto libre sin su aviso «no escribas datos personales de otras personas ni de menores».
2. No dar nunca a una entidad, ni a petición suya, un dato que la plataforma le oculta por diseño (quién aporta, quién propone, quién consulta).
3. Mantener apagado lo que no se ha evaluado (Mi Hucha, pago a proveedores).
4. Tratar cualquier petición de retirar una imagen de un menor como urgente.

### 10.5 Documentos relacionados

- [Política de privacidad](politica-de-privacidad.md) y [primera capa de cada formulario](primeras-capas.md)
- [Contrato de encargo del tratamiento](contrato-de-encargo.md)
- [Tabla única de plazos de conservación](tabla-de-plazos.md)
- [Registro de actividades de tratamiento](registro-de-actividades.md)
- [Política de cookies](politica-de-cookies.md)
- [CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §5 y §6

### 10.6 Validación

| Dato | Valor |
| :--- | :--- |
| **Validado por** | El administrador de [[RAZÓN SOCIAL]] |
| **Fecha** | 2026-11-18 |
| **Próxima revisión** | Un año después de la validación, o antes si se da alguno de los supuestos del apartado 9.2 |
