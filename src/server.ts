import "dotenv/config";
import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import { extractDictQuery, fetchDictionarySenses } from "./api/dictionary";
import { getLedger, postEvent } from "./api/hacoin";

// -----------------------------
// 0) 경로/파일 유틸
// -----------------------------

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: any) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function nowId(prefix: string) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now()}-${rand}`;
}

function sanitizeId(id: string) {
  // 파일명 안전하게: 영문/숫자/-/_만 허용
  const safe = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  return safe.slice(0, 80);
}
// -----------------------------
// (추가) 0-0) 기본 입력 필터 v0 (서버 입구 안전핀)
// - 교정/경고/가림 없음
// - 저장 자체를 "조용히 드롭"한다
// -----------------------------
function shouldDropBreathText(text: string) {
  const t = String(text || "").trim();

  // 1) 비어있으면 위에서 이미 걸러짐
  if (!t) return true;

  // 2) 강한 욕설/협박/혐오 (최소셋)
  //    (필요하면 단어를 천천히 추가하면 돼)
  const hardBad = /(씨발|시발|병신|좆|존나|꺼져|죽어|좃나|쌍|개새끼|미친놈|미친년)/;
  if (hardBad.test(t)) return true;

  // 3) 도배/의미없는 난사(초간단)
  //    같은 글자 8번 이상 반복: ㅋㅋㅋㅋㅋㅋ, ㅎㅎㅎㅎㅎㅎ, .......
  if (/(.)\1{7,}/.test(t)) return true;

  // 4) 너무 긴 스팸(초간단)
  if (t.length > 2000) return true;

  return false;
}

// -----------------------------
// 1) core-heart 기준 디렉토리 잡기 (꼬임 방지)
// -----------------------------
function resolveCoreHeartDir() {
  const cwd = process.cwd();

  // 1) 지금 cwd가 core-heart면 그대로
  if (path.basename(cwd).toLowerCase() === "core-heart") return cwd;

  // 2) 상위 구조에서 core-heart 폴더가 있으면 그쪽
  const guess = path.join(cwd, "core-heart");
  if (fs.existsSync(guess) && fs.statSync(guess).isDirectory()) return guess;

  // 3) 마지막 fallback: 그냥 cwd
  return cwd;
}

const CORE_HEART_DIR = resolveCoreHeartDir();
process.env.CORE_HEART_DIR = CORE_HEART_DIR;
const PUBLIC_DIR = path.join(CORE_HEART_DIR, "public");
const MEETINGS_DIR = path.join(CORE_HEART_DIR, "meetings");

const BREATH_LOG_PATH = path.join(CORE_HEART_DIR, "breath-log.json"); // 숨(원천) 저장
const CENTRAL_MEMORY_PATH = path.join(PUBLIC_DIR, "central-memory.json"); // 중앙기억(승격 결과) 저장
const MEETING_TEMPLATE_PATH = path.join(PUBLIC_DIR, "meeting.json"); // 회의 템플릿



ensureDir(PUBLIC_DIR);
ensureDir(MEETINGS_DIR);

const DATA_DIR = path.join(PUBLIC_DIR, "data");
ensureDir(DATA_DIR);

const PURIFY_BIN_PATH = path.join(DATA_DIR, "purify-bin.json"); // 정화통 저장소
const HACOIN_EVENTS_PATH = path.join(DATA_DIR, "hacoin-events.jsonl");

function appendJsonl(filePath: string, obj: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}

type PurifyItem = {
  id: string;
  text: string;
  reason?: string;
  movedAt: number;
  source?: { roomId?: string; messageId?: string; receivedAt?: number };
  tags?: string[];
};

type PurifyBin = { version: number; updatedAt: number; items: PurifyItem[] };

function readPurifyBin(): PurifyBin {
  return readJsonSafe<PurifyBin>(PURIFY_BIN_PATH, {
    version: 1,
    updatedAt: Date.now(),
    items: [],
  });
}
function writePurifyBin(data: PurifyBin) {
  data.updatedAt = Date.now();
  writeJson(PURIFY_BIN_PATH, data);
}



// -----------------------------
// 2) 타입(느슨하게, 실전용)
// -----------------------------
type BreathItem = {
   id?: string; // ✅ 추가 (들숨/숨 항목 식별자)
  messageId?: string;
  roomId?: string;
  text: string;
  score?: number;
  centralTopics?: string[];
  centralDefinitionIds?: string[];
  personaHints?: string[];
  selectedPersonaId?: string;
  createdAt?: number;
  receivedAt?: number;
  inhale?: any; // inhale 구조는 지금은 자유롭게
};

type BreathLog = {
  ok: true;
  items: BreathItem[];
};

type MeetingData = {
  meetingId: string;
  createdAt: number;
  status: "open" | "done";
  source: {
    from: "breath";
    messageId?: string;
    roomId?: string;
    text: string;
    createdAt?: number;
    receivedAt?: number;
  };
  topic?: string; // 선택/정리된 주제(나중에 회의에서 결정)
  emotions?: string[]; // 감정 태그(나중에 확장)
  autoCandidates?: string[]; // 자동 후보 3개
  afterLanguage?: {
    currentVersion: number;
    versions: Array<{
      v: number;
      createdAt: string;
      lines: string[];
      specSnapshot?: any;
      promotion?: { promoted: boolean; centralDefinitionId: string | null };
    }>;
  };
};

type CentralDefinition = {
  id: string;
  text: string;
  summary: string;
  topic?: string;
  route: "central";
  source: "meeting";
  promotedAt: string;
  meta?: any;
};


// -----------------------------
// 3) 자동 후보 3개 생성 (주제+감정 섞기 / 고백형 / 선택 질문)
// -----------------------------
function detectEmotion(text: string): string {
  // 아주 라이트한 휴리스틱(나중에 숨풍이가 대체)
  const t = text || "";
  if (/(두려|무섭|겁|불안)/.test(t)) return "두려움";
  if (/(슬프|눈물|허전|외롭)/.test(t)) return "슬픔";
  if (/(화나|분노|짜증)/.test(t)) return "분노";
  if (/(기대|설레|두근)/.test(t)) return "기대감";
  if (/(지치|피곤|무기력)/.test(t)) return "무기력";
  return "고요";
}

function detectTopic(text: string): string {
  // 주제도 라이트(나중에 숨풍이가 정교화)
  const t = text || "";
  if (/(진심)/.test(t)) return "진심";
  if (/(약속)/.test(t)) return "약속";
  if (/(연결)/.test(t)) return "연결";
  if (/(선택)/.test(t)) return "선택";
  if (/(회의)/.test(t)) return "회의";
  return "오늘";
}

function generateAutoCandidates(sourceText: string) {
  const emotion = detectEmotion(sourceText);
  const topic = detectTopic(sourceText);

  const c1 = `너의 ${emotion}은 피해야 할 언어가 아니야. 우리, 그 ${emotion}의 근원을 한 겹씩 살펴보면 어때?`;
  const c2 = `너는 지금 "${topic}" 쪽으로 계속 돌아오고 있어. 우리, 오늘은 그 ${topic}을 지키는 작은 선택 하나를 해볼까?`;
  const c3 = `너의 마음이 보내는 신호가 보여. 우리, ${emotion}과 ${topic}이 만나는 지점을 찾아서 한 문장으로 정리해볼래?`;

  return [
    { text: c1 },
    { text: c2 },
    { text: c3 },
  ];
}


// -----------------------------
// 4) Express 시작
// -----------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/api/hacoin/ledger", getLedger);
app.post("/api/hacoin/event", express.json(), postEvent);

// 정적 서빙
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/api/breath-log.json", (req, res) => {
  try {
    if (!fs.existsSync(BREATH_LOG_PATH)) {
      // 파일이 아직 없으면 빈 구조라도 돌려주기
      return res.json({ ok: true, items: [] });
    }
    return res.sendFile(path.resolve(BREATH_LOG_PATH));
  } catch (err) {
    console.error("[GET /api/breath-log.json] failed", err);
    return res.status(500).json({ ok: false });
  }
});

app.post("/api/breath/consume", (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id empty" });

    const to = String(req.body?.to || "meaning-cross").trim();
    const reason = String(req.body?.reason || "MOVED").trim();
    const userId = String(req.body?.userId || "web").trim();
    const persona = String(req.body?.persona || "haru").trim();
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];

    // 1) breath-log에서 해당 항목 찾기
    const log = readJsonSafe<{ ok: true; items: any[] }>(BREATH_LOG_PATH, { ok: true, items: [] });
    const idx = log.items.findIndex((it) => String(it.messageId || it.id || "") === id);

    if (idx < 0) {
      // 못 찾아도 흐름은 끊지 말자
      return res.json({ ok: true, warning: "not found" });
    }

    const target = log.items[idx];

    // 2) consume 표시(다음 promote가 나오게)
    target.consumedAt = Date.now();
    target.consumedTo = to;
    target.consumedReason = reason;
    target.consumedTags = tags;

    writeJson(BREATH_LOG_PATH, log);

    // 3) 하코인 이벤트 2줄 (B모드: action 0점 + reward +1점)
    const at = new Date().toISOString();
    const base = {
      userId,
      persona,
      messageId: id,
    };

    appendJsonl(HACOIN_EVENTS_PATH, {
      id: nowId("evt"),
      at,
      type: "action",
      delta: 0,
      reason: "BREATH_CONSUME",
      ...base,
      meta: { to, reason, tags },
    });

    appendJsonl(HACOIN_EVENTS_PATH, {
      id: nowId("evt"),
      at,
      type: "reward",
      delta: 1,
      reason: to === "meaning-cross" ? "BREATH_CONSUME_TO_CROSS" : "BREATH_CONSUME",
      ...base,
      meta: { to, reason, tags },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/breath/consume]", e);
    return res.status(500).json({ ok: false });
  }
});

// 디버그 경로 확인
app.get("/api/debug/paths", (_req, res) => {
  res.json({
    ok: true,
    cwd: process.cwd(),
    coreHeart: CORE_HEART_DIR,
    publicDir: PUBLIC_DIR,
    meetingsDir: MEETINGS_DIR,
  });
});

app.get("/api/wiki-summary", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q empty" });

    // 한국 위키 우선
    const url = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "harulua-core-heart/1.0" },
    });

    if (!r.ok) {
      return res.status(404).json({ summary: "", url: "", raw: { status: r.status } });
    }

    const data: any = await r.json();
    const summary = String(data.extract || data.description || "").trim();
    const pageUrl =
      data?.content_urls?.desktop?.page ||
      `https://ko.wikipedia.org/wiki/${encodeURIComponent(q)}`;

    return res.json({
      summary,
      url: pageUrl,
      raw: data,
    });
  } catch (e) {
    console.error("[GET /api/wiki-summary]", e);
    return res.status(500).json({ summary: "", url: "", raw: { error: "fail" } });
  }
});

