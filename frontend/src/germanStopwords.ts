// Common German function words excluded from *free-term* matching only (see
// bm25Index.ts's parseQuery). Never used at indexing time or for phrase-search
// tokens — phrase adjacency checking needs every token's position indexed,
// stopwords included. Loosely modeled on Lucene's GermanAnalyzer default set;
// a starting point to tune further once real query behavior is observed.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'doch', 'sondern', 'denn',
  'ist', 'war', 'sind', 'waren', 'wird', 'werden', 'wurde', 'wurden',
  'sein', 'hat', 'haben', 'hatte', 'hatten',
  'nicht', 'kein', 'keine', 'auch', 'noch', 'nur', 'schon', 'sehr', 'so',
  'wie', 'als', 'dass', 'damit',
  'in', 'im', 'an', 'am', 'auf', 'aus', 'bei', 'bis', 'durch', 'für',
  'gegen', 'mit', 'nach', 'ohne', 'seit', 'über', 'um', 'unter', 'von',
  'vor', 'zu', 'zur', 'zum', 'zwischen',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man',
  'mich', 'dich', 'sich', 'uns', 'euch', 'ihm', 'ihn', 'ihnen',
  'ja', 'nein', 'was', 'wer', 'wo', 'wann', 'warum', 'wenn',
])
