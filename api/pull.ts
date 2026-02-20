// core-heart-web/api/pull.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function b64ToUtf8(b64: string) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function makeMicroText(item: any): string {
  // 1) item.micro가 이미 있으면 그걸 우선
  const m = (item?.micro ?? item?.meta?.micro ?? "").toString().trim();
  if (m) return m;

  // 2) 없으면 item.text에서 1줄 만들어주기
  const t = (item?.text ?? item?.meta?.text ?? "").toString().trim();
  if (!t) return "";

  // 첫 줄/첫 문장 느낌으로 짧게
  const firstLine = t.split("\n")[0].trim();
  const clipped = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
  return clipped;
}
async function ghGetJson(url: string, token: string) {
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  return r.json();
}

function safeId(s: string) {
  return (s || "unknown").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !owner || !repo) return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });

    const url = new URL(req.url || "", `https://${req.headers.host}`);
    const appId = safeId((req.query.appId as string) || "harurua");
    const ALLOWED_APP_IDS = new Set(["harurua", "sallangi", "ttasseumi"]);
const fixedAppId = ALLOWED_APP_IDS.has(appId) ? appId : "harurua";

    const mode = String(req.query.mode || "short");
  const roomId = safeId(String(url.searchParams.get("roomId") ?? "").trim());

    // ===== LONG MODE (encyclopedia) =====
if (mode === "long") {
  try {
    const encUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/encyclopedia/index.json`;
    const enc = await fetch(encUrl).then(r => r.json());

    const items = Array.isArray(enc?.items) ? enc.items : [];

    const longItems = items.filter((x: any) => x?.length === "long" && x?.text);

    if (longItems.length > 0) {
      const picked = longItems[Math.floor(Math.random() * longItems.length)];
      
   return res.status(200).json({
  ok: true,
  items: [picked],
  micro: makeMicroText(picked) || null,
});
    }
  } catch {
    // encyclopedia 없으면 그냥 short로 내려감
  }
}

    // 1) inbox/appId 아래에서 날짜 폴더 목록
    const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}?ref=${branch}`;
    const dates = await ghGetJson(listDatesUrl, token);

    // 폴더만 뽑아서 최신(이름 기준) 선택
    const dateDirs = (Array.isArray(dates) ? dates : [])
      .filter((x: any) => x.type === "dir")
      .map((x: any) => x.name)
      .sort(); // YYYY-MM-DD라면 정렬 끝이 최신

    if (dateDirs.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

    const latestDate = dateDirs[dateDirs.length - 1];

    // 2) 날짜 폴더 아래 room 목록 → 일단 가장 첫 room
    const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${latestDate}?ref=${branch}`;
    const rooms = await ghGetJson(roomsUrl, token);
    const roomDirs = (Array.isArray(rooms) ? rooms : []).filter((x: any) => x.type === "dir").map((x: any) => x.name).sort();
  if (roomDirs.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

const latestRoom = roomDirs[roomDirs.length - 1];
const preferredRoom = roomDirs.includes("talk") ? "talk" : latestRoom;
const chosenRoom = roomId && roomDirs.includes(roomId) ? roomId : preferredRoom;

    // 3) latestRoom 아래 파일 목록 → 최신 파일 1개
    const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${latestDate}/${chosenRoom}?ref=${branch}`;
    const files = await ghGetJson(filesUrl, token);

    const fileItems = (Array.isArray(files) ? files : [])
      .filter((x: any) => x.type === "file" && x.name.endsWith(".json"))
      .map((x: any) => ({ name: x.name, download_url: x.download_url }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    if (fileItems.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });
const latest = fileItems[fileItems.length - 1];

// ✅ download_url 직접 fetch 대신: contents API로 읽기 (private repo 안전)
const filePath = `inbox/${fixedAppId}/${latestDate}/${chosenRoom}/${latest.name}`;
const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
const meta = await ghGetJson(contentUrl, token);

// GitHub contents API는 content가 base64(+개행)로 옴
const contentB64 = String(meta?.content || "").replace(/\n/g, "");
const raw = b64ToUtf8(contentB64);

const item = JSON.parse(raw);

const itemsArr = item ? [item] : [];
const micro = item ? makeMicroText(item) : null;

return res.status(200).json({
  ok: true,
  items: itemsArr,
  micro: micro && micro.trim() ? micro : null,
});

  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}