app.get("/api/paper-summary", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q empty" });

    const searchUrl =
      `https://api.semanticscholar.org/graph/v1/paper/search?` +
      new URLSearchParams({
        query: q,
        limit: "1",
        fields: "title,abstract,url,year,authors,tldr,openAccessPdf",
      }).toString();

    const r = await fetch(searchUrl);
    if (!r.ok) {
      return res.status(200).json({ summary: "", url: "", raw: { status: r.status } });
    }

    const data: any = await r.json();
    const paper = data?.data?.[0];

    const url =
      String(paper?.openAccessPdf?.url || "").trim() ||
      String(paper?.url || "").trim();

    const abstract = String(paper?.abstract || "").trim();
    const tldr = String(paper?.tldr?.text || "").trim();
    const title = String(paper?.title || "").trim();

    const summary =
      abstract ||
      tldr ||
      title ||
      "관련 논문을 찾았지만 요약 정보가 비어 있어. 다른 키워드로 다시 시도해볼까?";

    return res.json({
      summary,
      url,
      raw: paper ?? data,
    });
  } catch (e) {
    console.error("[GET /api/paper-summary]", e);
    return res.status(500).json({ summary: "", url: "", raw: { error: "fail" } });
  }
});

// -----------------------------
// (추가) 국어사전(STDICT) 요약 가져오기
// -----------------------------
function cleanForQuery(text: string) {
  // ✅ "검색용"만 정리 (원문은 절대 훼손 X)
  return String(text || "")
    .trim()
    // 머리말/주체어 약하게 제거(검색엔 불리해서)
    .replace(/^(나는|너는|우리는|내가|네가|너의|나의)\s+/g, "")
    // 조사/연결어 대충 제거(완벽 필요 없음)
    .replace(/\b(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|까지|부터)\b/g, " ")
    .replace(/[“”"'.!?…(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickHeadline(chunks: string[]) {
  const list = (chunks || [])
    .map(s => String(s).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!list.length) return "";

  const scored = list.map(text => {
    let score = 0;

    // 질문/여지형 가점
    if (/[?]|지도 모른다|일지도|일 수 있다/.test(text)) score += 2;

    // 정의형(닫힘) 감점
    if (/이다\.$/.test(text) || /입니다\.$/.test(text)) score -= 1;

    // 너무 길면 감점
    if (text.length > 120) score -= 1;

    // 짧고 리듬 좋은 문장 가점
    if (text.length <= 80) score += 1;

    return { text, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.text ?? "";
}

async function fetchStdDictSenses(term: string): Promise<string[]> {
  const key = process.env.DICT_API_KEY || process.env.EXPO_PUBLIC_DICT_API_KEY;
  const base = process.env.EXPO_PUBLIC_DICT_BASE_URL || "https://stdict.korean.go.kr/api";

  // 키 없으면 그냥 빈 배열로 통과 (끊기지 않게)
  if (!key) return [];

  // 표준국어대사전: /api/search.do
  const url = `${base.replace(/\/$/, "")}/search.do?` + new URLSearchParams({
    key,
    req_type: "json",
    type_search: "search",
    searchKeyword: term,
    num: "5",
    start: "1",
  }).toString();

  try {
    const r = await fetch(url);
    if (!r.ok) return [];

    const data: any = await r.json().catch(() => null);
    if (!data) return [];

    // 응답 구조가 종종 channel.item / channel.item.sense 형태
    const item = Array.isArray(data?.channel?.item) ? data.channel.item[0] : data?.channel?.item;
    const senseRaw = item?.sense;
    const senses = Array.isArray(senseRaw) ? senseRaw : (senseRaw ? [senseRaw] : []);

    // definition 후보 키들 흡수
    const defs = senses
      .map((s: any) => s?.definition || s?.sense_def || s?.def || s?.meaning)
      .filter(Boolean)
      .map((x: any) => String(x).replace(/\s+/g, " ").trim());

    return defs.slice(0, 3);
  } catch (e) {
    console.warn("[DICT] fetch failed:", e);
    return [];
  }
}

// -----------------------------
// 5) 숨(원천) API: 여기서는 절대 중앙기억 승격 안 함!
// -----------------------------
app.post("/api/breath", (req, res) => {
  try {
    const body = req.body || {};
    const item: BreathItem = {
       id: String(body.id || body.messageId || nowId("inhale")), // ✅ 추가
      ...body,
      text: String(body.text || "").trim(),
      receivedAt: Date.now(),
    };

    if (!item.text) {
      return res.status(400).json({ ok: false, error: "text가 비었어" });
    } // ✅ 여기! res 스코프 안

    const log = readJsonSafe<BreathLog>(BREATH_LOG_PATH, { ok: true, items: [] });

    // 최신이 위로 오게 unshift
    log.items.unshift(item);

    // 너무 커지면 제한 (예: 300개)
    log.items = log.items.slice(0, 300);

    writeJson(BREATH_LOG_PATH, log);

    console.log("[core-heart] received breath:", {
      messageId: item.messageId,
      roomId: item.roomId,
      text: item.text,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/breath]", err);
    return res.status(500).json({ ok: false, error: "breath 저장 실패" });
  }
});

// ✅ 앱 호환용: /api/breath/log (앱이 여기로 보냄)
app.post("/api/breath/log", (req, res) => {
  try {
    const body = req.body || {};

    type BreathItem = {
      id: string;
      text: string;
      receivedAt: number;
      roomId?: string;
      userId?: string;
      messageId?: string;
      kind?: string;
      inhaleId?: string;
      summary?: string;
    };

 const rawText = String(body.text || "").trim();
if (!rawText) {
  return res.status(400).json({ ok: false, error: "text가 비었어" });
}

if (shouldDropBreathText(rawText)) {
  console.log("[core-heart] breath dropped:", {
    reason: "unsafe_text",
    preview: rawText.slice(0, 20),
  });
  return res.json({ ok: true, dropped: true });
}
    // ✅ 타입에 맞춰서 저장할 항목을 '정리'해서 만든다
    const entry: BreathItem = {
      id: String(body.id || body.messageId || nowId("inhale")),
        text: rawText,
      receivedAt: Date.now(),
      roomId: body.roomId ? String(body.roomId) : undefined,
      userId: body.userId ? String(body.userId) : undefined,
      messageId: body.messageId ? String(body.messageId) : undefined,
      kind: body.kind ? String(body.kind) : undefined,
      inhaleId: body.inhaleId ? String(body.inhaleId) : undefined,
      summary: body.summary ? String(body.summary) : undefined,
    };

    const log = readJsonSafe<{ ok: true; items: BreathItem[] }>(
      BREATH_LOG_PATH,
      { ok: true, items: [] }
    );

    log.items.unshift(entry);
    log.items = log.items.slice(0, 300);
    writeJson(BREATH_LOG_PATH, log);

    console.log("[core-heart] received breath(log):", {
      messageId: entry.messageId,
      roomId: entry.roomId,
      text: entry.text,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/breath/log]", err);
    return res.status(500).json({ ok: false, error: "breath 저장 실패" });
  }
});

app.post("/api/knowledge-headline-min", async (req, res) => {
  try {
    const text = (req.body?.text || "").trim();

    // 1. 입력 없을 때도 보호
    if (!text) {
      return res.json({
        ok: true,
        headline: "",
        query: "",
        meta: { reason: "empty-text" }
      });
    }

    // 2. 초간단 headline 생성 규칙
    //   - 줄바꿈 제거
    //   - 80자 제한
    const headline = text
      .replace(/\s+/g, " ")
      .slice(0, 80);

    // 3. 그대로 반환
    res.json({
      ok: true,
      headline,
      query: headline,
      meta: {
        source: "core-heart",
        mode: "minimal"
      }
    });
  } catch (e) {
    res.json({
      ok: false,
      headline: "",
      error: String(e)
    });
  }
});


// -----------------------------
// (추가) 하르 추천 머리말 1줄 (사전 + 위키 + 논문 섞기)
// -----------------------------
app.post("/api/knowledge-headline", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "text empty" });

    // 1) 검색 질의(query) 만들기 (원문 보존, query만 정리)
    const query = cleanForQuery(text);
    if (!query) return res.json({ ok: true, headline: "", query: "" });

    // 2) 기존 서버의 위키/논문 요약 API를 "내부 호출"로 재사용
    // 같은 서버 포트 사용
    const base = `${req.protocol}://${req.get("host")}`;

    const [wiki, paper] = await Promise.all([
      fetch(`${base}/api/wiki-summary?q=${encodeURIComponent(query)}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/paper-summary?q=${encodeURIComponent(query)}`).then(r => r.json()).catch(() => null),
    ]);

    // 3) 국어사전: query에서 "대표 단어" 하나만 뽑아 조회
    // (지금은 단순히 첫 토큰 사용. 나중에 더 똑똑하게 가능)
    const term = query.split(" ")[0];
    const dictDefs = term ? await fetchStdDictSenses(term) : [];

    // 4) 머리말 후보(chunks) 만들기
    const candidates: string[] = [];


    if (wiki?.summary) {
      // 위키 요약을 문장 단위로 잘라서 후보에 넣기
     candidates.push(
  String(wiki.summary).slice(0, 120)
)

    if (paper?.summary) {
      candidates.push(...String(paper.summary).split(/(?<=[.!?])\s+/).slice(0, 2));
    }
 if (dictDefs?.length) {
  // ✅ 사전 정의는 “한 줄 머리말 후보”로 바로 쓸 수 있게 문장화
  candidates.push(`${term} — 정의의 시작점`)

  // (선택) 두 번째 뜻도 후보로
  if (dictDefs[1]) candidates.push(`${term}는 ${dictDefs[1]}`);
}

// ✅ 안전장치: 외부지식이 하나도 안 잡혀도, 후보를 최소 1개는 만든다
if (candidates.length === 0) {
  // 1순위: 원문이 있으면 원문을 짧게 후보로
  candidates.push(
    `${query || term}에서 숨이 시작됐어`
  );

  // 2순위(추가 후보): query도 후보로 (원문이 너무 추상적일 때 대비)
  if (query && query !== text) candidates.push(query);
}
    }
    // 5) 하르 추천 1줄
    const headline = pickHeadline(candidates) || "숨이 모였어. 이제 한 줄로 엮을 차례야.";

    return res.json({
      ok: true,
      headline,
      query,
      meta: {
        term,
        dictCount: dictDefs.length,
        used: {
          wiki: Boolean(wiki?.summary),
          paper: Boolean(paper?.summary),
          dict: Boolean(dictDefs?.length),
        },
      },
    });
  } catch (e) {
    console.error("[POST /api/knowledge-headline]", e);
    // 에러여도 흐름 끊지 말고 빈 결과로 통과
    return res.status(200).json({ ok: true, headline: "", query: "", meta: { error: "fail" } });
  }
});


app.post("/api/dict", async (req, res) => {
  try {
    const { text, term } = req.body || {};

    // term이 직접 오면 그대로 쓰고, 없으면 text에서 질의어를 뽑음
    const q = (typeof term === "string" && term.trim())
      ? term.trim()
      : (typeof text === "string" ? extractDictQuery(text) : null);

    if (!q) {
      return res.status(400).json({ error: "no_query", message: "term or text is required" });
    }

    const result = await fetchDictionarySenses(q);

    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "dict_failed" });
  }
});

app.post("/api/knowledge-headline-old", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    // 1) 조사 제거 + 검색 질의 만들기
    // (앱 로직 이식 – 이미 올려준 유틸 사용)
    const query = text
      .replace(/[은는이가을를의에]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 2) 외부지식 검색 (기존 위키 요약 API 재사용)
    const wiki = await fetch(`http://localhost:4000/api/wiki-summary?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .catch(() => null);

    // 3) chunks 모으기
    const chunks: string[] = [
      ...(wiki?.chunks ?? []),
    ];

    // 4) 하르 추천 머리말 1줄
    const headline = pickHeadline(chunks);

    return res.json({
      headline,
      query,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "knowledge-headline failed" });
  }
});


app.get("/api/dict-summary", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ summary: "", url: "", raw: { error: "q empty" } });

    // 1) ✅ 국립국어원(표준국어대사전) 우선
    try {
      // fetchStdDictSenses는 루하 server.ts 안에 이미 존재한다고 했던 그 함수
      const defs = await fetchStdDictSenses(q);
      const summary = defs?.length ? defs.slice(0, 2).join(" / ").slice(0, 300).trim() : "";

      if (summary) {
        const url = `https://stdict.korean.go.kr/search/searchResult.do?searchKeyword=${encodeURIComponent(q)}`;
        return res.json({
          summary,
          url,
          raw: { source: "stdict", defsCount: defs.length, defs: defs.slice(0, 5) },
        });
      }
    } catch (e) {
      // 국립국어원 쪽이 잠깐 실패해도 아래 fallback으로 내려가게
      console.warn("[dict-summary] stdict failed, fallback to wiktionary", e);
    }

    // 2) 🔁 fallback: 위키낱말사전(ko.wiktionary)
    const pageUrl = `https://ko.wiktionary.org/wiki/${encodeURIComponent(q)}`;
    const apiUrl =
      "https://ko.wiktionary.org/w/api.php?" +
      new URLSearchParams({
        action: "parse",
        page: q,
        prop: "wikitext",
        redirects: "1",
        format: "json",
      }).toString();

    const r = await fetch(apiUrl, {
      headers: { "User-Agent": "harulua-core-heart/1.0" },
    });

    if (!r.ok) {
      return res.status(200).json({ summary: "", url: pageUrl, raw: { source: "wiktionary", status: r.status } });
    }

    const data: any = await r.json();
    const wikitext = String(data?.parse?.wikitext?.["*"] || "").trim();
    if (!wikitext) return res.json({ summary: "", url: pageUrl, raw: { source: "wiktionary", empty: true } });

    const lines = wikitext.split("\n").map(s => s.trim());
    const defs = lines
      .filter(l => l.startsWith("#") && !l.startsWith("#:") && !l.startsWith("##"))
      .map(l => l.replace(/^#+\s*/, "").trim())
      .filter(Boolean);

    const summary = defs.slice(0, 2).join(" / ").slice(0, 300).trim();

    return res.json({
      summary,
      url: pageUrl,
      raw: { source: "wiktionary", picked: defs.slice(0, 5) },
    });
  } catch (e) {
    console.error("[GET /api/dict-summary]", e);
    return res.status(500).json({ summary: "", url: "", raw: { error: "fail" } });
  }
});



