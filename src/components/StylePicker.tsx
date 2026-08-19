import {
  DESIGN_STYLE_OPTIONS,
  TRADE_STYLE_SUGGESTION,
  type DesignStyleId,
  type DesignStyleOption,
  type NamedStyleId,
} from '../../shared/styles'
import { TRADE_LABELS } from '../../shared/trades'
import type { Trade } from '../../shared/trades'

/**
 * The design style choice.
 *
 * Tradies are not designers and will not choose between four paragraphs of adjectives, so every
 * option carries a drawing of the shape it produces: where the header sits, how the hero is laid
 * out, how heavy the type is, how tightly packed the sections are. The thumbnails are inline SVG
 * drawn in the customer's own sampled colours, which costs nothing to serve and makes the point
 * that the style changes the shape of their site and not its colours.
 *
 * Three rules this component exists to keep:
 *   - nothing is preselected, so the choice is always theirs and we can tell the difference
 *     between "they picked modern" and "they never looked at this"
 *   - the trade suggestion is a hint on one card, not a default and not a restriction
 *   - "pick for me" is presented as the recommended path, first and full width, because for most
 *     customers it genuinely is the right answer
 *
 * COPY IS NOT APPROVED. Labels and blurbs come from shared/styles.ts and need Chris's sign off
 * before a customer sees them. See DECISIONS.md D28.
 */

interface ThumbColours {
  primary: string
  accent: string
}

const NAMED = DESIGN_STYLE_OPTIONS.filter(
  (o): o is DesignStyleOption & { id: NamedStyleId } => o.id !== 'auto',
)
const AUTO = DESIGN_STYLE_OPTIONS.find((o) => o.id === 'auto')!

