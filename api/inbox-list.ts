// core-heart-web/api/inbox-list.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    if (!token || !owner || !repo) {
      return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const appIdQuery = (req.query.appId as string) || ""; // 없으면 전체 스캔

    // 0) inbox 아래 앱 목록
    const listAppsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox?ref=${branch}`;
    const apps = await ghGetJson(listAppsUrl, token);

    const appDirs = (Array.isArray(apps) ? apps : [])
      .filter((x: any) => x.type === "dir")
      .map((x: any) => x.name)
      .sort();

    const targetApps = appIdQuery ? [safeId(appIdQuery)] : appDirs;

    const collected: Array<{ download_url: string; appId: string; date: string; room: string; name: string }> = [];

    for (let ai = targetApps.length - 1; ai >= 0; ai--) {
      const appId = targetApps[ai];
      // 1) 날짜 폴더
      const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}?ref=${branch}`;
      let dates: any[] = [];
      try {
        dates = await ghGetJson(listDatesUrl, token);
      } catch {
        continue; // 앱 폴더가 없으면 스킵
      }

      const dateDirs = (Array.isArray(dates) ? dates : [])
        .filter((x: any) => x.type === "dir")
        .map((x: any) => x.name)
        .sort();

      for (let di = dateDirs.length - 1; di >= 0; di--) {
        const date = dateDirs[di];

        // 2) room 폴더
        const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}/${date}?ref=${branch}`;
        let rooms: any[] = [];
        try {
          rooms = await ghGetJson(roomsUrl, token);
        } catch {
          continue;
        }

        const roomDirs = (Array.isArray(rooms) ? rooms : [])
          .filter((x: any) => x.type === "dir")
          .map((x: any) => x.name)
          .sort();

        for (let ri = roomDirs.length - 1; ri >= 0; ri--) {
          const room = roomDirs[ri];

          // 3) room 아래 json 파일
          const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}/${date}/${room}?ref=${branch}`;
          let files: any[] = [];
          try {
            files = await ghGetJson(filesUrl, token);
          } catch {
            continue;
          }

          const jsonFiles = (Array.isArray(files) ? files : [])
            .filter((x: any) => x.type === "file" && typeof x.name === "string" && x.name.endsWith(".json"))
            .map((x: any) => ({ name: x.name, download_url: x.download_url }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name));

          for (let fi = jsonFiles.length - 1; fi >= 0; fi--) {
            collected.push({ ...jsonFiles[fi], appId, date, room });
            if (collected.length >= limit) break;
          }

          if (collected.length >= limit) break;
        }

        if (collected.length >= limit) break;
      }

      if (collected.length >= limit) break;
    }

    // 4) 실제 파일을 읽어서 savedAt/text를 가져오기 (목록 품질 ↑)
    const items = [];
    for (const f of collected) {
      try {
        const raw = await fetch(f.download_url).then((r) => r.text());
        const obj = JSON.parse(raw);

        const createdAt = String(obj?.savedAt || obj?.createdAt || "") || null;
        const text = String(obj?.text || "").trim();

        items.push({
          app: f.appId,
          type: "json",
          createdAt,
          title: text ? text.slice(0, 40) : `${f.date}/${f.room}/${f.name}`,
          url: f.download_url, // ✅ index.html이 이걸로 "열기" 가능
        });
      } catch {
        items.push({
          app: f.appId,
          type: "json",
          createdAt: null,
          title: `${f.date}/${f.room}/${f.name}`,
          url: f.download_url,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}