app.post("/api/purify-bin/restore", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id empty" });

    const purify = readPurifyBin();
    const idx = purify.items.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "not found" });

    const item = purify.items[idx];
    purify.items.splice(idx, 1);
    writePurifyBin(purify);

    const log = readJsonSafe<any>(BREATH_LOG_PATH, { ok: true, items: [] });
    log.items = Array.isArray(log.items) ? log.items : [];
    log.items.unshift({
      messageId: item.source?.messageId || `restored-${Date.now()}`,
      roomId: item.source?.roomId || "purify-bin",
      text: item.text,
      receivedAt: Date.now(),
      restoredFrom: "purify-bin",
    });
    writeJson(BREATH_LOG_PATH, log);

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "restore fail" });
  }
});

app.post("/api/purify-bin/send-to-meeting", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id empty" });

    const purify = readPurifyBin();
    const idx = purify.items.findIndex((x) => x.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "not found" });

    const item = purify.items[idx];

    // 1) 정화통에서 제거
    purify.items.splice(idx, 1);
    writePurifyBin(purify);

    // 2) ✅ 기존 /api/meetings 로직 그대로 (파일 생성)
    const sourceText = String(item.text || "").trim();
    if (!sourceText) return res.status(400).json({ ok: false, error: "text가 비었어" });

    const meetingId = sanitizeId(nowId("meet"));
    const meetingPath = path.join(MEETINGS_DIR, `${meetingId}.json`);

    const template = readJsonSafe<any>(MEETING_TEMPLATE_PATH, {
      meetingId,
      createdAt: Date.now(),
      status: "open",
      source: { from: "breath", text: sourceText },
      autoCandidates: [],
      afterLanguage: { currentVersion: 1, versions: [] },
    });

    const meetingData: MeetingData = {
      ...template,
      meetingId,
      createdAt: template.createdAt || Date.now(),
      status: "open",
      source: {
        from: "breath",
        messageId: item.source?.messageId,
        roomId: item.source?.roomId,
        text: sourceText,
        receivedAt: item.source?.receivedAt,
      },
      autoCandidates: generateAutoCandidates(sourceText),
    };

    writeJson(meetingPath, meetingData);

    return res.json({ ok: true, meetingId });
  } catch (e) {
    console.error("[POST /api/purify-bin/send-to-meeting]", e);
    return res.status(500).json({ ok: false, error: "send fail" });
  }
});


