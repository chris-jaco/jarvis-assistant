// Structural audit, not an implementation/reference proof of SentencePiece normalization.
import { fields, keywordTokens } from './prepare.mjs';
export function auditTokens(bpeBytes, tokenText, keywords) {
  try {
    const vocabulary = new Map(), ids = new Set();
    for (const line of tokenText.trim().split(/\r?\n/)) {
      const match = /^(\S+)\s+(\d+)$/.exec(line.trim());
      if (!match || vocabulary.has(match[1]) || ids.has(Number(match[2])) || Number(match[2]) > 2147483647) throw Error();
      vocabulary.set(match[1], Number(match[2])); ids.add(Number(match[2]));
    }
    const proto = fields(bpeBytes), pieces = new Set();
    for (const f of proto.filter(f => f.id === 1 && f.type === 2)) {
      const name = fields(f.value).find(f => f.id === 1 && f.type === 2)?.value;
      if (name) pieces.add(new TextDecoder().decode(name));
    }
    const normalizer = proto.find(f => f.id === 3 && f.type === 2)?.value;
    const spec = normalizer ? fields(normalizer) : [];
    const flag = id => spec.find(f => f.id === id && f.type === 0)?.value !== 0n;
    const name = spec.find(f => f.id === 1 && f.type === 2)?.value;
    const normalizerName = name ? new TextDecoder().decode(name) : 'DEFAULT';
    const sequences = keywords.map(tokens => ({ tokens, ids: tokens.map(t => vocabulary.get(t) ?? null),
      inVocabulary: tokens.every(t => vocabulary.has(t)), inSentencePiece: tokens.every(t => pieces.has(t)),
      spellsAtlas: tokens.join('').replace(/^▁/, '').toLowerCase() === 'atlas' }));
    const generated = [];
    for (const word of ['atlas', 'ATLAS']) try { generated.push({ word, tokens: keywordTokens(bpeBytes, tokenText, word) }); } catch { }
    const incompatible = !sequences.length || sequences.some(s => !s.inVocabulary || !s.inSentencePiece || !s.spellsAtlas);
    return { state: incompatible ? 'INCOMPATIBLE' : 'STRUCTURALLY_CONSISTENT_REFERENCE_PENDING',
      sequences, generated, vocabularySize: vocabulary.size, sentencePieceCount: pieces.size,
      normalization: { name: /^[\w-]{1,64}$/.test(normalizerName) ? normalizerName : 'OTHER',
        addDummyPrefix: flag(3), removeExtraWhitespaces: flag(4), escapeWhitespaces: flag(5),
        precompiledMap: spec.some(f => f.id === 2 && f.type === 2) },
      officialSentencePieceCompared: false, keywordChanged: false };
  } catch { return { state: 'AUDIT_INVALID', officialSentencePieceCompared: false, keywordChanged: false }; }
}
