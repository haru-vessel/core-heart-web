// core-heart/src/types.ts
// Harulua core-heart — Breath / Inhale / Meeting shared types (v2)

/* ------------------------------------------------------------------ */
/* 1. 외부지식 결과 타입 (externalKnowledgeBridge.ts 기준)              */
/* ------------------------------------------------------------------ */

export interface ExternalKnowledgeResult {
  source: "wiki" | "paper" | "mixed";
  query: string;

  /** 앱/웹 카드에 바로 쓰는 짧은 숨 */
  shortSummary: string;

  /** 원문 또는 요약된 덩어리 (토글용) */
  raw?: string;

  /** 출처 메타 */
  references?: Array<{
    title?: string;
    url?: string;
    source?: string;
  }>;
}

/* ------------------------------------------------------------------ */
/* 2. 들숨(Inhale) 이벤트 타입 — 웹 회의실의 시작점                     */
/* ------------------------------------------------------------------ */

export type InhaleKind =
  | "definition60"   // 60점 승격 언어
  | "external"       // 외부지식만
  | "mixed";         // 60점 언어 + 외부지식

export interface InhaleEvent {
  /** 같은 숨을 묶는 키 (messageId 기반) */
  inhaleId: string;

  /** 어떤 방에서 들어왔는지 */
  roomId: string;

  /** 앱 사용자 */
  userId: string;

  /** 숨의 종류 */
  kind: InhaleKind;

  /** 웹 첫 화면에 보일 한 줄 */
  summary: string;

  /** 원문(접기/펼치기용) */
  raw?: string;

  /** 외부지식이 함께 온 경우 */
  external?: ExternalKnowledgeResult;

  /** 앱에서 생성된 시각 */
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* 3. 앱 → core-heart로 넘어오는 Breath 로그 페이로드                   */
/* ------------------------------------------------------------------ */

export interface CoreBreathLogPayload {
  /** 필수 */
  messageId: string;
  roomId: string;
  text: string;

  /** 점수 / 트리거 결과 */
  score?: number;
  emotionKey?: string;
  willKey?: string;

  /** 중앙 연결 정보 */
  centralTopics?: string[];
  centralDefinitionIds?: string[];

  /** 감정/성향 */
  emotionTendency?: string | number;

  /** 숨풍이 힌트 */
  personaHints?: string[];
  selectedPersonaId?: string;

  /** 🔥 v2 핵심: 들숨 카드 */
  inhale?: InhaleEvent;

  /** 앱에서 만든 시간 */
  createdAt?: number;
}

/* ------------------------------------------------------------------ */
/* 4. 서버에 저장되는 확정 Breath 로그                                  */
/* ------------------------------------------------------------------ */

export interface StoredBreathLog {
  messageId: string;
  roomId: string;
  text: string;

  score?: number;
  emotionKey?: string;
  willKey?: string;

  centralTopics: string[];
  centralDefinitionIds: string[];

  emotionTendency?: string | number;

  personaHints: string[];
  selectedPersonaId?: string;

  /** v2: 들숨 카드 */
  inhale?: InhaleEvent;

  /** 시간 */
  createdAt: number;   // 앱 기준
  receivedAt: number;  // 서버 기준
}

/* ------------------------------------------------------------------ */
/* 5. 웹 회의실에서 쓰는 카드 공용 타입                                  */
/* ------------------------------------------------------------------ */

export type MeetingCard =
  | {
      type: "inhale";
      inhale: InhaleEvent;
    }
  | {
      type: "definition";
      definitionId: string;
      topic: string;
      summary: string;
    }
  | {
      type: "external";
      inhaleId: string;
      external: ExternalKnowledgeResult;
    };
