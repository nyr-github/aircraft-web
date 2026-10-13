#!/usr/bin/env node
/**
 * sync.mjs — 增量同步 ArtCraft 系列应用的 web 构建产物到 gh-pages 目录。
 *
 * 流程：
 *   1. 读取 config/apps.json 应用清单（org + apps）。
 *   2. 读取目标目录中已有的 versions.json（上一次部署状态），用于跳过未变化的应用。
 *   3. 逐个查询 GitHub releases/latest，定位 {app}-web-{version}.zip 产物。
 *   4. 版本变化时才下载并解压，展平 zip 内的单层顶级目录后覆盖到 <dest>/<app>/。
 *   5. 重新生成 versions.json、manifest.json 与聚合入口 index.html，写入 .nojekyll。
 *
 * 仅使用 Node 20 内置模块 + 系统自带的 curl / unzip（ubuntu-latest runner 均具备）。
 *
 * 用法：
 *   node scripts/sync.mjs [--dest ./gh-pages] [--force] [--dry-run] [--only app1,app2]
 *
 * 环境变量：
 *   GITHUB_TOKEN  提升 API 速率限制（公开仓库产物下载无需鉴权）
 *   ORG           覆盖 apps.json 中的 org
 *   PAGES_BASE    入口 index.html 中链接的基准路径（默认相对 "./"）
 *   PAGES_URL     app.json 中使用链接的绝对基准 URL（GitHub Pages 根，末尾带 /）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--"))
    return argv[i + 1];
  return fallback;
}

const DEST = path.resolve(opt("dest", "./gh-pages"));
const FORCE = flag("force") || process.env.FORCE === "true";
const DRY_RUN = flag("dry-run");
const ONLY = (opt("only", process.env.ONLY || "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TOKEN = process.env.GITHUB_TOKEN || "";
const API_VERSION = "2022-11-28";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(...args);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带重试的 GitHub API GET。404 返回 null。 */
async function ghGet(url, attempt = 0) {
  const headers = {
    "User-Agent": "artcraft-web-auto-sync",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return ghGet(url, attempt + 1);
    }
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 触发速率限制时给出清晰错误
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `GitHub API 受限 (${res.status})：${text.slice(0, 200)}。请配置 GITHUB_TOKEN。`,
      );
    }
    throw new Error(`GitHub API 错误 ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** 使用 curl 下载文件（处理重定向、支持大文件、失败重试）。 */
function download(url, outPath) {
  execFileSync(
    "curl",
    [
      "-fsSL",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "--connect-timeout",
      "30",
      "-o",
      outPath,
      url,
    ],
    { stdio: "inherit" },
  );
}

/** 解压 zip 到目标目录：优先 unzip，缺失时回退到 tar（bsdtar 支持 zip）。 */
function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir], {
      stdio: "inherit",
    });
  } catch {
    execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "inherit" });
  }
}

/**
 * 定位解压结果的根目录：若顶级仅有一个目录则进入它，否则返回原目录。
 * 用于展平 zip 内的 `{app}-web-{version}/` 单层包裹目录。
 */
function resolveExtractRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return dir;
}

/** 从 tag / 资产名解析语义版本号。 */
function deriveVersion(tag, assetName) {
  const fromAsset =
    assetName && assetName.match(/-(\d+\.\d+\.\d+(?:[-.\w]*)?)\.zip$/i);
  if (fromAsset) return fromAsset[1];
  if (tag) return tag.replace(/^v/i, "");
  return null;
}

/** 从 release 资产列表中挑选 web zip。 */
function pickWebAsset(release, appId) {
  const assets = release.assets || [];
  const zips = assets.filter(
    (a) => /\.zip$/i.test(a.name) && !/portable/i.test(a.name),
  );
  // 1) 精确匹配 {app}-web-*.zip
  const exact = zips.find((a) =>
    new RegExp(`^${appId}-web-.*\\.zip$`, "i").test(a.name),
  );
  if (exact) return exact;
  // 2) 含 web 的 zip
  const loose = zips.find((a) => /web/i.test(a.name));
  return loose || null;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------
function loadConfig() {
  const configPath = path.join(REPO_ROOT, "config", "apps.json");
  const raw = readJsonSafe(configPath);
  if (!raw || !Array.isArray(raw.apps)) {
    throw new Error(`配置文件无效：${configPath}`);
  }
  const org = process.env.ORG || raw.org || "storytold";
  const apps = raw.apps.map((a) =>
    typeof a === "string"
      ? { id: a, title: titleCase(a) }
      : { id: a.id, title: a.title || titleCase(a.id), repo: a.repo },
  );
  return { org, apps };
}

function titleCase(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// ---------------------------------------------------------------------------
// 主逻辑
// ---------------------------------------------------------------------------
async function main() {
  const { org, apps } = loadConfig();
  fs.mkdirSync(DEST, { recursive: true });

  const versionsFile = path.join(DEST, "versions.json");
  const state = readJsonSafe(versionsFile) || {};

  const summary = {
    checked: 0,
    updated: [],
    unchanged: [],
    skipped: [],
    failed: [],
  };
  const nowIso = new Date().toISOString();

  for (const app of apps) {
    if (ONLY.length && !ONLY.includes(app.id)) {
      // 未在 --only 白名单内：保留既有状态不动
      if (state[app.id]) summary.skipped.push(app.id);
      continue;
    }
    summary.checked++;
    const repo = app.repo || app.id;
    const label = `${app.id}`;

    try {
      const release = await ghGet(
        `https://api.github.com/repos/${org}/${repo}/releases/latest`,
      );
      if (!release) {
        summary.failed.push({ id: app.id, reason: "无 release" });
        log(`[${label}] 未找到 release，跳过`);
        continue;
      }
      const asset = pickWebAsset(release, app.id);
      if (!asset) {
        summary.failed.push({ id: app.id, reason: "release 中无 web zip" });
        log(`[${label}] release ${release.tag_name} 无 web zip 资产，跳过`);
        continue;
      }
      const version = deriveVersion(release.tag_name, asset.name);
      const prev = state[app.id];
      const appDir = path.join(DEST, app.id);
      const alreadyThere = fs.existsSync(path.join(appDir, "index.html"));

      if (!FORCE && prev && prev.version === version && alreadyThere) {
        summary.unchanged.push(app.id);
        log(`[${label}] 已是最新 v${version}，跳过下载`);
        continue;
      }

      log(
        `[${label}] ${prev?.version ? `v${prev.version} → ` : "新增 "}v${version} (${asset.name})`,
      );

      if (DRY_RUN) {
        summary.updated.push({ id: app.id, version, dryRun: true });
        continue;
      }

      // 下载 + 解压到临时目录
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `acf-${app.id}-`));
      try {
        const zipPath = path.join(tmp, "web.zip");
        download(asset.browser_download_url, zipPath);
        const xDir = path.join(tmp, "x");
        unzip(zipPath, xDir);
        const root = resolveExtractRoot(xDir);

        // 覆盖式部署：先清空旧目录再复制
        fs.rmSync(appDir, { recursive: true, force: true });
        fs.cpSync(root, appDir, { recursive: true });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }

      state[app.id] = {
        version,
        tag: release.tag_name,
        asset: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        release_html: release.html_url,
        published_at: release.published_at,
        updated_at: nowIso,
      };
      summary.updated.push({ id: app.id, version });
      log(`[${label}] 部署完成 → /${app.id}/`);
    } catch (err) {
      const prevVer = state[app.id] && state[app.id].version;
      summary.failed.push({
        id: app.id,
        reason: String(err && err.message ? err.message : err),
      });
      log(
        `[${label}] 失败：${err && err.message ? err.message : err}（保留上一版本 ${prevVer ? "v" + prevVer : "无"}）`,
      );
    }
  }

  if (!DRY_RUN) {
    // 按配置顺序整理 manifest，写回状态文件
    const ordered = {};
    for (const app of apps) if (state[app.id]) ordered[app.id] = state[app.id];

    writeJson(versionsFile, ordered);

    const manifest = {
      generated_at: nowIso,
      org,
      apps: apps
        .filter((a) => ordered[a.id])
        .map((a) => ({
          id: a.id,
          title: a.title,
          version: ordered[a.id].version,
          tag: ordered[a.id].tag,
          path: `./${a.id}/`,
          updated_at: ordered[a.id].updated_at,
          published_at: ordered[a.id].published_at,
          release: ordered[a.id].release_html,
        })),
    };
    writeJson(path.join(DEST, "manifest.json"), manifest);

    // 供外部访问的应用清单：名称、版本、日期、使用链接
    writeJson(path.join(DEST, "app.json"), buildAppList(manifest));

    // 关闭 Jekyll 处理，避免 _headers 等文件被 Pages 忽略
    fs.writeFileSync(path.join(DEST, ".nojekyll"), "", "utf8");

    renderIndex(path.join(DEST, "index.html"), manifest);
  }

  report(summary);
}

