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

  /*
   * PRIVATE ACCESS, EVERYWHERE.
   *
   * The store holds uploaded photos, every generated version of a customer's website, and the
   * discharge zips. None of that should be readable by anyone who guesses a URL, so the store is
   * created private and every object is written private to match.
   *
   * This has to agree with how the store itself was created. Writing with access: 'public' to a
   * private store is refused outright — "Cannot use public access on a private store" — and reads
   * then have to go through the SDK with the token rather than fetching a URL, because a private
   * blob has no publicly fetchable URL, which is the entire point of it.
   *
   * Serving is unaffected. Images on a published site are proxied by the site-asset route, which
   * reads through here and sets a one year immutable cache header, so the edge answers repeat
   * requests without touching storage or this function.
   */
  async put(key: string, data: Uint8Array | string, contentType: string): Promise<StoredObject> {
    const { put } = await import('@vercel/blob')
    const body = Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data)
    const result = await put(key, body, {
      access: 'private',
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
    const { get } = await import('@vercel/blob')
    try {
      const result = await get(key, { access: 'private', token: this.token })
      // null is a missing blob. A 304 cannot happen here because no conditional header is sent,
      // but it carries no body either way, so both mean "nothing to return" rather than a fault.
      if (!result || result.statusCode !== 200) return null
      return Buffer.from(await new Response(result.stream).arrayBuffer())
    } catch (err) {
      // A missing key is a null, not a fault. Anything else is real and must not be swallowed.
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
