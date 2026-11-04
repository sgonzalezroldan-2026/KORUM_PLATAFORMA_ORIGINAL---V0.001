import { randomBytes } from 'node:crypto';
import { StorageError, type StoragePutInput, type StorageProvider } from './storage-provider';

/**
 * Almacén en memoria para desarrollo y pruebas: sin red y sin persistencia. Las URL firmadas llevan una caducidad que `resolveSignedUrl`
 * comprueba, así que los tests pueden verificar que una URL de corta duración deja de valer.
 */

interface StoredObject {
  contentType: string;
  body: Uint8Array;
}

export class MemoryStorage implements StorageProvider {
  readonly name = 'memory';
  private readonly objects = new Map<string, StoredObject>();
  private readonly signed = new Map<string, { bucket: string; objectKey: string; expiresAt: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private static id(bucket: string, objectKey: string) {
    return `${bucket}/${objectKey}`;
  }

  async put({ bucket, objectKey, body, contentType }: StoragePutInput): Promise<void> {
    const id = MemoryStorage.id(bucket, objectKey);
    if (this.objects.has(id)) throw new StorageError('El objeto ya existe', '409');
    this.objects.set(id, { contentType, body: new Uint8Array(body) });
  }

  async remove(bucket: string, objectKey: string): Promise<void> {
    this.objects.delete(MemoryStorage.id(bucket, objectKey));
  }

  publicUrl(bucket: string, objectKey: string): string {
    return `memory://public/${MemoryStorage.id(bucket, objectKey)}`;
  }

  async createSignedUrl(bucket: string, objectKey: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(MemoryStorage.id(bucket, objectKey))) throw new StorageError('El objeto no existe', '404');
    const token = randomBytes(16).toString('hex');
    this.signed.set(token, { bucket, objectKey, expiresAt: this.now().getTime() + expiresInSeconds * 1000 });
    return `memory://signed/${MemoryStorage.id(bucket, objectKey)}?token=${token}`;
  }

  /** Lo que devolvería el almacén al abrir una URL firmada: el objeto, o `null` si el token no existe o ya caducó. */
  resolveSignedUrl(url: string): StoredObject | null {
    const token = new URL(url).searchParams.get('token');
    const grant = token ? this.signed.get(token) : undefined;
    if (!grant || grant.expiresAt <= this.now().getTime()) return null;
    return this.objects.get(MemoryStorage.id(grant.bucket, grant.objectKey)) ?? null;
  }

  has(bucket: string, objectKey: string): boolean {
    return this.objects.has(MemoryStorage.id(bucket, objectKey));
  }

  get size(): number {
    return this.objects.size;
  }
}