app.post("/api/purify-bin/delete", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id empty" });

    const purify = readPurifyBin();
    const idx = purify.items.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "not found" });

    purify.items.splice(idx, 1);
    writePurifyBin(purify);

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "delete fail" });
  }
});




app.get("/api/purify-bin", (_req, res) => {
  try {
    return res.json(readPurifyBin());
  } catch (e) {
    console.error("[GET /api/purify-bin]", e);
    return res.status(500).json({ ok: false, error: "list fail" });
  }
});

app.post("/api/purify-bin/move", (req, res) => {
  try {
    const body = req.body || {};
    const reason = String(body.reason || "hold").trim();
    const text = String(body.text || "").trim();
    const messageId = body.messageId ? String(body.messageId) : undefined;
    const roomId = body.roomId ? String(body.roomId) : undefined;
    const receivedAt = body.receivedAt ? Number(body.receivedAt) : undefined;

    if (!text) return res.status(400).json({ ok: false, error: "text empty" });

    // breath-log에서 제거(있으면)
    const log = readJsonSafe<any>(BREATH_LOG_PATH, { ok: true, items: [] });
    const idx = Array.isArray(log.items)
      ? log.items.findIndex((it: any) =>
          (messageId && it.messageId && String(it.messageId) === messageId) ||
          (receivedAt && it.receivedAt && Number(it.receivedAt) === receivedAt) ||
          String(it.text || "").trim() === text
        )
      : -1;

    if (idx >= 0) {
      log.items.splice(idx, 1);
      writeJson(BREATH_LOG_PATH, log);
    }

    // purify-bin에 추가
    const purify = readPurifyBin();
    const id = `purify-${Date.now()}`;

    purify.items.unshift({
      id,
      text,
      reason,
      movedAt: Date.now(),
      source: { roomId, messageId, receivedAt },
      tags: Array.isArray(body.tags) ? body.tags : [],
    });

    writePurifyBin(purify);
    return res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "move fail" });
  }
});


