# Aceptación de las condiciones y primera capa de privacidad de cada formulario

> **Documento:** `primeras-capas` · **Versión:** 2026-11-18 · **Estado:** BORRADOR, pendiente de la validación del promotor · **Idioma:** castellano (catalán e inglés, en la SESIÓN I1)
> **Qué es:** los textos cortos que acompañan a cada formulario. No son páginas: van a los catálogos `messages/{es,ca,en}.json` en los sprints que se indican (5.10a, 5.15, 5.16b, 5.10c y 5.24a).
> **Criterio (decisión 48 del promotor, 2026-11-18, que cambia la 39):** en todo pago hay una **casilla obligatoria**, desmarcada, con la que la persona acepta las condiciones de forma expresa. Al pulsar sobre «las condiciones» se abre una **ventana con el resumen** de lo que acepta y de lo que se hace con sus datos, con el enlace al texto completo. Junto al botón no hay avisos legales largos. Los formularios que no son un pago llevan una línea y un desplegable.

---

## Cómo se presenta

**En un pago** (donación, entradas, vales, aportación mensual y comercios) hay tres piezas:

1. **Casilla obligatoria**, desmarcada, junto al botón de pagar. Sin marcarla no se puede pagar: si se pulsa el botón, aparece junto a la casilla el aviso «Marca la casilla para continuar».
2. **Ventana «Las condiciones, en resumen»**, que se abre al pulsar «las condiciones» en el texto de la casilla. Tiene dos bloques: **«Lo que aceptas»** (lo que importa de las condiciones, en pocas líneas) y **«Tus datos»** (quién los trata, para qué, quién más los recibe y cómo ejercer los derechos). Termina con los enlaces al texto completo y a la política de privacidad. Junto a la casilla hay un segundo enlace, «Cómo usamos tus datos», que abre la misma ventana por el bloque de los datos: así la información de privacidad está a la vista y no se presenta como algo que se acepta. La ventana se cierra sin perder lo escrito en el formulario.
3. **Lo que se guarda:** con cada pago, la versión de las condiciones aceptada y la fecha. El resumen de lo que aplica llega también en el email del recibo.

**En los demás formularios** (alta de una entidad, entrar o crear una cuenta) hay dos piezas: una **línea visible** junto al botón y un **desplegable** con los datos de privacidad, cerrado por defecto.

En los textos, `{entidad}` es el nombre de la entidad y `{titular}` su titular legal.

---

## 1. Pago de familias: donación a una campaña

### Casilla obligatoria

> ☐ He leído y acepto [las condiciones](condiciones-generales.md). [Cómo usamos tus datos](politica-de-privacidad.md)

### Aviso si se intenta pagar sin marcarla

> Marca la casilla para continuar.

### Ventana «Las condiciones, en resumen»

> **Lo que aceptas**
>
> - **A quién aportas:** a una campaña de {entidad}. El dinero es para {titular}. KORUM pone la plataforma y PAYCOMET procesa el pago.
> - **Todo o nada:** tu aportación queda retenida en PAYCOMET hasta que la campaña llega a su meta. Si no llega, te devolvemos el 100 %, sin que tengas que pedirlo.
> - **Si la entidad propone un proyecto más pequeño,** te pedimos tu voto. Si no votas o prefieres la devolución, recuperas el 100 %.
> - **Una donación no es una compra:** no se devuelve por cambiar de opinión.
> - **La aportación voluntaria a KORUM** es opcional. Si la das, puedes recuperarla durante 14 días con el enlace de tu recibo.
> - **Para aportar** tienes que ser mayor de 18 años.
>
> **Tus datos**
>
> - **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]). El pago lo procesa PAYCOMET, y KORUM nunca ve tu tarjeta.
> - **Para qué:** enviarte tu recibo, avisarte del resultado de la campaña y devolverte el dinero si no se consigue.
> - **Quién más los recibe:** PAYCOMET, para cobrar. {entidad} no ve quién ha aportado ni cuánto; solo si pides certificado fiscal recibe tu NIF, tu nombre, tu provincia y el importe de tu donativo, para tu certificado y su declaración anual.
> - **Tus derechos:** puedes acceder a tus datos, corregirlos y suprimirlos desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
>
> [Leer las condiciones completas](condiciones-generales.md) · [Política de privacidad](politica-de-privacidad.md)

**Bajo el bloque «Quiero mi certificado fiscal»** (sustituye al texto de ayuda actual)