export function StylePicker({
  value,
  onChange,
  trade,
  palette,
  error,
}: {
  value: DesignStyleId | undefined
  onChange: (v: DesignStyleId) => void
  trade: Trade | undefined
  palette: ThumbColours
  error?: string
}) {
  const suggested = trade ? TRADE_STYLE_SUGGESTION[trade] : null

  return (
    <div>
      <span className="field-label">The look of your site</span>
      <p className="field-hint mb-3">
        Same information, same photos, same colours. This is about the shape of it. Have a look at
        the pictures rather than the words.
      </p>

      <button
        type="button"
        aria-pressed={value === 'auto'}
        onClick={() => onChange('auto')}
        className={`mb-3 flex w-full items-center gap-4 rounded-xl border-2 p-4 text-left transition ${
          value === 'auto'
            ? 'border-polar-accent bg-polar-accent/5'
            : 'border-ice-200 bg-white hover:border-ice-400'
        }`}
      >
        <span className="shrink-0">
          <AutoThumb palette={palette} />
        </span>
        <span className="min-w-0">
          <span className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-semibold">{AUTO.label}</span>
            <span className="rounded-full bg-polar-accent px-2 py-0.5 text-xs font-semibold text-white">
              Recommended
            </span>
          </span>
          <span className="block text-sm text-ice-600">{AUTO.blurb}</span>
        </span>
      </button>

      <p className="mb-3 text-sm text-ice-500">Or choose one yourself.</p>

      <div className="grid gap-3 sm:grid-cols-2">
        {NAMED.map((option) => {
          const selected = value === option.id
          const isSuggested = suggested === option.id
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.id)}
              className={`rounded-xl border-2 p-4 text-left transition ${
                selected
                  ? 'border-polar-accent bg-polar-accent/5'
                  : 'border-ice-200 bg-white hover:border-ice-400'
              }`}
            >
              <StyleThumb id={option.id} palette={palette} />
              <span className="mt-3 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{option.label}</span>
                {isSuggested && trade ? (
                  <span className="rounded-full bg-ice-100 px-2 py-0.5 text-xs text-ice-600">
                    Often suits {TRADE_LABELS[trade].toLowerCase()}s
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-sm text-ice-600">{option.blurb}</span>
            </button>
          )
        })}
      </div>

      {error ? <span className="field-error">{error}</span> : null}
      <p className="field-hint mt-3">
        You can change this later. Asking for a different look after the site is built counts as one
        of your changes.
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// The thumbnails
// -----------------------------------------------------------------------------------------------

/**
 * Each drawing is the real layout in miniature, not decoration: the header treatment, the hero
 * composition, the heading weight, the corner radius and the section density all match what the
 * renderer actually produces for that style. If a style changes, its drawing changes with it.
 */
function StyleThumb({ id, palette }: { id: NamedStyleId; palette: ThumbColours }) {
  const shells = {
    industrial: <Industrial palette={palette} />,
    modern: <Modern palette={palette} />,
    established: <Established palette={palette} />,
    direct: <Direct palette={palette} />,
  }
  return (
    <span className="block overflow-hidden rounded-lg border border-ice-200">
      <svg viewBox="0 0 200 130" className="block h-auto w-full" role="img" aria-hidden="true">
        <rect width="200" height="130" fill="#ffffff" />
        {shells[id]}
      </svg>
    </span>
  )
}

/** Heavy, square, dark. Condensed headings as thick bars, an accent band across the bottom. */
function Industrial({ palette }: { palette: ThumbColours }) {
  return (
    <g>
      <rect x="0" y="0" width="200" height="14" fill={palette.primary} />
      <rect x="0" y="14" width="200" height="2" fill={palette.accent} />
      <rect x="6" y="4" width="26" height="6" fill={palette.accent} />
      <rect x="150" y="4" width="44" height="6" fill="#ffffff" opacity="0.5" />

      <rect x="0" y="16" width="200" height="70" fill={palette.primary} opacity="0.92" />
      <rect x="10" y="26" width="86" height="10" fill="#ffffff" />
      <rect x="10" y="40" width="64" height="10" fill="#ffffff" />
      <rect x="10" y="58" width="40" height="9" fill={palette.accent} />
      <rect x="56" y="58" width="34" height="9" fill="#ffffff" opacity="0.35" />
      <rect x="110" y="24" width="80" height="54" fill="#ffffff" />
      <rect x="116" y="30" width="68" height="5" fill={palette.primary} opacity="0.3" />
      <rect x="116" y="40" width="68" height="8" fill="#eef1f4" />
      <rect x="116" y="52" width="68" height="8" fill="#eef1f4" />
      <rect x="116" y="64" width="40" height="8" fill={palette.accent} />

      <rect x="0" y="86" width="200" height="12" fill={palette.accent} />
      <rect x="10" y="90" width="34" height="4" fill="#000000" opacity="0.55" />
      <rect x="60" y="90" width="34" height="4" fill="#000000" opacity="0.55" />
      <rect x="110" y="90" width="34" height="4" fill="#000000" opacity="0.55" />

      <rect x="10" y="106" width="56" height="16" fill="#eef1f4" />
      <rect x="72" y="106" width="56" height="16" fill="#eef1f4" />
      <rect x="134" y="106" width="56" height="16" fill="#eef1f4" />
    </g>
  )
}

/** Light and airy. Transparent header, the form lifted into a rounded card beside the copy. */
function Modern({ palette }: { palette: ThumbColours }) {
  return (
    <g>
      <rect x="0" y="0" width="200" height="76" rx="0" fill={palette.primary} opacity="0.9" />
      <rect x="10" y="6" width="22" height="5" rx="2.5" fill="#ffffff" opacity="0.9" />
      <rect x="150" y="6" width="40" height="5" rx="2.5" fill="#ffffff" opacity="0.45" />

      <rect x="12" y="28" width="70" height="8" rx="4" fill="#ffffff" />
      <rect x="12" y="41" width="52" height="8" rx="4" fill="#ffffff" />
      <rect x="12" y="56" width="30" height="4" rx="2" fill="#ffffff" opacity="0.5" />
      <rect x="46" y="56" width="30" height="4" rx="2" fill="#ffffff" opacity="0.5" />

      <rect x="112" y="22" width="80" height="62" rx="8" fill="#d8dee5" opacity="0.6" />
      <rect x="110" y="20" width="80" height="62" rx="8" fill="#ffffff" />
      <rect x="118" y="28" width="50" height="5" rx="2.5" fill={palette.primary} opacity="0.35" />
      <rect x="118" y="39" width="64" height="9" rx="4" fill="#f1f4f7" />
      <rect x="118" y="52" width="64" height="9" rx="4" fill="#f1f4f7" />
      <rect x="118" y="65" width="40" height="9" rx="4" fill={palette.accent} />

      <rect x="14" y="98" width="52" height="20" rx="8" fill="#f4f6f8" />
      <rect x="74" y="98" width="52" height="20" rx="8" fill="#f4f6f8" />
      <rect x="134" y="98" width="52" height="20" rx="8" fill="#f4f6f8" />
    </g>
  )
}

/** Warm and centred. A serif suggestion in the heading bars, rounded panel underneath. */
function Established({ palette }: { palette: ThumbColours }) {
  return (
    <g>
      <rect x="0" y="0" width="200" height="16" fill="#f3efe7" />
      <rect x="0" y="16" width="200" height="1" fill="#e0d9cc" />
      <rect x="10" y="6" width="24" height="5" rx="2" fill={palette.primary} />
      <rect x="152" y="6" width="38" height="4" rx="2" fill={palette.primary} opacity="0.4" />

      <rect x="0" y="17" width="200" height="60" fill={palette.primary} opacity="0.88" />
      <rect x="62" y="27" width="76" height="9" rx="2" fill="#ffffff" />
      <rect x="76" y="40" width="48" height="9" rx="2" fill="#ffffff" />
      <rect x="66" y="56" width="26" height="4" rx="2" fill="#ffffff" opacity="0.55" />
      <rect x="98" y="56" width="16" height="4" rx="2" fill="#ffffff" opacity="0.55" />
      <rect x="120" y="56" width="20" height="4" rx="2" fill="#ffffff" opacity="0.55" />
      <rect x="70" y="64" width="30" height="8" rx="4" fill={palette.accent} />

      <rect x="40" y="82" width="120" height="22" rx="10" fill="#ffffff" stroke="#e0d9cc" />
      <rect x="50" y="89" width="60" height="8" rx="4" fill="#f6f2ea" />
      <rect x="118" y="89" width="32" height="8" rx="4" fill={palette.accent} opacity="0.85" />

      <rect x="14" y="110" width="52" height="14" rx="7" fill="#f6f2ea" />
      <rect x="74" y="110" width="52" height="14" rx="7" fill="#f6f2ea" />
      <rect x="134" y="110" width="52" height="14" rx="7" fill="#f6f2ea" />
    </g>
  )
}

/** Almost nothing in it. Hairline header, small centred type, a rule, a lot of room. */
function Direct({ palette }: { palette: ThumbColours }) {
  return (
    <g>
      <rect x="0" y="0" width="200" height="88" fill={palette.primary} opacity="0.86" />
      <rect x="12" y="8" width="18" height="3" fill="#ffffff" opacity="0.9" />
      <rect x="158" y="8" width="30" height="2" fill="#ffffff" opacity="0.5" />
      <rect x="0" y="18" width="200" height="0.75" fill="#ffffff" opacity="0.3" />

      <rect x="78" y="32" width="44" height="3" fill={palette.accent} opacity="0.9" />
      <rect x="62" y="42" width="76" height="6" fill="#ffffff" />
      <rect x="84" y="56" width="32" height="1" fill={palette.accent} />
      <rect x="72" y="64" width="56" height="3" fill="#ffffff" opacity="0.6" />
      <rect x="86" y="72" width="28" height="6" fill="#ffffff" opacity="0.9" />

      <rect x="70" y="100" width="60" height="2.5" fill="#c9cfd6" />
      <rect x="24" y="112" width="44" height="2" fill="#e5e9ed" />
      <rect x="78" y="112" width="44" height="2" fill="#e5e9ed" />
      <rect x="132" y="112" width="44" height="2" fill="#e5e9ed" />
    </g>
  )
}

/** Four corners of the four styles, so "pick for me" reads as all of them rather than none. */
function AutoThumb({ palette }: { palette: ThumbColours }) {
  return (
    <span className="block overflow-hidden rounded-lg border border-ice-200">
      <svg viewBox="0 0 108 72" className="block h-auto w-[108px]" role="img" aria-hidden="true">
        <rect width="108" height="72" fill="#ffffff" />

        <rect x="0" y="0" width="53" height="35" fill={palette.primary} opacity="0.92" />
        <rect x="6" y="8" width="26" height="6" fill="#ffffff" />
        <rect x="6" y="17" width="18" height="6" fill="#ffffff" />
        <rect x="0" y="29" width="53" height="6" fill={palette.accent} />

        <rect x="55" y="0" width="53" height="35" fill={palette.primary} opacity="0.55" />
        <rect x="60" y="9" width="22" height="4" rx="2" fill="#ffffff" />
        <rect x="60" y="16" width="14" height="4" rx="2" fill="#ffffff" />
        <rect x="84" y="8" width="20" height="20" rx="4" fill="#ffffff" />

        <rect x="0" y="37" width="53" height="35" fill="#f3efe7" />
        <rect x="14" y="46" width="26" height="5" rx="2" fill={palette.primary} />
        <rect x="19" y="54" width="16" height="4" rx="2" fill={palette.primary} opacity="0.5" />
        <rect x="14" y="62" width="26" height="6" rx="3" fill={palette.accent} opacity="0.8" />

        <rect x="55" y="37" width="53" height="35" fill={palette.primary} opacity="0.75" />
        <rect x="70" y="48" width="24" height="3" fill="#ffffff" />
        <rect x="76" y="55" width="12" height="1" fill={palette.accent} />
        <rect x="72" y="60" width="20" height="2" fill="#ffffff" opacity="0.6" />
      </svg>
    </span>
  )
}