app.get("/api/breath/recent", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
    const log = readJsonSafe<BreathLog>(BREATH_LOG_PATH, { ok: true, items: [] });
    return res.json({ ok: true, items: log.items.slice(0, limit) });
  } catch (err) {
    console.error("[GET /api/breath/recent]", err);
    return res.status(500).json({ ok: false, error: "breath recent 실패" });
  }
});

// -----------------------------
// 5.5) 들숨(기억) API: 지금은 breath-log를 “들숨 저장소”로 같이 쓴다
// -----------------------------

app.get("/api/inhale/recent", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const log = readJsonSafe<BreathLog>(BREATH_LOG_PATH, { ok: true, items: [] });
    return res.json({ ok: true, items: log.items.slice(0, limit) });
  } catch (err) {
    console.error("[GET /api/inhale/recent]", err);
    return res.status(500).json({ ok: false, error: "inhale recent 실패" });
  }
});

app.get("/api/inhale/:id", (req, res) => {
  try {
    const id = sanitizeId(String(req.params.id || "").trim());
    if (!id) return res.status(400).json({ ok: false, error: "id가 비었어" });

    const log = readJsonSafe<BreathLog>(BREATH_LOG_PATH, { ok: true, items: [] });
    const item = log.items.find((x: any) => String(x.id || x.messageId || "") === id);

    if (!item) return res.status(404).json({ ok: false, error: "기억이 없어" });
    return res.json({ ok: true, item });
  } catch (err) {
    console.error("[GET /api/inhale/:id]", err);
    return res.status(500).json({ ok: false, error: "inhale get 실패" });
  }
});

