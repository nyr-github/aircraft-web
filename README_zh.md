# artcraft-web-auto

[English](README.md) | [简体中文](README_zh.md)

用 GitHub Actions 定时任务，把 ArtCraft 系列应用（FilmCraft / PhotoCraft / …）各自 **最新的 web 构建产物**自动同步并部署到 GitHub Pages。

- 每天定时（可手动触发）检查各仓库 `releases/latest`
- 仅当版本变化时才下载并解压对应的 `{app}-web-{version}.zip`（增量、省流量）
- 展平 zip 内的单层顶级目录后覆盖到站点根下的 `/{app}/`
- **每个应用 URL 稳定、永远指向最新版**：`https://<user>.github.io/artcraft-web-auto/filmcraft/`
- 顶层 `index.html` 为聚合入口页，自动列出全部应用及其版本

## 效果预览

由同步任务自动生成的入口页 —— 线上地址：[https://nyr-github.github.io/artcraft-web/](https://nyr-github.github.io/artcraft-web/)：

![ArtCraft Web Apps 入口页](docs/screenshot.png)

## 支持的应用

`filmcraft`、`photocraft`、`vectorcraft`、`lightcraft`、`pdfcraft`、`effectcraft`、`designcraft`、`wordcraft`、`soundcraft`、`deckcraft`、`cadcraft`、`gridcraft`（均在 `storytold` 组织下，清单见 `config/apps.json`）。

## 工作原理

```
GitHub Releases (storytold/*)
        │  每日 cron / 手动触发
        ▼
.github/workflows/sync-web-apps.yml
        │  调用
        ▼
scripts/sync.mjs ── 读取 gh-pages 上 versions.json，比对最新版本
        │            版本变化 → 下载 zip → 展平 → 覆盖 gh-pages/<app>/
        │            版本一致 → 跳过，保留原文件
        ▼
gh-pages 分支（GitHub Pages 站点根）
   ├── index.html       聚合入口（自动卡片 + 版本）
   ├── manifest.json    机器可读清单（app → 版本 / 路径 / 更新时间）
   ├── versions.json    增量同步状态（上次部署版本）
   ├── .nojekyll        关闭 Jekyll，避免 _headers 等被 Pages 忽略
   └── <app>/            各应用最新 web 构建（相对路径，任意子路径可用）
```

各 web 产物全部使用**相对 URL** 加载资源（见产物内 `HOSTING.md`："Any path works"），因此放在 `/{app}/` 子路径下天然可用，无需改写 base；GitHub Pages 原生以 `application/wasm` 提供 `.wasm`，产物不依赖 COOP/COEP，故 Pages 可直接运行。

## 一次性配置（部署到 GitHub 后）

1. 在 GitHub 新建仓库（例如 `artcraft-web-auto`），把本目录内容推送到默认分支（如 `main`）。
2. **Settings → Pages** → Source 选择 `Deploy from a branch` → Branch 选 `gh-pages`、目录 `/(root)` → Save。
   （首次同步会自动创建 `gh-pages` 分支；在那之前该选项可能看不到 `gh-pages`，可先手动触发一次工作流。）
3. 确认仓库 **Settings → Actions → General → Workflow permissions** 允许读写，或依赖工作流内的 `permissions: contents: write`（本项目已声明）。
4. 到 **Actions → Sync web apps → Run workflow** 手动触发一次，或等待每日 cron 自动运行。

> 使用内置 `GITHUB_TOKEN`，无需额外 secrets。定时任务从 `github.com` 下载公开产物、查询 API 均鉴权充分。

## 定时与手动触发

- Cron：`0 3 * * *`（UTC 03:00，北京时间约 11:00）。改时间在 `.github/workflows/sync-web-apps.yml` 的 `schedule.cron`。
- 手动：Actions 页面点 `Run workflow`，可填：
  - `force`：忽略版本比对，强制重新下载全部应用
  - `only`：逗号分隔的应用 id，仅同步指定应用（如 `filmcraft,gridcraft`）

## 本地运行 / 调试

需 Node 20+，以及系统 `curl` 与 `unzip`（或 `tar`）。

```bash
# 干跑：只查版本、不下载不写入
node scripts/sync.mjs --dest ./.out --dry-run

# 只同步单个应用
node scripts/sync.mjs --dest ./.out --only gridcraft

# 强制全量重新下载
node scripts/sync.mjs --dest ./.out --force

# 可选：指定 Pages 基准路径（默认相对 "./"）；ORG 覆盖组织名
PAGES_BASE=./ ORG=storytold node scripts/sync.mjs --dest ./.out
```

`--dest` 目录下会生成 `index.html` / `manifest.json` / `versions.json`，可直接用静态服务器预览：

```bash
npx serve ./.out
```

## 新增 / 调整应用

编辑 `config/apps.json`：

```json
{
  "org": "storytold",
  "apps": [
    { "id": "filmcraft", "title": "FilmCraft" },
    { "id": "newcraft", "title": "NewCraft" }
  ]
}
```

- `id`：仓库名，同时也是站点里的目录名 `/{id}/`
- `title`：入口页显示名（省略则自动首字母大写）
- 如需从别的仓库取产物，可加 `"repo": "other-name"` 覆盖。

前提是该仓库的 release 中存在形如 `{id}-web-{version}.zip` 的 web 产物（脚本会精确匹配该模式，其次回退到含 `web` 的 zip）。

## 目录结构

```
.github/workflows/sync-web-apps.yml   # 定时 + 手动同步工作流
config/apps.json                      # 应用清单
scripts/sync.mjs                      # 增量同步核心逻辑（无第三方依赖）
docs/screenshot.png                   # 本文档使用的入口页截图
.gitignore                            # 忽略本地 .out / gh-pages 产物
README.md                             # 英文文档（默认）
README_zh.md                          # 本简体中文文档
```
