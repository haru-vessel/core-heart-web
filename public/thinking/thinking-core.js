// thinking-core v20260103-stable (based on v20251231-3)
console.log("[thinking-core] v20260103-stable loaded");
/* public/thinking/thinking-core.js
   - 13개 사유방 공통 코어
   - 기본 refpack(파일) + 오늘 refpack(localStorage) 로드/렌더
   - thinking.inbox에서 주제 1개 소비해서 topic에 꽂기
   - axis + seeds 로드 후 자동 사유(옵션)
   - 버튼 이벤트 연결(옵션)
*/

/* ===========================
   Hooks Registry (SAFE)
=========================== */
// ✅ IIFE 바깥에서도 안전하게 쓸 수 있는 early normalize
function normalizeRoomIdEarly(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\.html$/g, "")
    .replace(/_+$/g, "")
    .replace(/[^a-z0-9-]/g, "");
}

const ROOM_HOOKS = {};

// 외부(각 방 스크립트)에서 호출: registerThinkingRoom("kongal", { thinkThree(){...} })
window.registerThinkingRoom = function registerThinkingRoom(rid, hooks) {
  const key = normalizeRoomIdEarly(rid);
  ROOM_HOOKS[key] = hooks || {};
};

// rid에 맞는 훅 가져오기
function getRoomHooks(rid) {
  return ROOM_HOOKS[normalizeRoomIdEarly(rid)] || null;
}
// ✅ 방에서 window.getRoomHooks(...)로 접근 가능하게 노출
window.getRoomHooks = getRoomHooks;

/* ===========================
   Soongpoong Icons
   (alias 포함: 오타/구버전 키도 흡수)
=========================== */
window.SOONGPOONG_ICONS = {
  // 정식
  haru: "🌌",
  haruroo: "🫧",
  kongal: "🫘",
  sallangi: "🍃",
  solbi: "🧪",
  taseumi: "☀️",
  hanaring: "🧵",
  dalmongi: "🌙",
  aru: "🧠",
  codering: "⚙️",
  ggulbug: "🐞",
  jjokkomi: "🐣",
  haruhoo: "🧭",
  haruroo: "🫧",

  // 과거/오타 alias (기존 파일에 있던 키들 흡수)
  dalmong: "🌙",
  codeling: "⚙️",
  honeybug: "🐞",
  chokommi: "🐣",
  harhu: "🧭",
  haruru: "🫧",
};

window.getSoongpoongIcon = function (room) {
  if (!room) return "🌬️";
  const key = String(room).toLowerCase();
  return window.SOONGPOONG_ICONS[key] || "🌬️";
};

/* ===========================
   Loaders
=========================== */
async function loadAxis(rid) {
  try {
    const url = `/data/axis/${normalizeRoomIdEarly(rid)}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadSeeds(rid) {
  try {
    const url = `/data/seeds/${normalizeRoomIdEarly(rid)}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.seeds) ? json.seeds : [];
  } catch {
    return [];
  }
}

