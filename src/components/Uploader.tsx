import { useRef, useState } from 'react'
import type { AssetRecord } from '../../shared/types'
import { MAX_PHOTOS, type Palette } from '../../shared/intake'
import { api, assetUrl, ApiCallError } from '../lib/api'
import { analyseUpload } from '../lib/image'
import { Banner } from './ui'

const ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp'

/**
 * Upload to R2 with client-side analysis on the way through.
 *
 * The analysis is what lets the gap audit tell a real logo from a mockup render, and it is what
 * samples the brand palette. Both happen before the file leaves the browser, so a slow upload
 * does not delay the swatches appearing.
 */

export function LogoUploader({
  jobId,
  logo,
  onChange,
  onPalette,
}: {
  jobId: string
  logo: AssetRecord | null
  onChange: (asset: AssetRecord | null) => void
  onPalette: (palette: Palette) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    const oversize = tooLargeMessage(file)
    if (oversize) {
      setError(oversize)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { stats, palette } = await analyseUpload(file, 'logo')
      const { asset } = await api.uploadAsset(jobId, file, 'logo', stats)
      onChange(asset)
      if (palette) onPalette(palette)
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? (err.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : 'Upload failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-4 rounded-xl border border-dashed border-ice-300 bg-white p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void upload(file)
        }}
      >
        {logo ? (
          <img
            src={assetUrl(logo.id, 'web')}
            alt="Your logo"
            className="h-16 w-auto max-w-40 object-contain"
          />
        ) : (
          <div className="grid h-16 w-16 place-items-center rounded-lg bg-ice-100 text-xs text-ice-500">
            No logo
          </div>
        )}
        <div className="flex-1">
          <p className="text-sm font-medium">
            {logo ? (logo.filename ?? 'Logo uploaded') : 'Drop your logo here, or choose a file'}
          </p>
          <p className="field-hint">PNG, JPG, SVG or WebP. Up to 10MB. A transparent PNG or an SVG works best.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn-ghost py-1.5 text-sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? 'Working' : logo ? 'Replace' : 'Choose file'}
            </button>
            {logo ? (
              <button
                type="button"
                className="btn-ghost py-1.5 text-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.deleteAsset(logo.id)
                    onChange(null)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not remove the logo')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
            e.target.value = ''
          }}
        />
      </div>
      {error ? (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
    </div>
  )
}

/*
 * THE SIZE CHECK HAPPENS HERE, BEFORE THE FILE LEAVES THE BROWSER.
 *
 * The server has its own 10MB limit with a friendly message attached, and that message has never
 * once been seen. Vercel refuses a request body over about 4.5MB at the platform edge, so an
 * oversized photo never reaches our handler: the customer got "Request Entity Too Large
 * FUNCTION_PAYLOAD_TOO_LARGE syd1::2mvxs-1787954708213-3993ee00318a", which tells a tradie
 * nothing at all and looks like the site is broken.
 *
 * Checking in the browser is the only place the real message can be given, because it is the only
 * place we still have the file when something can still be done about it.
 */
const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024

function tooLargeMessage(file: File): string | null {
  if (file.size <= UPLOAD_LIMIT_BYTES) return null
  const mb = (file.size / 1024 / 1024).toFixed(1)
  return `${file.name} is ${mb}MB, which is too big to upload. Resize it to under 4MB and add it again. Photos straight off a phone are often 5 to 10MB, so shrinking it on your phone before you upload is usually the quickest fix.`
}

export function PhotoUploader({
  jobId,
  photos,
  onChange,
}: {
  jobId: string
  photos: AssetRecord[]
  onChange: (photos: AssetRecord[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  /*
   * PROGRESS IS COUNTED IN FILES FINISHED, NOT BYTES SENT.
   *
   * The uploads run one after another, so "3 of 8" is a fact this loop actually knows. A byte
   * level bar would need XHR upload events instead of fetch, and a bar that eases to 90% and waits
   * is a lie that makes a slow upload feel broken rather than slow. Photos off a phone are several
   * megabytes each, so on a site van connection this runs for a while and the old version showed
   * nothing but the word "Uploading".
   */
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null)

  const uploadMany = async (files: File[]) => {
    /*
     * THE CAP WAS ALREADY HERE. WHAT WAS MISSING WAS SAYING SO.
     *
     * Dropping twenty five photos onto an empty uploader uploaded twenty and discarded five
     * without a word, so the customer saw a number they did not choose and no reason for it.
     * Silently delivering less than was asked for is the same failure as the paid page that
     * was never built: recoverable, invisible, and found by the customer rather than by us.
     */
    const room = Math.max(0, MAX_PHOTOS - photos.length)
    const queue = files.slice(0, room)
    const skipped = files.length - queue.length
    let problem = false
    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: queue.length, name: queue[0]?.name ?? '' })

    const added: AssetRecord[] = []
    for (const [i, file] of queue.entries()) {
      setProgress({ done: i, total: queue.length, name: file.name })
      const oversize = tooLargeMessage(file)
      if (oversize) {
        setError(oversize)
        problem = true
        setProgress({ done: i + 1, total: queue.length, name: file.name })
        continue
      }
      try {
        const { stats } = await analyseUpload(file, 'photo')
        const { asset } = await api.uploadAsset(jobId, file, 'photo', stats)
        added.push(asset)
      } catch (err) {
        problem = true
        setError(
          `${file.name}: ${
            err instanceof ApiCallError ? (err.detail ?? err.message) : err instanceof Error ? err.message : 'failed'
          }`,
        )
      }
      // Counted after the attempt, so a file that failed still moves the bar. It is a measure of
      // how far through the queue we are, not of how many worked.
      setProgress({ done: i + 1, total: queue.length, name: file.name })
    }

    if (added.length > 0) onChange([...photos, ...added])
    // Only when nothing worse happened: a file that was too big is the more useful message.
    if (skipped > 0 && !problem) {
      setError(
        skipped +
          (skipped === 1 ? ' photo was' : ' photos were') +
          ' not added, because ' +
          MAX_PHOTOS +
          ' is the most a website uses. Remove some and add them again if you want different ones.',
      )
    }
    setBusy(false)
    setProgress(null)
  }

  /**
   * Removing a photo, without making them wait to find out it worked.
   *
   * Deleting an asset means a round trip to blob storage, which is slow enough that the tile used
   * to sit there looking untouched for a second or more. So people clicked again. One photo in
   * testing was deleted four times in the same second, and the customer's read on it was that
   * deleting takes forever.
   *
   * The tile now goes on removing the moment it is clicked, the button disables, and a repeat
   * click cannot fire. If the server refuses, the photo comes back and says why.
   */
  const remove = async (photo: AssetRecord) => {
    if (removing.has(photo.id)) return
    setRemoving((r) => new Set(r).add(photo.id))
    setError(null)

    try {
      await api.deleteAsset(photo.id)
      onChange(photos.filter((x) => x.id !== photo.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that photo')
    } finally {
      setRemoving((r) => {
        const next = new Set(r)
        next.delete(photo.id)
        return next
      })
    }
  }

  const reorder = async (from: number, to: number) => {
    const next = [...photos]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    onChange(next)
    try {
      await api.reorderAssets(
        jobId,
        next.map((p) => p.id),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the new order')
    }
  }

  return (
    <div>
      <div
        className="rounded-xl border border-dashed border-ice-300 bg-white p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (e.dataTransfer.files.length > 0) void uploadMany([...e.dataTransfer.files])
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {photos.length} of {MAX_PHOTOS} photos. The first one is used biggest.
            </p>
            <p className="field-hint">
              Photos straight off your phone work best. We need at least 3 to build the gallery, and we will not
              use stock photos.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost py-1.5 text-sm"
            disabled={busy || photos.length >= MAX_PHOTOS}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Uploading' : 'Add photos'}
          </button>
        </div>

        {progress ? (
          <div className="mt-3" role="status" aria-live="polite">
            <div className="flex items-baseline justify-between gap-2 text-xs text-ice-600">
              <span className="truncate">{progress.name}</span>
              <span className="shrink-0 tabular-nums">
                {progress.done} of {progress.total}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-ice-100">
              <div
                className="h-full rounded-full bg-ice-700 transition-[width] duration-300"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
            <p className="field-hint mt-1">
              Big photos off a phone take a moment each. Leave this open until it finishes.
            </p>
          </div>
        ) : null}

        {photos.length > 0 ? (
          <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {photos.map((p, i) => (
              <li
                key={p.id}
                className="relative aspect-4/3 overflow-hidden rounded-lg border border-ice-200 bg-ice-100"
              >
                <img
                  src={assetUrl(p.id, 'thumb')}
                  alt={p.filename ?? 'Job photo'}
                  className={`h-full w-full object-cover transition-opacity ${
                    removing.has(p.id) ? 'opacity-30' : ''
                  }`}
                />

                {/*
                 * Always visible, never hover-only. These controls used to appear on
                 * group-hover, which meant that on a phone — where every one of these
                 * customers is — there was no way to remove a photo at all.
                 */}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-ice-900/70 px-1 py-1">
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      aria-label="Move photo earlier"
                      className="h-6 w-6 rounded bg-white/90 text-sm leading-none text-ice-900 disabled:opacity-30"
                      disabled={i === 0 || busy}
                      onClick={() => void reorder(i, i - 1)}
                    >
                      &lsaquo;
                    </button>
                    <button
                      type="button"
                      aria-label="Move photo later"
                      className="h-6 w-6 rounded bg-white/90 text-sm leading-none text-ice-900 disabled:opacity-30"
                      disabled={i === photos.length - 1 || busy}
                      onClick={() => void reorder(i, i + 1)}
                    >
                      &rsaquo;
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label="Remove photo"
                    className="h-6 w-6 rounded bg-white/90 text-sm leading-none text-ice-900 disabled:opacity-40"
                    disabled={removing.has(p.id)}
                    onClick={() => void remove(p)}
                  >
                    &times;
                  </button>
                </div>

                {i === 0 ? (
                  <span className="absolute top-1 left-1 rounded bg-ice-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Hero
                  </span>
                ) : (
                  <button
                    type="button"
                    className="absolute top-1 left-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-ice-900"
                    disabled={busy}
                    onClick={() => void reorder(i, 0)}
                  >
                    Make hero
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadMany([...e.target.files])
            e.target.value = ''
          }}
        />
      </div>
      {error ? (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
    </div>
  )
}
