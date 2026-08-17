/** Prefixed ids. Readable in logs, and you can tell what a stray id belongs to. */
export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Slug used for R2 keys and filenames. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
}
