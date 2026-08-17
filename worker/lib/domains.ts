import { connect } from 'cloudflare:sockets'

/**
 * Domain intelligence for the go-live flow. Brief s8 screen 2.
 *
 * Three mechanisms, none of which need an API key (DECISIONS.md D6):
 *   - RDAP over HTTPS for registration data. rdap.org routes to the right registry, and auDA
 *     runs RDAP for .au.
 *   - DNS over HTTPS at Cloudflare for MX, NS and A records.
 *   - WHOIS on port 43 through cloudflare:sockets when RDAP has nothing, which is still the
 *     case for some ccTLDs.
 *
 * The point of the screen is NOT to interrogate the customer. "Do not ask the customer where
 * their domain is hosted, they do not know, and the lookup is more reliable than the answer."
 * So everything below turns raw records into a plain sentence they can confirm or correct.
 */

export interface DnsRecord {
  type: string
  value: string
  priority?: number
}

export interface DomainReport {
  domain: string
  /** null when we genuinely could not tell, which is different from "not registered". */
  registered: boolean | null
  registrar: string | null
  registrarUrl: string | null
  createdAt: string | null
  expiresAt: string | null
  statuses: string[]
  nameservers: string[]
  mx: DnsRecord[]
  a: string[]
  /** Best guess at who is serving the website, from the nameservers and A records. */
  likelyHost: string | null
  /** Best guess at who is handling the mail, from the MX records. */
  likelyMailProvider: string | null
  /** What the customer is shown, in plain English. */
  summary: string[]
  /** Anything that failed, surfaced rather than swallowed. */
  problems: string[]
  source: Array<'rdap' | 'whois' | 'dns'>
}

const DOH = 'https://cloudflare-dns.com/dns-query'
const TIMEOUT_MS = 8000

