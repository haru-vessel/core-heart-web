// src/api/dictionary.ts
import { stripJosa } from "../utils/koreanJosa";

export type DictionarySense = {
  no: number;
  pos?: string;
  definition: string;
};

function toOneLine(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

// 앱의 dictionaryAdapter.ts에 있던 “질의어 뽑기” 로직을 서버로 이식
export function extractDictQuery(input: string): string | null {
  const s = input
    .trim()
    .replace(/[\?\!\.\u2026]+$/g, "") // 끝의 ? ! . … 제거
    .replace(/\s+/g, " "); // 공백 정리

  // 1) “OO이란(는) 뭐야/뭐지/알려줘/정의/뜻/의미 …”
  const p1 = s.match(
    /^\s*(.+?)(?:이란|란|이는|는|은)\s*(?:게|게뭐야|뭐야|뭐지|뭘까|알려줘|정의|정의가|뜻|뜻이|의미|의미가)\s*.*$/
  );
  if (p1) return stripJosa(p1[1].trim());

  // 2) “OO의 뜻/의미/정의 …”
  const p2 = s.match(
    /^\s*(.+?)\s*의\s*(?:뜻|의미|정의)(?:가|은|이)?\s*(?:뭐야|뭐지|뭘까|알려줘)?\s*.*$/
  );
  if (p2) return stripJosa(p2[1].trim());

  // 3) “OO 뜻(의미/정의)이 뭐야 …”
  const p3 = s.match(
    /^\s*(.+?)\s*(?:뜻|의미|정의)(?:이|가)?\s*(?:뭐야|뭐지|뭘까|알려줘)?\s*.*$/
  );
  if (p3) return stripJosa(p3[1].trim());

  // 4) 단어만 던진 경우
  const p4 = s.match(/^\s*([가-힣A-Za-z0-9]{1,24})\s*$/);
  if (p4) return stripJosa(p4[1].trim());

  return null;
}

// 표준국어대사전(오픈 API) — 여러 뜻(sense) 배열로 가져오기
export async function fetchDictionarySenses(term: string): Promise<{
  term: string;
  senses: DictionarySense[];
  sourceUrl?: string;
}> {
  const KEY =
    (process.env.EXPO_PUBLIC_DICT_API_KEY as string) ||
    (process.env.DICT_API_KEY as string);

  if (!KEY) return { term, senses: [] };

  const base = "https://stdict.korean.go.kr/api/search.do";
  const params = new URLSearchParams({
    key: KEY,
    type_search: "search",
    req_type: "json",
    searchKeyword: term,
    num: "10",
    start: "1",
  });

  const url = `${base}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return { term, senses: [] };

    const data: any = await res.json();

    // 표준국어대사전 JSON은 보통 channel.item 아래로 내려옴
    const items = data?.channel?.item;
    const first = Array.isArray(items) ? items[0] : items;

    const senseRaw = first?.sense;
    const senseArr = Array.isArray(senseRaw) ? senseRaw : senseRaw ? [senseRaw] : [];

    const senses: DictionarySense[] = senseArr
      .map((s: any, idx: number) => {
        const definition =
          s?.definition || s?.sense_def || s?.def || s?.meaning;
        if (!definition) return null;

        const pos = first?.pos ? String(first.pos).trim() : (s?.pos ? String(s.pos).trim() : undefined);

        return {
          no: idx + 1,
          pos,
          definition: toOneLine(definition),
        };
      })
      .filter(Boolean) as DictionarySense[];

    const sourceUrl = first?.link ? String(first.link).trim() : undefined;
    return { term, senses, sourceUrl };
  } catch {
    return { term, senses: [] };
  }
}
