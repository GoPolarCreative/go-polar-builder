import { useRef, useState } from 'react'
import type { AssetRecord } from '../../shared/types'
import type { Palette } from '../../shared/intake'
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
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const uploadMany = async (files: File[]) => {
    setBusy(true)
    setError(null)
    const added: AssetRecord[] = []
    for (const file of files.slice(0, 20 - photos.length)) {
      try {
        const { stats } = await analyseUpload(file, 'photo')
        const { asset } = await api.uploadAsset(jobId, file, 'photo', stats)
        added.push(asset)
      } catch (err) {
        setError(
          `${file.name}: ${
            err instanceof ApiCallError ? (err.detail ?? err.message) : err instanceof Error ? err.message : 'failed'
          }`,
        )
      }
    }
    if (added.length > 0) onChange([...photos, ...added])
    setBusy(false)
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
              {photos.length} of 20 photos. Drag to reorder, the first one is used biggest.
            </p>
            <p className="field-hint">
              Photos straight off your phone work best. We need at least 3 to build the gallery, and we will not
              use stock photos.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost py-1.5 text-sm"
            disabled={busy || photos.length >= 20}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Uploading' : 'Add photos'}
          </button>
        </div>

        {photos.length > 0 ? (
          <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {photos.map((p, i) => (
              <li
                key={p.id}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i) void reorder(dragIndex, i)
                  setDragIndex(null)
                }}
                className="group relative aspect-4/3 cursor-move overflow-hidden rounded-lg border border-ice-200 bg-ice-100"
              >
                <img
                  src={assetUrl(p.id, 'thumb')}
                  alt={p.filename ?? 'Job photo'}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 hidden h-6 w-6 rounded-full bg-white/90 text-sm leading-none text-ice-900 group-hover:block"
                  onClick={async () => {
                    try {
                      await api.deleteAsset(p.id)
                      onChange(photos.filter((x) => x.id !== p.id))
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not remove that photo')
                    }
                  }}
                >
                  &times;
                </button>
                {i === 0 ? (
                  <span className="absolute bottom-1 left-1 rounded bg-ice-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Hero
                  </span>
                ) : null}
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