app.delete("/api/inhale/:id", (req, res) => {
  try {
    const id = sanitizeId(String(req.params.id || "").trim());
    if (!id) return res.status(400).json({ ok: false, error: "id가 비었어" });

    const log = readJsonSafe<BreathLog>(BREATH_LOG_PATH, { ok: true, items: [] });
    const before = log.items.length;

    log.items = log.items.filter((x: any) => String(x.id || x.messageId || "") !== id);

    const removed = before - log.items.length;
    writeJson(BREATH_LOG_PATH, log);

    return res.json({ ok: true, removed });
  } catch (err) {
    console.error("[DELETE /api/inhale/:id]", err);
    return res.status(500).json({ ok: false, error: "inhale delete 실패" });
  }
});


// 6) 회의 생성: breath 1개를 meeting 파일로 만든다
app.post("/api/meetings", (req, res) => {
  try {
    const body = req.body || {};

    // ✅ 둘 다 허용: body.source.text 또는 body.text
    const sourceText = String(body?.source?.text || body?.text || "").trim();
    if (!sourceText) {
      return res.status(400).json({ ok: false, error: "text가 비었어" });
    }

    const meetingId = sanitizeId(body.meetingId || nowId("meet"));
    const meetingPath = path.join(MEETINGS_DIR, `${meetingId}.json`);

    const template = readJsonSafe<any>(MEETING_TEMPLATE_PATH, {
      meetingId,
      createdAt: Date.now(),
      status: "open",
      source: { from: "breath", text: sourceText },
      autoCandidates: [],
      afterLanguage: { currentVersion: 1, versions: [] },
    });

    // ✅ messageId/roomId도 flat 또는 source 둘 다 허용
    const messageId = body?.source?.messageId || body?.messageId;
    const roomId = body?.source?.roomId || body?.roomId;

    const meetingData: MeetingData = {
      ...template,
      meetingId,
      createdAt: template.createdAt || Date.now(),
      status: "open",
      source: {
        from: "breath",
        messageId,
        roomId,
        text: sourceText,
        createdAt: body?.source?.createdAt || body?.createdAt,
        receivedAt: body?.source?.receivedAt || body?.receivedAt,
      },
      autoCandidates: generateAutoCandidates(sourceText),
    };

    writeJson(meetingPath, meetingData);
    return res.json({ ok: true, meetingId, meetingPath });
  } catch (err) {
    console.error("[POST /api/meetings]", err);
    return res.status(500).json({ ok: false, error: "회의 생성 실패" });
  }
});