> Para tu certificado fiscal (Ley 49/2002), con el que podrás deducir tu donación si te corresponde. {titular} es quien usa estos datos y el importe, para tu certificado y su declaración anual (Modelo 182). KORUM los guarda cifrados por su cuenta.

## 2. Pago de familias: entradas y vales

### Casilla obligatoria

> ☐ He leído y acepto [las condiciones de entradas y vales](condiciones-entradas-y-vales.md). [Cómo usamos tus datos](politica-de-privacidad.md)

### Ventana «Las condiciones, en resumen»

> **Lo que aceptas**
>
> - **Quién vende:** {titular}, que organiza el evento o la venta y recibe el dinero. KORUM pone la plataforma y PAYCOMET procesa el pago.
> - *(Si el titular no es una empresa)* **{titular} es una entidad sin ánimo de lucro, no una empresa.** Las devoluciones de estas condiciones se te aplican igual, y tus derechos frente a KORUM no cambian. Lo único que puede cambiar es que a la venta que te hace {titular} no se le aplique la ley de consumo.
> - *(Si el titular es el titular de un colegio)* **{titular} vende como empresa.**
> - *(En una compra de entradas)* **Entradas:** son para un evento con fecha y no se devuelven por cambiar de opinión o por no poder ir. Si el evento se cancela, recuperas el 100 %. Si cambia de fecha, puedes recuperarlo durante 14 días.
> - *(En una compra de vales)* **Vales:** puedes recuperar el 100 % durante 14 días si no has gastado ninguno. Valen hasta el {fecha de validez}, que fija {entidad}; pasada esa fecha no se pueden usar ni se devuelven, salvo que sigas dentro de los 14 días de devolución y no hayas gastado ninguno. Un vale no es dinero: se canjea en el puesto de {entidad}.
> - **Para comprar** tienes que ser mayor de 18 años.
>
> **Tus datos**
>
> - **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]). El pago lo procesa PAYCOMET, y KORUM nunca ve tu tarjeta.
> - **Para qué:** enviarte tus entradas o tus vales, controlar su uso en la puerta o en el puesto y hacer las devoluciones que correspondan.
> - **Quién más los recibe:** PAYCOMET, para cobrar. Quien atiende la puerta o el puesto solo ve si tu código es válido.
> - **Tus derechos:** puedes acceder a tus datos, corregirlos y suprimirlos desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
>
> [Leer las condiciones completas](condiciones-entradas-y-vales.md) · [Política de privacidad](politica-de-privacidad.md)

**De dónde sale la línea de quién vende.** De la forma jurídica que la entidad declara en el alta: el titular de un colegio privado o concertado vende como empresa; un AMPA o AFA, un club, una fundación o una asociación, como entidad sin ánimo de lucro. No hace falta ninguna casilla nueva en el alta. El Sprint 5.15 comprueba a qué grupo va cada forma jurídica (un club que sea sociedad anónima deportiva vende como empresa).

**Resumen que llega en el email del recibo** (soporte duradero de lo que aplica a esa compra)

- Entradas: «Tus entradas son para un evento con fecha: no se devuelven por cambiar de opinión. Si el evento se cancela, te devolvemos el 100 %. Si cambia de fecha, podrás recuperar el 100 % durante 14 días.»
- Vales: «Puedes recuperar el 100 % de esta compra hasta el {fecha} si no has gastado ningún vale. Tus vales valen hasta el {fecha de validez}.»
- Donación: «Si la campaña no llega a su meta, te devolvemos el 100 %, sin que tengas que pedirlo. Solo se queda en la campaña si la entidad propone un proyecto más pequeño y tú votas por mantenerla.»
- Aportación voluntaria a KORUM, si la hay: «Puedes recuperar tu aportación voluntaria a KORUM hasta el {fecha} con este enlace.»

## 3. Pago de comercios

### Casilla obligatoria

> ☐ He leído y acepto [las condiciones para comercios](condiciones-comercios.md). [Cómo usamos los datos de tu comercio](politica-de-privacidad.md)

### Línea visible, bajo la casilla

> Tu aportación no se devuelve: una donación, nunca; un patrocinio, solo en los dos casos que explican las condiciones. Si te cobramos dos veces por error, te lo devolvemos.

### Ventana «Las condiciones, en resumen»

