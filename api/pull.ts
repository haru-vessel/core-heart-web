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

function safeId(s: string) {
  return (s || "unknown").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 80);
}

function makeMicroText(item: any): string {
  const m = (item?.micro ?? item?.meta?.micro ?? "").toString().trim();
  if (m) return m;

  const t = (item?.text ?? item?.meta?.text ?? item?.payload?.text ?? "").toString().trim();
  if (!t) return "";

  const firstLine = t.split("\n")[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

async function ghGetJson(url: string, token: string) {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  return r.json();
}

function isDateFolder(name: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
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

    const rawAppId = safeId((req.query.appId as string) || "harurua");
    const ALLOWED_APP_IDS = new Set(["harurua", "sallangi", "ttasseumi"]);
    const fixedAppId = ALLOWED_APP_IDS.has(rawAppId) ? rawAppId : "harurua";

    // ✅ encyclopedia 한 줄은 전용 모드로 분리
if (mode === "encyclopedia") {
  try {
    const encUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/encyclopedia/index.json`;
    const enc = await fetch(encUrl).then((r) => r.json());

    console.log("📘 encyclopedia mode hit", { appId: fixedAppId, mode });
    const items = Array.isArray(enc?.items) ? enc.items : [];

    // 구조 1) { items:[{ lines:[...] }] }
    const linePool = items.flatMap((item: any) =>
      Array.isArray(item?.lines)
        ? item.lines
            .filter((x: any) => typeof x === "string" && x.trim())
            .map((x: string) => x.trim())
        : []
    );

    // 구조 2) 혹시 { text, length } 류가 섞여 있어도 대응
    const textPool = items
      .filter((x: any) => typeof x?.text === "string" && x.text.trim())
      .map((x: any) => x.text.trim());

    const pool = linePool.length > 0 ? linePool : textPool;

    if (pool.length === 0) {
      return res.status(200).json({
        ok: true,
        source: "encyclopedia",
        items: [],
        micro: null,
      });
    }

    const picked = pool[Math.floor(Math.random() * pool.length)];

    return res.status(200).json({
      ok: true,
      source: "encyclopedia",
      items: [{ text: picked }],
      micro: picked,
    });
  } catch (e: any) {
    return res.status(200).json({
      ok: true,
      source: "encyclopedia",
      items: [],
      micro: null,
      warning: e?.message || "encyclopedia read failed",
    });
  }
}

   const mode = String(req.query.mode || "short"); // "short" | "long" | "encyclopedia"
    const roomId = safeId(String(url.searchParams.get("roomId") ?? "").trim()); // ✅ 받는 순간 safe 처리

    // ✅ encyclopedia long은 harurua만 (sallangi가 long 써도 여기 안 탐)
    if (mode === "long" && fixedAppId === "harurua" && !roomId) {
      try {
        const encUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/encyclopedia/index.json`;
        const enc = await fetch(encUrl).then((r) => r.json());
        const items = Array.isArray(enc?.items) ? enc.items : [];
        const longItems = items.filter((x: any) => x?.length === "long" && x?.text);

        if (longItems.length > 0) {
          const picked = longItems[Math.floor(Math.random() * longItems.length)];
          return res.status(200).json({ ok: true, items: [picked], micro: makeMicroText(picked) || null });
        }
      } catch {
        // 없으면 아래 inbox로 진행
      }
    }

    // 1) inbox/appId 아래에서 날짜 폴더 목록
    const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}?ref=${branch}`;
    const dates = await ghGetJson(listDatesUrl, token);

    console.warn("📘 /api/pull encyclopedia 호출");
    const dateDirs = (Array.isArray(dates) ? dates : [])
      .filter((x: any) => x.type === "dir" && isDateFolder(x.name))
      .map((x: any) => x.name)
      .sort(); // YYYY-MM-DD → sort 끝이 최신

    if (dateDirs.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

    const wantLong = mode === "long";
    const limit = wantLong ? 200 : 1;

    const collected: any[] = [];

    // ✅ 최신 날짜부터 훑기
    for (let i = dateDirs.length - 1; i >= 0; i--) {
      const date = dateDirs[i];

      // 2) 날짜 폴더 아래 room 목록
      const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}?ref=${branch}`;
      const rooms = await ghGetJson(roomsUrl, token);

      const roomDirs = (Array.isArray(rooms) ? rooms : [])
        .filter((x: any) => x.type === "dir")
        .map((x: any) => x.name)
        .sort();

      if (roomDirs.length === 0) continue;

      // ✅ roomId가 있으면 그 방만, 없으면 “talk 우선” (기존 정책 유지)
      const latestRoom = roomDirs[roomDirs.length - 1];
      const preferredRoom = roomDirs.includes("talk") ? "talk" : latestRoom;
      const chosenRoom = roomId && roomDirs.includes(roomId) ? roomId : preferredRoom;

      // 3) chosenRoom 아래 파일 목록
      const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}/${chosenRoom}?ref=${branch}`;
      const files = await ghGetJson(filesUrl, token);

      const fileItems = (Array.isArray(files) ? files : [])
        .filter((x: any) => x.type === "file" && x.name.endsWith(".json"))
        .map((x: any) => ({ name: x.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)); // 이름이 timestamp라면 마지막이 최신

      if (fileItems.length === 0) continue;

      // ✅ short: 최신 1개만
      // ✅ long : 최신부터 여러 개 모아서 최대 200개
      for (let j = fileItems.length - 1; j >= 0; j--) {
        const fn = fileItems[j];

        const filePath = `inbox/${fixedAppId}/${date}/${chosenRoom}/${fn.name}`;
        const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
        try {
          const meta = await ghGetJson(contentUrl, token);
          const contentB64 = String(meta?.content || "").replace(/\n/g, "");
          const raw = b64ToUtf8(contentB64);
          const item = JSON.parse(raw);
          if (item) collected.push(item);
        } catch {
          // 깨진 파일은 스킵
        }

        if (!wantLong && collected.length >= 1) break;
        if (wantLong && collected.length >= limit) break;
      }

      if (!wantLong && collected.length >= 1) break;
      if (wantLong && collected.length >= limit) break;
    }

    // ✅ 정렬 안정화: createdAt 기준
    collected.sort((a, b) => {
      const ta = Number(a?.meta?.createdAt ?? a?.createdAt ?? 0);
      const tb = Number(b?.meta?.createdAt ?? b?.createdAt ?? 0);
      return ta - tb;
    });

    const items = wantLong ? collected.slice(-limit) : collected.slice(-1);
    const micro = items.length > 0 ? makeMicroText(items[items.length - 1]) : null;

    return res.status(200).json({ ok: true, items, micro: micro && micro.trim() ? micro : null });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}