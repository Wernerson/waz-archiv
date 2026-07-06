// Unicode-aware word tokenizer: splits on runs of letters/digits so matching
// is on whole words (not substrings), correctly handling German ä/ö/ü/ß.
const TOKEN_RE = /[\p{L}\p{N}]+/gu

export interface TokenOffset {
  token: string
  start: number
  end: number
}

function keep(token: string): boolean {
  return token.length > 1 || /[0-9]/.test(token)
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(TOKEN_RE)) {
    if (keep(m[0])) tokens.push(m[0])
  }
  return tokens
}

export function tokenizeWithOffsets(text: string): TokenOffset[] {
  const lower = text.toLowerCase()
  const tokens: TokenOffset[] = []
  for (const m of lower.matchAll(TOKEN_RE)) {
    if (keep(m[0]) && m.index !== undefined) {
      tokens.push({ token: m[0], start: m.index, end: m.index + m[0].length })
    }
  }
  return tokens
}
