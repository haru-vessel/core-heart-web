// src/utils/koreanJosa.ts
// 한국어 조사/어미 간단 처리 유틸 — 과도한 스템밍 없이 안전하게 한 번 컷

/** 자주 쓰는 조사/접미 */
const JOSA = [
  "은","는","이","이란","란","가","을","를","과","와",
  "으로","로","에게","에서","한테","보다","처럼","뿐",
  "까지","부터","라도","속으로","마저","조차","만","이나","라도"
] as const;

/** 흔한 종결/어미 */
const EOMI = [
  "이다","였다","한다","했다","하네","하니","하냐","하죠","하잖아",
  "네요","네요?","나요","나요?","다","라","구나","거든","거야","래요",
  "했어","했네","해요","합니다","합니다만","할까","할래","할게","했지"
] as const;

/** 단어의 끝에서 조사/어미 하나만 제거(길이 보호) */
export function stripJosaOnce(word: string): string {
  let w = (word ?? "").trim();
  if (!w) return w;
  // 긴 접미어 우선
  for (const suf of [...JOSA, ...EOMI].sort((a,b)=>b.length-a.length)) {
    if (w.endsWith(suf) && w.length > suf.length) {
      return w.slice(0, -suf.length);
    }
  }
  return w;
}

/** 문장 단위 조사/어미 제거 → 토큰 재결합 */
export function stripJosa(text: string): string {
  if (!text) return "";
  const raw = String(text)
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const toks = raw.split(" ").map(t => stripJosaOnce(t)).filter(Boolean);
  return toks.join(" ");
}

/** “단어+조사/어미” 허용 매칭을 위한 정규식 */
export function makeParticleRegex(term: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = esc(term);
  const j = [...JOSA, ...EOMI].map(esc).join("|");
  // 앞: 시작/비문자, 뒤: (조사|어미|끝|비문자)
  return new RegExp(
    `(?:^|[^\\p{Letter}\\p{Number}])(${t})(?:(${j})\\b|\\b|[^\\p{Letter}\\p{Number}]|$)`,
    "u"
  );
}

/** 텍스트 안에 term(조사/어미 허용) 포함 여부 */
export function matchTermInText(term: string, text: string): boolean {
  if (!term || !text) return false;
  return makeParticleRegex(term).test(String(text));
}

export function reduceWord(word: string): string {
  let w = word.trim().replace(/[?!.,;:()\[\]{}"“”‘’<>]/g, "");
  for (const j of JOSA) {
    if (w.endsWith(j) && w.length > j.length) {
      w = w.slice(0, w.length - j.length);
      break;
    }
  }
  return w;
}

// stripJosaFromTokens: string[] 도 받고 string 도 받는 오버로드
export function stripJosaFromTokens(input: string[]): string[];
export function stripJosaFromTokens(input: string): string[];
export function stripJosaFromTokens(input: string | string[]): string[] {
  const arr = Array.isArray(input) ? input : input.split(/\s+/).filter(Boolean);
  const out = arr.map(reduceWord).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(out)); // unique
}

// extractKeyTerms: (sentence, limit?) 시그니처 지원
export function extractKeyTerms(sentence: string, limit?: number): string[] {
  const raw = sentence
    .replace(/[?!.,;:()\[\]{}"“”‘’<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const terms = stripJosaFromTokens(raw);
  return typeof limit === "number" ? terms.slice(0, Math.max(0, limit)) : terms;
}

export function expandJosaVariants(term: string): string[] {
  const variants = ["는","은","이","가","을","를","로","으로","란","이란","과","와","에","에서","에게","께"];
  return [term, ...variants.map(j => term + j)];
}
