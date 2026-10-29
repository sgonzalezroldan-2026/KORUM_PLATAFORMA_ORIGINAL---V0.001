/**
 * Se ejecuta una vez al arrancar el servidor. La validación vive en `instrumentation-node.ts` para que el código de Node
 * (`process.exit`) no entre en la compilación del runtime Edge.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
