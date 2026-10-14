export type ExactDraftContent = Readonly<{ status:'EXACT'; text:string }> | Readonly<{ status:'AMBIGUOUS' }>;

/**
 * Extracts draft content only from an explicitly delimited trusted transcript.
 * Delimiters are control syntax and are not part of the authorized content.
 * No normalization is applied to the captured content.
 */
export function exactDraftContent(utterance?:string):ExactDraftContent {
  if(!utterance||utterance.length>2000)return {status:'AMBIGUOUS'};
  const marker=/(?:(?:el )?(?:texto|mensaje) exacto\s*(?::\s*|es\s+)|(?:the )?exact (?:text|message)\s*(?::\s*|is\s+))/giu;
  const matches=[...utterance.matchAll(marker)];
  if(matches.length===1){
    const start=matches[0]!.index!+matches[0]![0].length;
    const tail=utterance.slice(start);
    const end=/(?:\s*)(?:fin del mensaje|fin del texto|end message|end text)[.!]?\s*$/iu.exec(tail);
    if(end&&end.index>0)return {status:'EXACT',text:tail.slice(0,end.index)};
  }
  return {status:'AMBIGUOUS'};
}

/** Clarifications may preserve an existing admission only when they contain no new objective. */
export function exactDraftClarification(utterance?:string):ExactDraftContent {
  if(!utterance||utterance.length>2000)return {status:'AMBIGUOUS'};
  if(!/^(?:(?:el )?(?:texto|mensaje) exacto\s*(?::\s*|es\s+)|(?:the )?exact (?:text|message)\s*(?::\s*|is\s+))/iu.test(utterance))return {status:'AMBIGUOUS'};
  return exactDraftContent(utterance);
}

/** A narrow acknowledgement cannot replace authority owned by an active task. */
export function incidentalAcknowledgement(utterance?:string):boolean {
  if(!utterance||utterance.length>80)return false;
  return /^(?:(?:s[ií]|si,? dale|dale|ok(?:ay)?|vale|bien|listo|entendido|continu[aá]|continue|go ahead|yes|yeah|yep|да|хорошо)|(?:listo,?\s*)?ya seleccion[eé] la conversaci[oó]n|(?:done,?\s*)?i selected the conversation)[.!\s]*$/iu.test(utterance.trim());
}