> **Lo que aceptas**
>
> - **Tu importe llega íntegro a {entidad}.** La gestión de KORUM va aparte y la ves antes de pagar.
> - **Tu aportación no se devuelve.** Una donación, nunca. Un patrocinio con publicidad, solo si {entidad} no te admite o no decide en 14 días, o si una renovación se paga dos veces y lo pides en 14 días.
> - **Si la campaña que eliges no sale adelante,** tu dinero va a otro proyecto de {entidad}.
> - **Lo que acuerdes con {entidad} sobre tu publicidad es cosa vuestra.** KORUM no interviene.
>
> **Los datos de tu comercio**
>
> - **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]), para gestionar tu aportación y emitir su factura.
> - **Quién más los recibe:** PAYCOMET, para cobrar. Y {entidad}, que recibe:
>   - el nombre de tu comercio, el importe y tus datos de contacto (persona, email, teléfono, dirección y página web), para ubicarte, contactarte y agradecerte tu apoyo;
>   - *(si es un patrocinio con publicidad)* tus datos de facturación (razón social, NIF y domicilio fiscal), porque revisa tu solicitud y te emite esa factura;
>   - *(si es una donación a una entidad acogida a la Ley 49/2002)* tu razón social, tu NIF y tu provincia, para tu certificado y su declaración anual (Modelo 182).
> - **Tus derechos:** escribe a [[EMAIL DE PRIVACIDAD]].
>
> [Leer las condiciones completas](condiciones-comercios.md) · [Política de privacidad](politica-de-privacidad.md)

**Bajo la casilla «Envíame por email el enlace para renovar»** (solo en el patrocinio con publicidad)

> Si no la marcas, {entidad} aún puede enviarte una invitación a renovar al año. En cada email tendrás un enlace para darte de baja.

## 4. Alta de una entidad

### Línea visible, junto al botón de crear la entidad

> Al crear la entidad aceptáis las [condiciones para entidades](condiciones-entidades.md) y el [contrato de encargo del tratamiento](contrato-de-encargo.md). KORUM usa vuestros datos para el alta y las firmas. [Vuestros derechos](politica-de-privacidad.md)

### Desplegable «Vuestros datos»

> **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]).
> **Para qué:** crear la entidad y vuestras cuentas de firmante, comprobar la documentación del titular y avisaros de lo que requiere vuestra firma.
> **Quién más los recibe:** PAYCOMET, para dar de alta a la entidad como destinataria de los pagos.
> **Si escribís los datos de otra persona** (la cofirma), le enviaremos una invitación en la que se le explica quién la invita y para qué. Si no acepta, sus datos se borran a los 30 días.
> **Vuestros derechos:** desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
> [Política de privacidad](politica-de-privacidad.md)

**En el email de invitación a firmar** (a la persona cuyos datos escribió otra)

> Te escribimos porque {nombre de quien invita}, de {entidad}, te ha propuesto como {cargo}. Para enviarte esta invitación nos ha dado tu nombre y tu email; no tenemos ningún otro dato tuyo. Si no la aceptas, los borraremos en 30 días. Puedes pedir antes que los borremos, o ejercer cualquier otro derecho, en [[EMAIL DE PRIVACIDAD]]. [Política de privacidad](politica-de-privacidad.md)

## 5. Buzón de ideas

**Aviso al firmar o proponer** (sustituye a los dos textos actuales, más largos)

> Al firmar guardamos una cookie propia en este dispositivo durante 13 meses. Es necesaria para que cada familia firme una sola vez. [Política de cookies](politica-de-cookies.md)

### Casilla opcional, desmarcada

> ☐ Ayudar a proteger la votación (opcional)
> Guardamos durante 12 meses un código que identifica este navegador, para reconocerlo aunque borres las cookies. Puedes retirarlo con un clic y, sin él, la votación funciona igual. [Más información](politica-de-privacidad.md)

### Bajo el campo de texto de la idea y del chat

> Tu idea se publica con un código, sin tu nombre. No escribas tu nombre, el de tus hijos ni datos de otras personas.

### Desplegable «Tus datos»

> **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]) comprueba que cada persona firma una vez. {entidad} modera las ideas.
> **Para qué:** que cada persona proponga y firme una sola vez, y publicar tu idea con un código.
> **Quién más los recibe:** {entidad}, que solo ve tu código, no tu email ni tu nombre.
> **Tus derechos:** desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
> [Política de privacidad](politica-de-privacidad.md)

## 6. Formulario de soporte