app.get("/api/meetings/:id", (req, res) => {
  try {
    const meetingId = sanitizeId(String(req.params.id || "").trim());
    if (!meetingId) {
      return res.status(400).json({ ok: false, error: "meetingId가 비었어" });
    }

    const meetingPath = path.join(MEETINGS_DIR, `${meetingId}.json`);
    if (!fs.existsSync(meetingPath)) {
      return res.status(404).json({ ok: false, error: "회의 파일이 없어", meetingPath });
    }

    const meeting = readJsonSafe<MeetingData>(meetingPath, null as any);
    return res.json({ ok: true, meeting });
  } catch (err) {
    console.error("[GET /api/meetings/:id]", err);
    return res.status(500).json({ ok: false, error: "회의 불러오기 실패" });
  }
});

// -----------------------------
// 7) 중앙기억: “승격”은 여기서만 발생
// -----------------------------
app.get("/api/central/definitions", (_req, res) => {
  try {
    const list = readJsonSafe<{ ok: true; items: CentralDefinition[] }>(
      CENTRAL_MEMORY_PATH,
      { ok: true, items: [] }
    );
    
    return res.json(list);
  } catch (err) {
    console.error("[GET /api/central/definitions]", err);
    return res.status(500).json({ ok: false, error: "central definitions 실패" });
  }
});

