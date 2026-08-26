import type { ReactNode } from 'react'

/**
 * Go Polar brand furniture.
 *
 * These three carry most of the identity: the wordmark with its full stop, the ALL CAPS eyebrow
 * above a heading, and a big figure over a small label. They come from itscold.com.au and the
 * values behind them live in index.css, not here.
 */

/** "Go Polar." The full stop is part of the mark and is always the brand blue. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      Go Polar<span className="wordmark-dot">.</span>
    </span>
  )
}

/** Short, ALL CAPS, above a heading. "START HERE". "WHAT HAPPENS NEXT". */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>
}

export function Stat({ figure, label, tone = 'ink' }: { figure: string; label: string; tone?: 'ink' | 'accent' }) {
  return (
    <div>
      <p className={`stat-figure ${tone === 'accent' ? 'text-polar-accent' : ''}`}>{figure}</p>
      <p className="stat-label">{label}</p>
    </div>
  )
}

/** The page header used on every customer-facing screen. */
export function BrandHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="mb-8 flex items-center justify-between gap-4 border-b border-ice-200 pb-5">
      <Wordmark />
      {children}
    </header>
  )
}

/**
 * Contact reality, from the live site. Every screen ends with this, because a tradie halfway
 * through paying for something wants to know a human exists.
 */
export function BrandFooter() {
  return (
    <footer className="mt-12 border-t border-ice-200 pt-5 text-[13px] text-ice-500">
      <p className="mb-1">
        <a className="font-semibold text-ice-700" href="mailto:hello@itscold.com.au">
          hello@itscold.com.au
        </a>
        <span aria-hidden="true" className="px-2 text-ice-500">·</span>
        <a className="font-semibold text-ice-700" href="tel:+61435031044">
          +61 435 031 044
        </a>
      </p>
      <p>Perth, WA &amp; Sunshine Coast, QLD. Mon–Fri, 8am–5pm.</p>
    </footer>
  )
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="field-label">
        {label}
        {required ? <span className="text-polar-accent"> *</span> : null}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function TextInput({
  value,
  onChange,
  invalid,
  ...rest
}: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      className={`input ${invalid ? 'input-invalid' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function TextArea({
  value,
  onChange,
  invalid,
  ...rest
}: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  return (
    <textarea
      {...rest}
      className={`input min-h-32 ${invalid ? 'input-invalid' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  invalid,
}: {
  value: T | undefined
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
  placeholder?: string
  invalid?: boolean
}) {
  return (
    <select
      className={`input ${invalid ? 'input-invalid' : ''}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** Yes / no, as two buttons. A checkbox reads as optional and gets skipped. */
export function YesNo({
  value,
  onChange,
  yesLabel = 'Yes',
  noLabel = 'No',
}: {
  value: boolean
  onChange: (v: boolean) => void
  yesLabel?: string
  noLabel?: string
}) {
  return (
    <div className="flex gap-2">
      <button type="button" className={value ? 'chip-on' : 'chip-off'} onClick={() => onChange(true)}>
        {yesLabel}
      </button>
      <button type="button" className={!value ? 'chip-on' : 'chip-off'} onClick={() => onChange(false)}>
        {noLabel}
      </button>
    </div>
  )
}

export function Banner({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok'
  title?: string
  children: ReactNode
}) {
  const tones = {
    info: 'border-ice-200 bg-ice-100 text-ice-900',
    warn: 'border-amber-300 bg-amber-50 text-amber-900',
    error: 'border-red-300 bg-red-50 text-red-900',
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  } as const
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="[&_p]:mb-1 [&_p:last-child]:mb-0">{children}</div>
    </div>
  )
}

export function CharCounter({ value, min, max }: { value: string; min: number; max: number }) {
  const n = value.trim().length
  const ok = n >= min && n <= max
  return (
    <span className={`text-xs ${ok ? 'text-ice-500' : 'font-semibold text-amber-700'}`}>
      {n} characters. {min} to {max}.
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ice-500">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ice-300 border-t-ice-700" />
      {label}
    </span>
  )
}