### Bajo el campo del mensaje, cuando la consulta va a la entidad

> {entidad} lee tu consulta, pero no ve tu email. No escribas datos de salud ni datos de menores. [Política de privacidad](politica-de-privacidad.md)

### Bajo el campo del mensaje, cuando la consulta va a KORUM

> Usamos tu email y tu mensaje solo para contestarte. [Política de privacidad](politica-de-privacidad.md)

## 7. Mi Hucha (cuando esté disponible)

### Casilla obligatoria, junto al botón «Pagar el primer mes y activar»

> ☐ He leído y acepto [las condiciones de la aportación mensual](condiciones-aportacion-mensual.md). [Cómo usamos tus datos](politica-de-privacidad.md)

### Ventana «Las condiciones, en resumen»

> **Lo que aceptas**
>
> - **Qué activas:** una aportación mensual a {entidad}. Cada mes cobramos a tu tarjeta el importe que eliges, con la gestión de KORUM que ves antes de activar, y lo llevamos a una campaña de {entidad}.
> - **Puedes pausarla o cancelarla cuando quieras,** con un clic.
> - **Si la cancelas en los 14 días siguientes al alta,** te devolvemos la gestión cobrada. Tu donación sigue en su campaña y la recuperas si esa campaña no se consigue.
> - **KORUM no guarda dinero tuyo:** cada cobro va directo a una campaña.
>
> **Tus datos**
>
> - **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]). Tu tarjeta la guarda PAYCOMET, y KORUM nunca la ve.
> - **Para qué:** cobrar tu aportación cada mes y llevarla a una campaña de {entidad}.
> - **Quién más los recibe:** PAYCOMET, para cobrar cada mes. {entidad} no ve quién aporta ni cuánto, salvo que pidas certificado fiscal.
> - **Tus derechos:** puedes acceder a tus datos, corregirlos y suprimirlos desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
>
> [Leer las condiciones completas](condiciones-aportacion-mensual.md) · [Política de privacidad](politica-de-privacidad.md)

### Resumen en el email de bienvenida

> Puedes pausar o cancelar tu aportación cuando quieras. Si la cancelas antes del {fecha}, te devolvemos la gestión cobrada; tu donación sigue en su campaña y la recuperas si esa campaña no se consigue.

## 8. Portería y puesto de vales (voluntarios)

### En la pantalla del PIN

> Este móvil guarda la lista de entradas del evento, y lo que leas sin cobertura, hasta que cierres la portería (3 días como máximo). Ciérrala al terminar. La cámara solo lee códigos: no graba nada. No reenvíes este enlace.

### En el panel de la entidad, junto al enlace de la portería

> Pásalo solo a los voluntarios de este evento y no lo publiques. Si se filtra, cámbialo aquí.

## 9. Activar la firma única (panel de la entidad)

### Texto sobre la casilla

> Con la firma única, una sola persona aprueba y libera el dinero, sin que nadie más lo revise, y el cambio es inmediato.

### Casilla de confirmación

> ☐ Confirmo que la entidad asume esa responsabilidad y que este modo es conforme con los estatutos de la entidad y con lo que haya acordado su órgano de gobierno.

### Aviso bajo la casilla

> Con la firma única, cada liberación de dinero se avisará al email general de la entidad.

## 10. Declarar que la entidad puede facturar con IVA (panel de la entidad)

### Casilla de confirmación

> ☐ Declaro que {titular} está dada de alta para emitir facturas con IVA y que emitirá a cada comercio la factura de su patrocinio. La entidad responde de esta declaración.

### Aviso bajo la casilla

> Avisaremos a la otra persona firmante y quedará en el registro de actividad.

## 11. Entrar o crear una cuenta

### Línea visible

> Al entrar por primera vez creas tu cuenta y aceptas las [condiciones](condiciones-generales.md). KORUM usa tu email para darte acceso. [Tus derechos](politica-de-privacidad.md)

### Desplegable «Tus datos»

> **Quién los trata:** KORUM ([[RAZÓN SOCIAL]]).
> **Para qué:** enviarte el enlace o el código de acceso y enseñarte tus aportaciones, tus entradas y tus documentos.
> **Quién más los recibe:** nadie, salvo los proveedores técnicos que nos prestan servicio.
> **Tus derechos:** desde *Mi cuenta* o en [[EMAIL DE PRIVACIDAD]].
> [Política de privacidad](politica-de-privacidad.md)