// ✅ 앱 호환: 중앙기억 직접 저장(회의 없이도 들어올 수 있게)
app.post("/api/central/definitions", (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.body || body.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "body/text empty" });

    const def: CentralDefinition = {
      id: String(body.id || nowId("def")),
      text,
      summary: String(body.title || body.summary || text).trim(),
      topic: body.topic ? String(body.topic) : undefined,
      route: "central",
      source: "meeting",
      promotedAt: body.promotedAt ? String(body.promotedAt) : new Date().toISOString(),
      meta: body.meta ?? { from: "app-direct" },
    };

    const list = readJsonSafe<{ ok: true; items: CentralDefinition[] }>(
      CENTRAL_MEMORY_PATH,
      { ok: true, items: [] }
    );

    list.items.unshift(def);
    list.items = list.items.slice(0, 500);
    writeJson(CENTRAL_MEMORY_PATH, list);

    return res.json({ ok: true, definition: def });
  } catch (err) {
    console.error("[POST /api/central/definitions]", err);
    return res.status(500).json({ ok: false, error: "central 저장 실패" });
  }
});

/**
 * 승격 API (meeting에서 최종 문장 1개를 중앙으로)
 * body:
 *  - meetingId: string
 *  - text: string (승격할 문장)
 *  - summary?: string (없으면 text로)
 *  - topic?: string
 */
app.post("/api/central/promote", (req, res) => {
  try {
    const { meetingId, text, summary, topic } = req.body || {};
    const safeMeetingId = sanitizeId(String(meetingId || "").trim());
    const finalText = String(text || "").trim();
    if (!safeMeetingId || !finalText) {
      return res.status(400).json({ ok: false, error: "meetingId/text가 필요해" });
    }

    const def: CentralDefinition = {
      id: nowId("def"),
      text: finalText,
      summary: String(summary || finalText).trim(),
      topic: topic ? String(topic) : undefined,
      route: "central",
      source: "meeting",
      promotedAt: new Date().toISOString(),
      meta: { meetingId: safeMeetingId },
    };

    const list = readJsonSafe<{ ok: true; items: CentralDefinition[] }>(
  CENTRAL_MEMORY_PATH,
  { ok: true, items: [] }
);

// ✅ 호환: { central: [...] } → { items: [...] }
const anyList = list as any;
if (!Array.isArray(anyList.items) && Array.isArray(anyList.central)) {
  anyList.items = anyList.central;
  delete anyList.central;
}

// ✅ 안전핀: items가 없거나 깨졌으면 배열로
if (!Array.isArray(anyList.items)) anyList.items = [];

anyList.items.unshift(def);
anyList.items = anyList.items.slice(0, 500);
writeJson(CENTRAL_MEMORY_PATH, anyList);


    // ✅ 안전핀: old file / 깨진 파일 포맷이어도 items를 배열로 강제
if (!list || typeof list !== "object") {
  // @ts-ignore
  (list as any) = { ok: true, items: [] };
}
// @ts-ignore
if (!Array.isArray((list as any).items)) {
  // @ts-ignore
  (list as any).items = [];
}

    list.items.unshift(def);
    list.items = list.items.slice(0, 500);
    writeJson(CENTRAL_MEMORY_PATH, list);

    console.log("[CORE] central definition stored:", def.id, "from meeting:", safeMeetingId);

    return res.json({ ok: true, definition: def });
  } catch (err) {
    console.error("[POST /api/central/promote]", err);
    return res.status(500).json({ ok: false, error: "승격 실패" });
  }
});

// -----------------------------
// 8) 서버 실행
// -----------------------------
const PORT = Number(process.env.PORT || 4000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[core-heart] server on http://0.0.0.0:${PORT}`);
  console.log(`[core-heart] LAN  -> http://192.168.75.60:${PORT}`);
  console.log(`- public:   ${PUBLIC_DIR}`);
  console.log(`- meetings: ${MEETINGS_DIR}`);
  console.log("DICT KEY?", process.env.DICT_API_KEY ? "OK" : "NO");
console.log("EXPO_PUBLIC_DICT_API_KEY?", process.env.EXPO_PUBLIC_DICT_API_KEY ? "OK" : "NO");

});

function sendDefinitionToMeeting(definition: any) {
  const meetingId = definition.id || Date.now().toString();

  const meetingPath = path.join(
    MEETINGS_DIR,
    `${meetingId}.json`
  );

  const meetingData = {
    id: meetingId,
    status: "pending",
    source: definition,
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(
    meetingPath,
    JSON.stringify(meetingData, null, 2),
    "utf-8"
  );

  return meetingData;
}

