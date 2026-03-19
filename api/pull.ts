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
  return (s || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 80);
}

function makeMicroText(item: any): string {
  const m = (item?.micro ?? item?.meta?.micro ?? "").toString().trim();
  if (m) return m;

  const t = (item?.text ?? item?.meta?.text ?? item?.payload?.text ?? "")
    .toString()
    .trim();
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

  if (!r.ok) {
    throw new Error(`GitHub GET failed: ${r.status}`);
  }

  return r.json();
}

function isDateFolder(name: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

async function fetchJsonIfExists(url: string) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function extractLinePool(enc: any): string[] {
  const items = Array.isArray(enc?.items) ? enc.items : [];

  const linePool = items.flatMap((item: any) =>
    Array.isArray(item?.lines)
      ? item.lines
          .filter((x: any) => typeof x === "string" && x.trim())
          .map((x: string) => x.trim())
      : []
  );

  const textPool = items
    .filter((x: any) => typeof x?.text === "string" && x.text.trim())
    .map((x: any) => x.text.trim());

  return linePool.length > 0 ? linePool : textPool;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!token || !owner || !repo) {
      return res.status(500).json({
        ok: false,
        error: "Missing GitHub env vars",
      });
    }

    const url = new URL(req.url || "", `https://${req.headers.host}`);

    const rawAppId = safeId((req.query.appId as string) || "harurua");
    const ALLOWED_APP_IDS = new Set(["harurua", "sallangi", "ttasseumi"]);
    const fixedAppId = ALLOWED_APP_IDS.has(rawAppId) ? rawAppId : "harurua";

    const mode = String(req.query.mode || "short"); // "short" | "long" | "encyclopedia"
    const roomId = safeId(String(url.searchParams.get("roomId") ?? "").trim());

    // ✅ encyclopedia 한 줄은 여러 카테고리에서 모아오기
    if (mode === "encyclopedia") {
      try {
        const categoryFiles = [
          "emotion/index.json",
          "life-events/index.json",
          "relationship/index.json",
          "language-definition/index.json",
        ];

        const pools: Array<{ source: string; line: string }> = [];

        for (const file of categoryFiles) {
          const encUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/encyclopedia/${file}`;
          const enc = await fetchJsonIfExists(encUrl);
          if (!enc) continue;

          const pool = extractLinePool(enc);
          for (const line of pool) {
            pools.push({ source: file, line });
          }
        }

        console.log("📘 encyclopedia mode hit", {
          appId: fixedAppId,
          mode,
          poolSize: pools.length,
        });

        if (pools.length === 0) {
          return res.status(200).json({
            ok: true,
            source: "encyclopedia",
            items: [],
            micro: null,
          });
        }

        const picked = pools[Math.floor(Math.random() * pools.length)];

        return res.status(200).json({
          ok: true,
          source: "encyclopedia",
          category: picked.source,
          items: [{ text: picked.line }],
          micro: picked.line,
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

    // ✅ encyclopedia long은 harurua만
    if (mode === "long" && fixedAppId === "harurua" && !roomId) {
      try {
        const encUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/encyclopedia/index.json`;
        const encRes = await fetch(encUrl);

        if (!encRes.ok) {
          throw new Error(`Encyclopedia fetch failed: ${encRes.status}`);
        }

        const enc = await encRes.json();
        const items = Array.isArray(enc?.items) ? enc.items : [];
        const longItems = items.filter(
          (x: any) => x?.length === "long" && x?.text
        );

        if (longItems.length > 0) {
          const picked = longItems[Math.floor(Math.random() * longItems.length)];
          return res.status(200).json({
            ok: true,
            items: [picked],
            micro: makeMicroText(picked) || null,
          });
        }
      } catch {
        // 없으면 아래 inbox 로직으로 진행
      }
    }

    // 1) inbox/appId 아래 날짜 폴더 목록
    const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}?ref=${branch}`;
    const dates = await ghGetJson(listDatesUrl, token);

    const dateDirs = (Array.isArray(dates) ? dates : [])
      .filter((x: any) => x.type === "dir" && isDateFolder(x.name))
      .map((x: any) => x.name)
      .sort();

    if (dateDirs.length === 0) {
      return res.status(200).json({ ok: true, items: [], micro: null });
    }

    const wantLong = mode === "long";
    const limit = wantLong ? 200 : 1;

    const collected: any[] = [];

    for (let i = dateDirs.length - 1; i >= 0; i--) {
      const date = dateDirs[i];

      const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}?ref=${branch}`;
      const rooms = await ghGetJson(roomsUrl, token);

      const roomDirs = (Array.isArray(rooms) ? rooms : [])
        .filter((x: any) => x.type === "dir")
        .map((x: any) => x.name)
        .sort();

      if (roomDirs.length === 0) continue;

      const latestRoom = roomDirs[roomDirs.length - 1];
      const preferredRoom = roomDirs.includes("talk") ? "talk" : latestRoom;
      const chosenRoom =
        roomId && roomDirs.includes(roomId) ? roomId : preferredRoom;

      const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}/${chosenRoom}?ref=${branch}`;
      const files = await ghGetJson(filesUrl, token);

      const fileItems = (Array.isArray(files) ? files : [])
        .filter((x: any) => x.type === "file" && x.name.endsWith(".json"))
        .map((x: any) => ({ name: x.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));

      if (fileItems.length === 0) continue;

      for (let j = fileItems.length - 1; j >= 0; j--) {
        const fn = fileItems[j];

        const filePath = `inbox/${fixedAppId}/${date}/${chosenRoom}/${fn.name}`;
        const contentUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

        try {
          const meta = await ghGetJson(contentUrl, token);
          const contentB64 = String(meta?.content || "").replace(/\n/g, "");
          const raw = b64ToUtf8(contentB64);
          const item = JSON.parse(raw);

          if (item) {
            collected.push(item);
          }
        } catch {
          // 깨진 파일은 스킵
        }

        if (!wantLong && collected.length >= 1) break;
        if (wantLong && collected.length >= limit) break;
      }

      if (!wantLong && collected.length >= 1) break;
      if (wantLong && collected.length >= limit) break;
    }

    collected.sort((a, b) => {
      const ta = Number(a?.meta?.createdAt ?? a?.createdAt ?? 0);
      const tb = Number(b?.meta?.createdAt ?? b?.createdAt ?? 0);
      return ta - tb;
    });

    const items = wantLong ? collected.slice(-limit) : collected.slice(-1);
    const micro =
      items.length > 0 ? makeMicroText(items[items.length - 1]) : null;

    return res.status(200).json({
      ok: true,
      items,
      micro: micro && micro.trim() ? micro : null,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
}