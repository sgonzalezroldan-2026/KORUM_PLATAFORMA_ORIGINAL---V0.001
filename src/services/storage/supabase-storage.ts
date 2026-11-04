import { PRIVATE_BUCKET, StorageError, type StoragePutInput, type StorageProvider } from './storage-provider';

/**
 * Adaptador de Supabase Storage por su API REST (sin SDK, igual que el de Paycomet). Usa la clave `service_role`, que solo vive en el
 * servidor: ningún navegador llega a hablar con el almacén, todo pasa por URL firmadas o por el cubo público. Aún no se ha ejecutado
 * contra un proyecto real (sin credenciales); cualquier respuesta inesperada falla de forma explícita.
 */

const REQUEST_TIMEOUT_MS = 30_000;

const encodePath = (objectKey: string) => objectKey.split('/').map(encodeURIComponent).join('/');

export class SupabaseStorage implements StorageProvider {
  readonly name = 'supabase';
  private readonly baseUrl: string;

  constructor(
    projectUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = `${projectUrl.replace(/\/+$/, '')}/storage/v1`;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.serviceRoleKey}`, apikey: this.serviceRoleKey },
        // Una redirección llevaría la clave del servicio a otro host.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new StorageError('No se pudo completar la llamada al almacén de ficheros', 'NETWORK');
    }
    if (!response.ok) throw new StorageError(`El almacén de ficheros respondió ${response.status}`, String(response.status));
    return response;
  }

  async put({ bucket, objectKey, body, contentType }: StoragePutInput): Promise<void> {
    await this.request(`/object/${encodeURIComponent(bucket)}/${encodePath(objectKey)}`, {
      method: 'POST',
      // Un documento privado no se queda en la caché del navegador ni de una CDN aunque su URL firmada caduque: hay ordenadores compartidos.
      headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': bucket === PRIVATE_BUCKET ? 'private, no-store' : 'max-age=3600' },
      body: Buffer.from(body)
    });
  }

  async remove(bucket: string, objectKey: string): Promise<void> {
    await this.request(`/object/${encodeURIComponent(bucket)}/${encodePath(objectKey)}`, { method: 'DELETE' });
  }

  publicUrl(bucket: string, objectKey: string): string {
    return `${this.baseUrl}/object/public/${encodeURIComponent(bucket)}/${encodePath(objectKey)}`;
  }

  async createSignedUrl(bucket: string, objectKey: string, expiresInSeconds: number): Promise<string> {
    const response = await this.request(`/object/sign/${encodeURIComponent(bucket)}/${encodePath(objectKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds })
    });
    const body = (await response.json().catch(() => null)) as { signedURL?: unknown } | null;
    if (typeof body?.signedURL !== 'string' || !body.signedURL.startsWith('/')) throw new StorageError('Respuesta inesperada del almacén al firmar una URL', 'UNEXPECTED_RESPONSE');
    return `${this.baseUrl}${body.signedURL}`;
  }
}
