// Light, dependency-free German stemmer (suffix-stripping only, single pass,
// in the spirit of Lucene's GermanLightStemmer/GermanMinimalStemmer). Trades
// occasional over/under-stemming for simplicity and no npm dependency; the
// guards below bias toward *not* stripping short words to limit false merges.
//
// This only affects the matching key — display/highlighted text always uses
// the original surface form, never the stem.

const SUFFIXES_4 = ['lich', 'isch']
const SUFFIXES_3 = ['ern', 'end', 'est']
const SUFFIXES_2 = ['en', 'er', 'es', 'em']
const SUFFIXES_1 = ['e', 's', 'n']

function foldUmlauts(s: string): string {
  return s.replace(/ß/g, 'ss').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
}

function stripOne(word: string, suffixes: string[], minRemaining: number): string {
  for (const suf of suffixes) {
    if (word.endsWith(suf) && word.length - suf.length >= minRemaining) {
      return word.slice(0, word.length - suf.length)
    }
  }
  return word
}

export function stem(token: string): string {
  const folded = foldUmlauts(token.toLowerCase())
  if (folded.length <= 3) return folded

  let s = stripOne(folded, SUFFIXES_4, 3)
  if (s !== folded) return s
  s = stripOne(folded, SUFFIXES_3, 3)
  if (s !== folded) return s
  s = stripOne(folded, SUFFIXES_2, 3)
  if (s !== folded) return s
  return stripOne(folded, SUFFIXES_1, 4)
}
