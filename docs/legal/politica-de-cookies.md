# Política de cookies

> **Documento:** `cookies` · **Versión:** 2026-11-18 · **Estado:** VALIDADO por el promotor (2026-11-18) · **Idioma:** castellano (catalán e inglés, en la SESIÓN I1)
> **Se publica en:** `/cookies` (Sprint 5.10a). Comprobada contra el código el 2026-11-18 (`auth-config.ts`, `device-signals.ts`, `gate-cookie.ts`, `cookies.ts`, `routing.ts` y el almacenamiento del navegador). Si se añade una cookie, este texto se actualiza en el mismo sprint. Las notas de este recuadro no forman parte del texto publicado.

---

## 1. En pocas palabras

KORUM solo usa **cookies propias y necesarias** para que la plataforma funcione. **No hay cookies de publicidad, de redes sociales ni de seguimiento, ni cookies de terceros.** Por eso no ves un aviso de cookies al entrar: la ley solo lo exige para las que no son necesarias.

Si algún día añadimos una cookie que no sea imprescindible, no se activará hasta que la aceptes, y «Rechazar» será tan visible como «Aceptar».

## 2. Qué es una cookie

Es un pequeño fichero que una web guarda en tu navegador para recordar algo entre una página y la siguiente (por ejemplo, que has iniciado sesión). Los navegadores tienen además un almacenamiento propio que cumple una función parecida; también te lo contamos aquí.

## 3. Las cookies que usamos

| Cookie | Para qué sirve | Cuándo se crea | Cuánto dura |
| :--- | :--- | :--- | :--- |
| `korum.session_token` | Mantener tu sesión iniciada | Al entrar en tu cuenta | 30 días desde tu última visita; se borra al cerrar sesión |
| Cookies temporales de acceso (`korum.two_factor` y la de las llaves de acceso) | Completar la verificación en dos pasos o el acceso con una llave | Solo mientras entras | Unos minutos |
| `korum_device` | Reconocer tu dispositivo en el buzón de ideas, para que cada familia firme una sola vez | **Solo cuando firmas o propones una idea** | 13 meses |
| `korum_gate` | Mantener abierta la portería o el puesto de vales en el móvil del voluntario después de escribir el PIN | Al entrar con el PIN del evento | Hasta que caduca el PIN (como mucho, 48 horas); se borra al cerrar la portería |

Todas son de KORUM, viajan cifradas y no se pueden leer desde otras webs. En la web publicada, el nombre de las cookies de sesión lleva delante el prefijo de seguridad `__Secure-`.

**Sobre `korum_device`:** es necesaria para el servicio que pides al firmar (una votación en la que cada persona cuenta una vez), así que no te pedimos permiso para crearla, pero te avisamos en el propio buzón en ese momento. No sirve para seguirte por la web ni se comparte con nadie.

## 4. Lo que guardamos en el almacenamiento de tu navegador

No son cookies y no salen de tu dispositivo, salvo cuando tú envías el formulario:

| Qué se guarda | Para qué | Cuánto dura |
| :--- | :--- | :--- |
| El borrador de un pago (lo que habías elegido) | Que no tengas que empezar de nuevo si el pago se interrumpe | Hasta que cierras la pestaña o terminas el pago |
| El paso pendiente de una firma en el panel de la entidad | Continuar la firma después de la verificación | Hasta que cierras la pestaña o terminas la firma |
| En la portería y en el puesto de vales: la lista de entradas del evento y lo que se lee sin cobertura | Poder validar aunque falle la cobertura | Hasta que se cierra la portería; como mucho, 3 días |

## 5. Lo que no usamos

- **Estadísticas sin cookies.** Contamos las visitas con una herramienta que no guarda nada en tu navegador y no identifica a nadie.
- **Sin cookie de idioma.** El idioma lo marca la dirección de la página (`/`, `/ca` o `/en`).
- **Sin huella del navegador por defecto.** En el buzón de ideas puedes aceptar, si quieres, una protección extra que calcula un código con datos técnicos de tu navegador. Es opcional, empieza desmarcada, se conserva hasta 12 meses después de la última vez que usas ese dispositivo en el buzón y la retiras con un clic. Está explicada en la [política de privacidad](politica-de-privacidad.md).

## 6. La página de pago

Cuando pagas, introduces los datos de tu tarjeta o de tu Bizum en la página de PAYCOMET. Esa página puede usar sus propias cookies técnicas, de las que es responsable PAYCOMET.

## 7. Cómo borrar o bloquear las cookies

Puedes borrarlas o bloquearlas desde los ajustes de tu navegador. Ten en cuenta lo que ocurre si lo haces:

- Sin la cookie de sesión no podrás mantener tu cuenta abierta. Aportar o comprar sin cuenta sigue funcionando.
- Sin la cookie de dispositivo podrás firmar ideas igualmente; se creará una nueva la próxima vez que firmes.

## 8. Cambios

Si cambian las cookies que usamos, actualizaremos esta página y su fecha. Para cualquier duda: [[EMAIL DE PRIVACIDAD]].