export function normaliseDomain(input: string): string | null {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null
  if (trimmed.length > 253) return null
  return trimmed
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------------------------
// DNS over HTTPS
// ---------------------------------------------------------------------------------------------

export async function lookupDns(domain: string, type: 'MX' | 'NS' | 'A' | 'TXT'): Promise<DnsRecord[]> {
  const res = await withTimeout((signal) =>
    fetch(`${DOH}?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal,
    }),
  )
  if (!res.ok) throw new Error(`DNS lookup for ${type} returned ${res.status}`)

  const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> }
  const answers = json.Answer ?? []

  return answers.map((a) => {
    const data = a.data.trim().replace(/\.$/, '')
    if (type === 'MX') {
      const [priority, host] = data.split(/\s+/)
      return { type, value: (host ?? '').replace(/\.$/, ''), priority: Number(priority) }
    }
    return { type, value: data }
  })
}

// ---------------------------------------------------------------------------------------------
// RDAP
// ---------------------------------------------------------------------------------------------

interface RdapResponse {
  ldhName?: string
  status?: string[]
  events?: Array<{ eventAction?: string; eventDate?: string }>
  nameservers?: Array<{ ldhName?: string }>
  entities?: Array<{
    roles?: string[]
    vcardArray?: unknown
    links?: Array<{ href?: string }>
    publicIds?: Array<{ identifier?: string }>
  }>
}

/**
 * IANA publishes the authoritative map of TLD to RDAP service. Guessing hostnames does not work:
 * .au is served from rdap.cctld.au, not from anything with "auda" in it, and rdap.org's redirect
 * service answers 403 to some callers. Fetch the bootstrap, cache it for the isolate's life, and
 * use what it says.
 */
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
const USER_AGENT = 'GoPolarBuilder/1.0 (+https://www.itscold.com.au)'

interface Bootstrap {
  services: Array<[string[], string[]]>
}

let bootstrapCache: { at: number; map: Map<string, string[]> } | null = null
const BOOTSTRAP_TTL_MS = 6 * 60 * 60 * 1000

async function rdapBases(tld: string): Promise<string[]> {
  const now = Date.now()
  if (!bootstrapCache || now - bootstrapCache.at > BOOTSTRAP_TTL_MS) {
    const res = await withTimeout((signal) =>
      fetch(BOOTSTRAP_URL, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal }),
    )
    if (!res.ok) throw new Error(`RDAP bootstrap returned ${res.status}`)
    const json = (await res.json()) as Bootstrap
    const map = new Map<string, string[]>()
    for (const [tlds, urls] of json.services) {
      for (const entry of tlds) map.set(entry.toLowerCase(), urls)
    }
    bootstrapCache = { at: now, map }
  }
  return bootstrapCache.map.get(tld.toLowerCase()) ?? []
}

async function rdapEndpoints(domain: string): Promise<string[]> {
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  const endpoints: string[] = []

  try {
    for (const base of await rdapBases(tld)) {
      endpoints.push(`${base.replace(/\/$/, '')}/domain/${domain}`)
    }
  } catch {
    // Bootstrap unavailable. The redirect service below still gives us a shot.
  }

  endpoints.push(`https://rdap.org/domain/${domain}`)
  return endpoints
}

/** Returns the parsed RDAP record, null when the domain is not registered, or throws. */
async function lookupRdap(domain: string): Promise<RdapResponse | null> {
  const errors: string[] = []

  for (const url of await rdapEndpoints(domain)) {
    try {
      const res = await withTimeout((signal) =>
        fetch(url, {
          headers: { accept: 'application/rdap+json', 'user-agent': USER_AGENT },
          signal,
        }),
      )
      // 404 from an RDAP server is a real answer: nobody has registered it.
      if (res.status === 404) return null
      if (!res.ok) {
        errors.push(`${new URL(url).host} returned ${res.status}`)
        continue
      }
      return (await res.json()) as RdapResponse
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }

  // Every endpoint reported, not just the last one, so a failure is diagnosable.
  throw new Error(errors.length > 0 ? errors.join('; ') : 'No RDAP endpoint available for this TLD')
}

function registrarFromRdap(rdap: RdapResponse): { name: string | null; url: string | null } {
  const entity = rdap.entities?.find((e) => e.roles?.includes('registrar'))
  if (!entity) return { name: null, url: null }

  // vcardArray is ["vcard", [["version",...], ["fn", {}, "text", "Registrar Name"], ...]]
  let name: string | null = entity.publicIds?.[0]?.identifier ?? null
  const vcard = entity.vcardArray as unknown[] | undefined
  if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
    for (const field of vcard[1] as unknown[]) {
      if (Array.isArray(field) && field[0] === 'fn' && typeof field[3] === 'string') {
        name = field[3]
        break
      }
    }
  }
  return { name, url: entity.links?.[0]?.href ?? null }
}

// ---------------------------------------------------------------------------------------------
// WHOIS over TCP, the fallback
// ---------------------------------------------------------------------------------------------

const WHOIS_SERVERS: Record<string, string> = {
  au: 'whois.auda.org.au',
  com: 'whois.verisign-grs.com',
  net: 'whois.verisign-grs.com',
  org: 'whois.pir.org',
  io: 'whois.nic.io',
  nz: 'whois.irs.net.nz',
}

export async function lookupWhois(domain: string): Promise<string | null> {
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  const server = WHOIS_SERVERS[tld] ?? (domain.endsWith('.au') ? WHOIS_SERVERS.au : null)
  if (!server) return null

  const socket = connect({ hostname: server, port: 43 })
  try {
    const writer = socket.writable.getWriter()
    await writer.write(new TextEncoder().encode(`${domain}\r\n`))
    await writer.close()

    const reader = socket.readable.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
        // WHOIS responses are small. Anything past this is not a WHOIS response.
        if (total > 64_000) break
      }
    }

    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(merged)
  } finally {
    await socket.close().catch(() => undefined)
  }
}

function parseWhois(text: string): { registrar: string | null; statuses: string[]; nameservers: string[] } {
  const line = (label: RegExp): string | null => {
    const match = text.split('\n').find((l) => label.test(l))
    return match ? (match.split(':').slice(1).join(':').trim() || null) : null
  }
  const all = (label: RegExp): string[] =>
    text
      .split('\n')
      .filter((l) => label.test(l))
      .map((l) => l.split(':').slice(1).join(':').trim().toLowerCase())
      .filter(Boolean)

  return {
    registrar: line(/^\s*Registrar(\s+Name)?\s*:/i),
    statuses: all(/^\s*(Domain )?Status\s*:/i),
    nameservers: all(/^\s*Name Server\s*:/i),
  }
}

// ---------------------------------------------------------------------------------------------
// Interpretation: turn records into something a tradie can confirm
// ---------------------------------------------------------------------------------------------

const HOST_SIGNATURES: Array<[RegExp, string]> = [
  [/cloudflare/i, 'Cloudflare'],
  [/awsdns|amazonaws/i, 'Amazon Web Services'],
  [/godaddy|domaincontrol/i, 'GoDaddy'],
  [/wixdns|wix\.com/i, 'Wix'],
  [/squarespace/i, 'Squarespace'],
  [/shopify/i, 'Shopify'],
  [/wordpress|wpengine|wp\.com/i, 'WordPress'],
  [/ventraip|synergywholesale/i, 'VentraIP or Synergy Wholesale'],
  [/crazydomains/i, 'Crazy Domains'],
  [/netregistry|melbourneit/i, 'Netregistry or Melbourne IT'],
  [/digitalpacific|panthur/i, 'Digital Pacific'],
  [/siteground/i, 'SiteGround'],
  [/hostinger/i, 'Hostinger'],
  [/vercel/i, 'Vercel'],
  [/netlify/i, 'Netlify'],
  [/weebly/i, 'Weebly'],
]

const MAIL_SIGNATURES: Array<[RegExp, string]> = [
  [/google|googlemail|aspmx/i, 'Google Workspace'],
  [/outlook|microsoft|office365/i, 'Microsoft 365'],
  [/zoho/i, 'Zoho Mail'],
  [/protonmail/i, 'Proton Mail'],
  [/mailgun|sendgrid/i, 'a bulk sending service, not a mailbox'],
  [/secureserver|godaddy/i, 'GoDaddy email'],
  [/ventraip|synergy/i, 'VentraIP or Synergy Wholesale email'],
  [/bigpond|telstra/i, 'Telstra'],
]

function match(signatures: Array<[RegExp, string]>, values: string[]): string | null {
  for (const [pattern, name] of signatures) {
    if (values.some((v) => pattern.test(v))) return name
  }
  return null
}

/**
 * The full picture for a domain the customer says they own.
 *
 * Nothing here throws: a lookup that fails becomes a line in `problems` and the rest of the
 * report still comes back. A half-answer plus an honest note beats an error page when someone is
 * halfway through going live.
 */
export async function inspectDomain(input: string): Promise<DomainReport> {
  const domain = normaliseDomain(input)
  if (!domain) throw new Error(`"${input}" does not look like a domain. Enter it like yourbusiness.com.au`)

  const report: DomainReport = {
    domain,
    registered: null,
    registrar: null,
    registrarUrl: null,
    createdAt: null,
    expiresAt: null,
    statuses: [],
    nameservers: [],
    mx: [],
    a: [],
    likelyHost: null,
    likelyMailProvider: null,
    summary: [],
    problems: [],
    source: [],
  }

  const [rdapResult, nsResult, mxResult, aResult] = await Promise.allSettled([
    lookupRdap(domain),
    lookupDns(domain, 'NS'),
    lookupDns(domain, 'MX'),
    lookupDns(domain, 'A'),
  ])

  if (rdapResult.status === 'fulfilled') {
    const rdap = rdapResult.value
    if (rdap === null) {
      report.registered = false
    } else {
      report.registered = true
      report.source.push('rdap')
      const registrar = registrarFromRdap(rdap)
      report.registrar = registrar.name
      report.registrarUrl = registrar.url
      report.statuses = rdap.status ?? []
      report.nameservers = (rdap.nameservers ?? [])
        .map((n) => (n.ldhName ?? '').toLowerCase())
        .filter(Boolean)
      for (const event of rdap.events ?? []) {
        if (event.eventAction === 'registration') report.createdAt = event.eventDate ?? null
        if (event.eventAction === 'expiration') report.expiresAt = event.eventDate ?? null
      }
    }
  } else {
    report.problems.push(
      `Registration lookup did not answer: ${rdapResult.reason instanceof Error ? rdapResult.reason.message : 'unknown error'}`,
    )
  }

  // WHOIS fallback, only when RDAP gave us nothing useful.
  if (report.registered !== false && !report.registrar) {
    try {
      const raw = await lookupWhois(domain)
      if (raw) {
        const parsed = parseWhois(raw)
        report.source.push('whois')
        report.registrar = report.registrar ?? parsed.registrar
        if (report.statuses.length === 0) report.statuses = parsed.statuses
        if (report.nameservers.length === 0) report.nameservers = parsed.nameservers
        if (report.registered === null && (parsed.registrar || parsed.nameservers.length > 0)) {
          report.registered = true
        }
      }
    } catch (err) {
      report.problems.push(
        `WHOIS did not answer: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
  }

  if (nsResult.status === 'fulfilled' && nsResult.value.length > 0) {
    report.source.push('dns')
    if (report.nameservers.length === 0) report.nameservers = nsResult.value.map((r) => r.value.toLowerCase())
  }
  if (mxResult.status === 'fulfilled') report.mx = mxResult.value.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  if (aResult.status === 'fulfilled') report.a = aResult.value.map((r) => r.value)

  for (const result of [nsResult, mxResult, aResult]) {
    if (result.status === 'rejected') {
      report.problems.push(
        `A DNS lookup did not answer: ${result.reason instanceof Error ? result.reason.message : 'unknown error'}`,
      )
    }
  }

  report.likelyHost = match(HOST_SIGNATURES, [...report.nameservers, ...report.a])
  report.likelyMailProvider = match(
    MAIL_SIGNATURES,
    report.mx.map((r) => r.value),
  )

  report.summary = summarise(report)
  return report
}

function summarise(r: DomainReport): string[] {
  const lines: string[] = []

  if (r.registered === false) {
    lines.push(`${r.domain} is not registered. Nobody owns it, so it is available to buy.`)
    return lines
  }
  if (r.registered === null) {
    lines.push(
      `We could not get a straight answer about ${r.domain} from the registry just now. One of our team will check it by hand.`,
    )
  }

  if (r.registrar) lines.push(`It is registered with ${r.registrar}. That is who it is bought from.`)
  else lines.push('We could not tell which registrar it sits with. Our team will check that by hand.')

  if (r.expiresAt) {
    const when = new Date(r.expiresAt)
    if (!Number.isNaN(when.getTime())) {
      lines.push(`The registration runs until ${when.toLocaleDateString('en-AU')}.`)
    }
  }

  if (r.nameservers.length > 0) {
    lines.push(
      r.likelyHost
        ? `Its nameservers point at ${r.likelyHost}, which is most likely who hosts the website at the moment.`
        : `Its nameservers are ${r.nameservers.slice(0, 2).join(' and ')}. That is where the website is pointed.`,
    )
  } else {
    lines.push('It has no nameservers set, so nothing is being served from it right now.')
  }

  if (r.mx.length > 0) {
    lines.push(
      r.likelyMailProvider
        ? `Email on this domain is handled by ${r.likelyMailProvider}. We will not touch that.`
        : `Email is pointed at ${r.mx[0]!.value}. We will leave that exactly as it is.`,
    )
  } else {
    lines.push('There is no email set up on this domain at the moment.')
  }

  if (r.statuses.some((s) => /clienttransferprohibited|serverTransferProhibited/i.test(s))) {
    lines.push(
      'It is currently locked against transfer, which is normal. It only matters if you decide to move it later.',
    )
  }

  return lines
}

/** Availability for branch B. RDAP 404 is a real "nobody has this". */
export async function checkAvailability(
  input: string,
): Promise<{ domain: string; available: boolean | null; detail: string }> {
  const domain = normaliseDomain(input)
  if (!domain) {
    return { domain: input, available: null, detail: 'That does not look like a domain name.' }
  }

  try {
    const rdap = await lookupRdap(domain)
    if (rdap === null) {
      return { domain, available: true, detail: 'Available. Nobody has registered it.' }
    }
    return { domain, available: false, detail: 'Already taken. Try a different one.' }
  } catch (err) {
    // Never guess. An unknown answer is reported as unknown.
    return {
      domain,
      available: null,
      detail: `We could not check that one just now (${err instanceof Error ? err.message : 'lookup failed'}). Our team will confirm it by hand.`,
    }
  }
}

/**
 * auDA eligibility gate for .au. Brief s8 branch B: "If .com.au or .au, ABN and entity name are
 * required at this point. Collect them here or you will chase every single one later."
 */
export function requiresAuEligibility(domain: string): boolean {
  return /\.au$/i.test(domain.trim())
}