function pickOneSeedByTriggers(text, seeds) {
  const t = String(text || "");
  let best = null;
  let bestScore = -1;

  for (const s of seeds || []) {
    const trig = Array.isArray(s?.triggers) ? s.triggers : [];
    let score = 0;
    for (const w of trig) {
      if (w && t.includes(w)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

function firstSentence(msg) {
  const m = String(msg || "").trim();
  if (!m) return "";
  const cut = Math.min(
    ...["다.", ".", "?"].map((x) => {
      const i = m.indexOf(x);
      return i >= 0 ? i + x.length : 999999;
    })
  );
  return cut === 999999 ? m : m.slice(0, cut).trim();
}

const PAYLOAD_KEY = "harulua.breathBridge.payload";

function pickAxisQ(axis, contextText) {
  const txt = String(contextText || "");
  const q2Keys = ["불안", "두려", "멈", "막", "과열", "혼란", "지치", "겁", "공포", "패닉"];
  const q3Keys = ["정리", "결론", "마무리", "요약", "한줄", "핵심", "결정", "회의", "승격"];

  const p = axis?.principle || {};
  const q1 = p.q1 || p["q1"] || "";
  const q2 = p.q2 || p["q2"] || "";
  const q3 = p.q3 || p["q3"] || "";

  if (q2Keys.some((k) => txt.includes(k))) return q2 || q1 || q3 || "";
  if (q3Keys.some((k) => txt.includes(k))) return q3 || q1 || q2 || "";
  return q1 || q2 || q3 || "";
}

/* ===========================
   Core IIFE
=========================== */
(async function () {
  // ===== Keys =====
  const THINKING_INBOX_KEY = "harulua.thinking.inbox";
  const TODAY_REFPACK_KEY = (rid) => `harulua.refpack.${rid}`;
  const STATE_KEY = (rid) => `harulua.thinking.${rid}.state`;

  // ===== Utils =====
  const $ = (id) => document.getElementById(id);

  function hardResetRoom(rid){
  // ✅ 로컬 저장 완전 삭제(방 상태 + 오늘 refpack)
  try {
    localStorage.removeItem(STATE_KEY(rid));
    localStorage.removeItem(TODAY_REFPACK_KEY(rid));
  } catch {}

  // ✅ 화면 요소도 가능한 건 전부 비움 (방마다 존재 여부가 달라서 있으면 비움)
  const idsToClearValue = ["topic", "topicInput", "seed", "card1", "card2", "card3", "oneLiner"];
  idsToClearValue.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if ("value" in el) el.value = "";
    else el.textContent = "";
  });

  const idsToClearText = ["topicText", "triCombined", "todayLine", "roomLine", "roomDict"];
  idsToClearText.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "{아직 없음}";
  });
}

window.resetThinkingRoomHard = function(rid){
  const key = normalizeRoomId(rid || window.__RID || "");
  if (!key) return;
  hardResetRoom(key);
};

  function safeJsonParse(v, fallback) {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function normalizeRoomId(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/\.html$/g, "")
      .replace(/_+$/g, "")
      .replace(/[^a-z0-9-]/g, "");
  }

  // pathname: /thinking/solbi.html -> solbi
  function getRoomIdFromPath() {
    const m = String(location.pathname || "").match(/\/thinking\/([^\/]+)$/);
    if (!m) return "solbi";
    return normalizeRoomId(m[1]);
  }

  function getRoomIdFinal() {
    // ✅ rid 우선순위: window.roomId → body data-room-id → body data-room → ?rid= → path
    const rid = normalizeRoomId(
      window.roomId ||
        document.body?.dataset?.roomId ||
        document.body?.dataset?.room ||
        new URLSearchParams(location.search).get("rid") ||
        getRoomIdFromPath() ||
        ""
    );
    return rid;
  }

  // ===== Haru northstar loader =====
  async function loadHaruNorthstar() {
    try {
      const res = await fetch("/data/haru.json", { cache: "no-store" });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.northstar || null;
    } catch {
      return null;
    }
  }

  function renderHaruNorthstarUI(ns) {
    if (!ns) return;

    const conceptEl = document.getElementById("haruConcept");
    const msgEl = document.getElementById("haruMessage");
    const qEl = document.getElementById("haruQuestion");

    if (conceptEl) conceptEl.textContent = `🌌 ${ns.concept || "북극성"}`;
    if (msgEl) msgEl.textContent = ns.message || "";
    if (qEl) qEl.textContent = ns.question ? `? ${ns.question}` : "";
  }

  // ===== 1) 기본 refpack(파일) 로드 =====
  async function loadBaseRefpackLines(rid) {
    const url = `/data/refpacks/${rid}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json();
    const lines = Array.isArray(json?.lines) ? json.lines : [];
    return lines.map((x) => String(x));
  }

  // ===== 2) 오늘 refpack(localStorage) 로드 =====
  function loadTodayRefpackLines(rid) {
    const raw = localStorage.getItem(TODAY_REFPACK_KEY(rid));
    if (!raw) return [];
    const arr = safeJsonParse(raw, []);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  }

  function saveTodayRefpackLines(rid, lines) {
    const arr = Array.isArray(lines) ? lines : [];
    localStorage.setItem(TODAY_REFPACK_KEY(rid), JSON.stringify(arr));
  }

  // ===== Render helpers =====
  function renderLines(el, lines) {
    if (!el) return;
    if (!lines || !lines.length) {
      el.textContent = "• (아직 없음)";
      return;
    }
    el.textContent = lines.map((x) => `• ${x}`).join("\n");
  }

  // ===== 3) thinking.inbox -> topic 주입 =====
  function pullOneFromThinkingInbox(rid) {
    const raw = localStorage.getItem(THINKING_INBOX_KEY);
    if (!raw) return null;

    const arr = safeJsonParse(raw, []);
    if (!Array.isArray(arr) || !arr.length) return null;

    // room이 일치하는 것 중 "첫 번째" 소비(기존 로직 유지)
    const idx = arr.findIndex((x) => normalizeRoomId(x?.room) === rid);
    if (idx < 0) return null;

    const item = arr[idx];
    arr.splice(idx, 1); // 소비
    localStorage.setItem(THINKING_INBOX_KEY, JSON.stringify(arr));
    return item;
  }

  function applyTopicFromInbox(rid) {
    const item = pullOneFromThinkingInbox(rid);
    if (!item) return "";

    const text = String(item?.text || "").trim();
    if (!text) return "";

    const topicBox = $("topic") || $("topicText") || $("topicInput");
    if (topicBox) {
      if ("value" in topicBox) topicBox.value = text;
      else topicBox.textContent = text;
    }
    return text;
  }

  function getTopicTextNow() {
    return String(
      $("topic")?.value ??
        $("topicInput")?.value ??
        $("topicText")?.textContent ??
        ""
    ).trim();
  }

  // ===== 4) 상태 저장/불러오기 =====
  function saveState(rid) {
    const state = {
      rid,
      savedAt: new Date().toISOString(),
      topic:
        $("topic")?.value ??
        $("topicInput")?.value ??
        $("topicText")?.textContent ??
        "",
      seed: $("seed")?.value ?? "",
      card1: $("card1")?.value ?? "",
      card2: $("card2")?.value ?? "",
      card3: $("card3")?.value ?? "",
      oneLiner: $("oneLiner")?.value ?? "",
    };
    localStorage.setItem(STATE_KEY(rid), JSON.stringify(state));
  }

  function loadState(rid) {
    const raw = localStorage.getItem(STATE_KEY(rid));
    if (!raw) return false;
    const state = safeJsonParse(raw, null);
    if (!state) return false;

    if ($("topic") && "value" in $("topic")) $("topic").value = state.topic || "";
    if ($("topicInput") && "value" in $("topicInput"))
      $("topicInput").value = state.topic || "";
    if ($("topicText")) $("topicText").textContent = state.topic || "";

    if ($("seed")) $("seed").value = state.seed || "";
    if ($("card1")) $("card1").value = state.card1 || "";
    if ($("card2")) $("card2").value = state.card2 || "";
    if ($("card3")) $("card3").value = state.card3 || "";
    if ($("oneLiner")) $("oneLiner").value = state.oneLiner || "";
    return true;
  }
// ===== 5) 브리지로 보내기 =====
function sendToBreath(rid) {
  const hooks = window.getRoomHooks ? window.getRoomHooks(rid) : null;

  let text = (hooks?.buildBreathTextNow?.() || window.buildBreathTextNow?.() || "").trim();
  if (!text) text = (hooks?.buildOneLine?.() || window.buildOneLine?.() || "").trim();

  if (!text) {
    alert("보낼 문장이 비어 있어.");
    return;
  }

  const ACTIVE_ROUND_KEY = "harulua.round.active";
  let roundId = localStorage.getItem(ACTIVE_ROUND_KEY) || "";

  // 라운드가 비어있으면 안전하게 생성
  if (!roundId) {
    roundId = "round-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
    localStorage.setItem(ACTIVE_ROUND_KEY, roundId);
  }

  // ✅ 방별 1회 제출 가드
  const SUBMIT_KEY = `harulua.round.${roundId}.submitted`;
  const submitted = safeJsonParse(localStorage.getItem(SUBMIT_KEY) || "{}", {});

  if (submitted[rid]) {
    alert("이미 이 라운드에서 보냈어 🙂 (꼬였으면 '전부 리셋' 후 다시 보내기)");
    return;
  }

  // ===== seed 생성 =====
  const BREATH_SEEDS_KEY = "harulua.breath.seeds";
  const seed = {
    id: "seed-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
    roundId,
    source: rid,
    text,
    createdAt: new Date().toISOString(),
  };

  // ===== seed 저장 (단 한 번만) =====
  const list = safeJsonParse(localStorage.getItem(BREATH_SEEDS_KEY) || "[]", []);
  list.unshift(seed);

  // ✅ 넘침 방지 상한 (예: 30)
  const capped = list.slice(0, 30);
  localStorage.setItem(BREATH_SEEDS_KEY, JSON.stringify(capped));

  // ===== 제출 완료 기록 =====
  submitted[rid] = true;
  localStorage.setItem(SUBMIT_KEY, JSON.stringify(submitted));

  // ===== 다음 라운드 준비 =====
  (hooks?.resetForNext?.() || window.resetForNext?.())?.();

  // ✅ 코어 안전핀: 방 상태 전부 리셋
  hardResetRoom(rid);

  // 공명 브릿지로 이동
  window.location.href = "/resonance-bridge.html";
}


  // ===== 버튼 바인딩 =====
  function bindButton(rid, id, fnName) {
    const btn = $(id);
    if (!btn) return;

    btn.addEventListener("click", () => {
      const hooks = getRoomHooks(rid);
      const fn =
        hooks && typeof hooks[fnName] === "function" ? hooks[fnName] : window[fnName];

      if (typeof fn === "function") fn(rid);
    });
  }

  // ===== axis → 3회 사유 변환기 =====
  window.axisTri = function (roomId, seedText) {
    const axis = window.__axisMap?.[roomId] || window.__axis;
    if (!axis) {
      console.warn("[axisTri] axis not found:", roomId);
      return { def: seedText, bound: "—", act: "—" };
    }

    const t1 = `🌌 ${axis.concept || ""}\n${seedText}`;

    let principleText = "";
    if (axis.principle && typeof axis.principle === "object") {
      principleText = Object.values(axis.principle).join(" / ");
    } else {
      principleText = axis.principle || "";
    }
    const t2 = principleText || "—";

    const t3 = Array.isArray(axis.description) ? axis.description.join(" ") : axis.description || "—";

    return { def: t1, bound: t2, act: t3 };
  };

  /* ===========================
     ✅ init (여기만 믿는다)
     - rid/topic/seeds/axis 모두 여기서만 흐르게
=========================== */
  async function init() {
    const rid = getRoomIdFinal();
    if (!rid) {
      console.warn("[thinking-core] rid not found. skip init on:", location.pathname, location.href);
      return;
    }

    // 디버그/외부 접근용(필요할 때만)
    window.__RID = rid;

    // (A) topic 주입 (없으면 그대로)
    const injected = applyTopicFromInbox(rid);

    // ✅ 무인 자동화: iframe에서 열렸고(auto=1) inbox로 topic이 주입됐으면 자동 제출
try {
  const params = new URLSearchParams(location.search);
  const auto = params.get("auto") === "1";

  if (auto && injected) {
    console.log("[thinking-core] auto=1 & injected → 자동 제출 시도:", rid);
    setTimeout(() => {
      // 내용이 늦게 채워질 수 있어서 약간 기다렸다가 보냄
      sendToBreath(rid);
    }, 600);
  }
} catch (e) {
  console.warn("[thinking-core] auto submit skipped:", e);
}


    // (B) refpack 렌더
    const baseEl = $("refpackBase") || $("refpackBaseList");
    const todayEl = $("refpackToday") || $("refpackTodayList");

    const baseLines = await loadBaseRefpackLines(rid);
    const todayLines = loadTodayRefpackLines(rid);

    renderLines(baseEl, baseLines);
    renderLines(todayEl, todayLines);

    // (B-2) haru 북극성
    const ns = await loadHaruNorthstar();
    renderHaruNorthstarUI(ns);

    // (C) 버튼 연결
    bindButton(rid, "thinkBtn", "thinkOnce");
    bindButton(rid, "think3Btn", "thinkThree");
    bindButton(rid, "saveBtn", "save");
    bindButton(rid, "loadBtn", "load");
    bindButton(rid, "copyBtn", "copyOneLiner");
    bindButton(rid, "toBreathBtn", "sendToBreath");

    // (D) 공통 저장/불러오기 핫픽스
    if (typeof window.save !== "function") window.save = () => saveState(rid);
    if (typeof window.load !== "function") window.load = () => loadState(rid);
    if (typeof window.sendToBreath !== "function") window.sendToBreath = () => sendToBreath(rid);

    // (E) axis 로드 + 훅 전달
    const axis = await loadAxis(rid);
    if (!axis) console.warn("[axis] not found:", rid);

    if (axis) {
      window.__axis = axis; // 디버그용
      window.__axisMap = window.__axisMap || {};
      window.__axisMap[rid] = axis;

      const hooks = getRoomHooks(rid);
      if (hooks && typeof hooks.onAxisLoaded === "function") hooks.onAxisLoaded(axis);
    }

    /* ======================================
       ✅ (F) seeds 로드 + 자동 사유
       - 반드시 init 안에서만 실행(스코프 꼬임 제거)
====================================== */
    const topicText = getTopicTextNow();
    const seeds = await loadSeeds(rid);

    if (seeds.length && topicText) {
      const picked = pickOneSeedByTriggers(topicText, seeds) || seeds[0];

      const axisQ = pickAxisQ(
        window.__axisMap?.[rid] || window.__axis,
        topicText + " " + (picked?.message || "") + " " + (picked?.question || "")
      );

      const one = firstSentence(picked?.message) || firstSentence(picked?.question) || "";

      // haru.html 전용 출력(있으면 채움)
      const todayLineEl = document.getElementById("todayLine");
      if (todayLineEl) todayLineEl.textContent = one;

      const triEl = document.getElementById("triCombined");
      if (triEl) {
        triEl.textContent = (
          (picked?.message || "").trim() +
          "\n\n" +
          (axisQ || "").trim() +
          "\n\n" +
          (picked?.question || "").trim()
        ).trim();
      }

      // ✅ haru.html 같은 방에서 "이 방의 한 줄" 자동 갱신
const hooks = window.getRoomHooks ? window.getRoomHooks(rid) : null;
const roomLineEl = document.getElementById("roomLine");
if (roomLineEl && hooks?.buildBreathTextNow) {
  const line = String(hooks.buildBreathTextNow() || "").trim();
  roomLineEl.textContent = line || "{아직 없음}";
}

      // 기존 입력칸도 유지
      if ($("oneLiner")) $("oneLiner").value = one;
      if ($("card1")) $("card1").value = (picked?.message || "").trim();
      if ($("card2")) $("card2").value = (axisQ || "").trim();
      if ($("card3")) $("card3").value = (picked?.question || "").trim();

      if ($("seed")) $("seed").value = (picked?.id || "") + " / " + (picked?.tone || "");
    }
  }

  // ===== boot =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 수동으로 다시 초기화하고 싶을 때
  window.__thinkingInit = init;
})();
