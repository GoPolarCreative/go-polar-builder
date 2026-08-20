import { config } from '../config.js'

/**
 * Object storage. Replaces R2.
 *
 * Two implementations behind one interface:
 *   vercel-blob - production, @vercel/blob
 *   local       - a directory on disk, so a fresh clone runs with no accounts at all
 *
 * Everything the customer's browser can reach goes through our own API routes rather than a
 * bucket URL, so access stays behind the session and the signed-download rules. Blob objects are
 * public-by-URL, which is exactly why nothing hands those URLs out.
 */

export interface StoredObject {
  key: string
  size: number
  contentType: string
}

export interface Storage {
  readonly driver: 'vercel-blob' | 'local'
  put(key: string, data: Uint8Array | string, contentType: string): Promise<StoredObject>
  get(key: string): Promise<Buffer | null>
  getText(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------------------------------------

class VercelBlobStorage implements Storage {
  readonly driver = 'vercel-blob' as const

  constructor(private readonly token: string) {}

  async put(key: string, data: Uint8Array | string, contentType: string): Promise<StoredObject> {
    const { put } = await import('@vercel/blob')
    const body = Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data)
    const result = await put(key, body, {
      access: 'public',
      token: this.token,
      contentType,
      // The key is the identity of the object, so it must not be rewritten. Overwriting is
      // deliberate: a rebuilt version writes over its own key.
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    })
    return { key: result.pathname, size: body.byteLength, contentType }
  }

  async get(key: string): Promise<Buffer | null> {
    const { head } = await import('@vercel/blob')
    try {
      const meta = await head(key, { token: this.token })
      const res = await fetch(meta.url)
      if (!res.ok) return null
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      // head throws BlobNotFoundError for a missing key. Anything else is a real fault.
      if (err instanceof Error && /not\s*found/i.test(err.message)) return null
      throw err
    }
  }

  async getText(key: string): Promise<string | null> {
    const bytes = await this.get(key)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  async delete(key: string): Promise<void> {
    const { del } = await import('@vercel/blob')
    await del(key, { token: this.token }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------

class LocalFileStorage implements Storage {
  readonly driver = 'local' as const

  constructor(private readonly root: string) {}

  private async pathFor(key: string): Promise<string> {
    const { join, resolve, sep } = await import('node:path')
    const full = resolve(join(this.root, key))
    // A key is never allowed to escape the storage root.
    const rootResolved = resolve(this.root)
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      throw new Error(`Refusing to touch a path outside local storage: ${key}`)
    }
    return full
  }

  async put(key: string, data: Uint8Array | string, contentType: string): Promise<StoredObject> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const body = Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data)
    const path = await this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
    return { key, size: body.byteLength, contentType }
  }

  async get(key: string): Promise<Buffer | null> {
    const { readFile } = await import('node:fs/promises')
    try {
      return Buffer.from(await readFile(await this.pathFor(key)))
    } catch {
      return null
    }
  }

  async getText(key: string): Promise<string | null> {
    const bytes = await this.get(key)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import('node:fs/promises')
    await unlink(await this.pathFor(key)).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------

let instance: Storage | null = null

export function storage(): Storage {
  if (instance) return instance
  const cfg = config()

  if (cfg.storageDriver === 'vercel-blob') {
    if (!cfg.blobToken) {
      throw new Error(
        'BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in the Vercel dashboard and add the token, or set STORAGE_DRIVER=local to store files on disk for local development.',
      )
    }
    instance = new VercelBlobStorage(cfg.blobToken)
  } else {
    instance = new LocalFileStorage(cfg.localStorageDir)
  }
  return instance
}

/** Test seam. */
export function setStorageForTests(next: Storage | null): void {
  instance = next
}

/**
 * Response bodies.
 *
 * A Node Buffer is a Uint8Array over an ArrayBufferLike, which the DOM `BodyInit` type does not
 * accept. Copying out the exact byte range gives a plain ArrayBuffer, which it does.
 */
export function toBody(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