// ---------------------------------------------------------------------------
// 外部访问清单 app.json
// ---------------------------------------------------------------------------
/** 以 PAGES_URL 为基准拼出每个应用的绝对访问链接；未配置时回退为相对路径。 */
function buildAppList(manifest) {
  const base = process.env.PAGES_URL || "./";
  return {
    generated_at: manifest.generated_at,
    apps: manifest.apps.map((a) => ({
      id: a.id,
      name: a.title,
      version: a.version,
      date: (a.updated_at || a.published_at || "").slice(0, 10),
      url: `${base}${a.id}/`,
    })),
  };
}

// ---------------------------------------------------------------------------
// 聚合入口页
// ---------------------------------------------------------------------------
function renderIndex(outFile, manifest) {
  const base = process.env.PAGES_BASE || "./";
  const cards = manifest.apps
    .map((a) => {
      const href = `${base}${a.id}/`;
      const ver = a.version ? `v${a.version}` : "";
      const date = a.updated_at ? a.updated_at.slice(0, 10) : "";
      return `      <a class="card" href="${href}">
        <h2>${escapeHtml(a.title)}</h2>
        <p class="id">${escapeHtml(a.id)}</p>
        <div class="meta"><span class="ver">${ver}</span><span class="date">${date}</span></div>
      </a>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ArtCraft Web Apps</title>
  <meta name="description" content="Auto-deployed latest web builds of the ArtCraft app suite.">
  <style>
    :root { --bg:#0f1115; --fg:#e8eaf0; --muted:#9aa3b2; --card:#171a21; --line:#252a35; --accent:#5b8cff; }
    @media (prefers-color-scheme: light){ :root{ --bg:#f5f6fa; --fg:#1a1d24; --muted:#5b6472; --card:#ffffff; --line:#e4e7ee; --accent:#3b6fe0;} }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--fg); }
    header { padding: 48px 24px 8px; max-width: 1080px; margin: 0 auto; }
    header h1 { margin:0 0 8px; font-size: 28px; letter-spacing:.3px; }
    header p { margin:0; color:var(--muted); font-size: 14px; }
    .grid { max-width:1080px; margin: 24px auto 64px; padding: 0 24px; display:grid; gap:16px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
    .card { display:block; text-decoration:none; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 18px 16px; transition: transform .12s ease, border-color .12s ease; }
    .card:hover { transform: translateY(-3px); border-color: var(--accent); }
    .card h2 { margin:0 0 2px; font-size:18px; }
    .card .id { margin:0 0 14px; color:var(--muted); font-size:13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .card .meta { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--muted); }
    .card .ver { color:var(--accent); font-weight:600; }
    footer { text-align:center; color:var(--muted); font-size:12px; padding: 0 24px 40px; }
    footer a { color:var(--accent); text-decoration:none; }
  </style>
</head>
<body>
  <header>
    <h1>ArtCraft Web Apps</h1>
    <p>Auto-synced from the latest GitHub releases. Generated ${manifest.generated_at.slice(0, 16).replace("T", " ")} UTC.</p>
  </header>
  <main class="grid">
${cards}
  </main>
  <footer>
    Each app always serves its newest published build.
  </footer>
</body>
</html>
`;
  fs.writeFileSync(outFile, html, "utf8");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------------------------------------------------------------------------
// 结果输出（控制台 + GITHUB_OUTPUT + Job Summary）
// ---------------------------------------------------------------------------
function report(summary) {
  const changed = summary.updated.length;
  log("\n===== 同步结果 =====");
  log(
    `更新: ${changed} | 未变化: ${summary.unchanged.length} | 白名单跳过: ${summary.skipped.length} | 失败: ${summary.failed.length}`,
  );
  if (summary.updated.length)
    log(
      "更新详情: " +
        summary.updated
          .map((u) => `${u.id}@${u.version}${u.dryRun ? "(dry)" : ""}`)
          .join(", "),
    );
  if (summary.failed.length)
    log(
      "失败详情: " +
        summary.failed.map((f) => `${f.id}: ${f.reason}`).join(" | "),
    );

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `changed=${changed}\n`);
    fs.appendFileSync(out, `any_changes=${changed > 0 ? "true" : "false"}\n`);
    fs.appendFileSync(out, `failed=${summary.failed.length}\n`);
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary && !DRY_RUN) {
    const rows = summary.updated
      .map((u) => `| ${u.id} | ${u.version} |`)
      .join("\n");
    const md =
      `## ArtCraft web sync\n\n` +
      `- Updated: **${changed}**, unchanged: **${summary.unchanged.length}**, failed: **${summary.failed.length}**\n\n` +
      (rows
        ? `| App | Version |\n|---|---|\n${rows}\n\n`
        : "_No app changed._\n") +
      (summary.failed.length
        ? `**Failed:** ${summary.failed.map((f) => `${f.id} (${f.reason})`).join("; ")}\n`
        : "");
    fs.appendFileSync(stepSummary, md, "utf8");
  }
}

main().catch((err) => {
  console.error("同步脚本异常终止：", err);
  process.exit(1);
});
