/**
 * 待办面板 · 宿主半
 *
 * 职责：
 *  - 注册两条带鉴权的路由，供浏览器半读写工作区的待办数据
 *      GET  /api/pending.list   → 返回 pending.json 的完整内容
 *      POST /api/pending.set    → 用请求体覆盖 pending.json（校验后原子写）
 *
 * 数据源是工作区里的普通文件，因此**不依赖本插件**也能用命令行或直接编辑维护。
 * 插件只是它的一个视图。
 *
 * 路径解析顺序：
 *  1. 环境变量 DSH_PENDING_FILE（绝对路径）
 *  2. 环境变量 DSH_PENDING_ROOT 下的 _待办/pending.json
 *  3. 若干候选工作区根的 _待办/pending.json（见 CANDIDATE_ROOTS）
 */
import fs from "node:fs/promises";
import path from "node:path";

/** 路由路径。auth fence 由 connection 服务统一提供。 */
const LIST_PATH = "/api/pending.list";
const SET_PATH = "/api/pending.set";
/** 诊断信标：浏览器半走到哪一步就打到这里，仅存内存，供排查。 */
const BEACON_PATH = "/api/pending.beacon";
const beacons = [];

/** 相对数据文件路径（相对于工作区根）。 */
const REL = path.join("_待办", "pending.json");

/**
 * 候选工作区根。按顺序探测，第一个存在 pending.json 的胜出。
 * 之所以要候选，是因为插件的宿主 half 在应用 profile 内运行，
 * 其 process.cwd() 未必是本工作区。
 */
const CANDIDATE_ROOTS = [
  "C:\\Users\\xlszgz_2233\\Desktop\\锐胜，212汽车",
];

/** 允许的范围取值，用于 set 校验。 */
const KINDS = ["blocked", "todo", "watch"];
const STATUSES = ["open", "done", "dropped"];
const OWNERS = ["user", "agent", "external", ""];

/** 解析出当前生效的数据文件绝对路径；都不存在时返回首选路径（供写入时创建）。 */
async function resolveDataFile() {
  const explicit = process.env.DSH_PENDING_FILE;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());

  const roots = [];
  const envRoot = process.env.DSH_PENDING_ROOT;
  if (envRoot && envRoot.trim()) roots.push(envRoot.trim());
  roots.push(...CANDIDATE_ROOTS);

  const tried = [];
  for (const root of roots) {
    const candidate = path.join(root, REL);
    tried.push(candidate);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 继续探测 */
    }
  }
  // 都不存在：返回首选位置，写入时创建
  return tried[0] ?? path.join(CANDIDATE_ROOTS[0], REL);
}

/** 读数据。文件不存在时返回一个空的合法文档，而不是报错。 */
async function readDoc() {
  const file = await resolveDataFile();
  try {
    const text = await fs.readFile(file, "utf8");
    const doc = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.items)) {
      throw new Error("items 不是数组");
    }
    return { ok: true, file, doc };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        ok: true,
        file,
        doc: {
          doc: "项目待办与挂起事件",
          version: 1,
          updated: "",
          items: [],
          _missing: true,
        },
      };
    }
    return { ok: false, file, error: String((error && error.message) || error) };
  }
}

/** 校验客户端提交的文档，只接受已知字段，避免写入任意内容。 */
function sanitize(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("请求体不是对象");
  if (!Array.isArray(raw.items)) throw new Error("items 必须是数组");
  if (raw.items.length > 500) throw new Error("items 过多（上限 500）");

  const items = raw.items.map((it, i) => {
    if (typeof it !== "object" || it === null) throw new Error(`第 ${i + 1} 条不是对象`);
    const str = (v, max = 2000) =>
      typeof v === "string" ? v.slice(0, max) : "";
    const id = str(it.id, 64);
    const title = str(it.title, 300);
    if (!id) throw new Error(`第 ${i + 1} 条缺少 id`);
    if (!title) throw new Error(`第 ${i + 1} 条缺少 title`);
    const kind = KINDS.includes(it.kind) ? it.kind : "todo";
    const status = STATUSES.includes(it.status) ? it.status : "open";
    const owner = OWNERS.includes(it.owner) ? it.owner : "agent";
    return {
      id,
      scope: str(it.scope, 32) || "通用",
      title,
      detail: str(it.detail),
      kind,
      status,
      blocking: it.blocking === true,
      owner,
      source: str(it.source, 300),
      created: str(it.created, 32),
      closed: str(it.closed, 32),
      note: str(it.note, 1000),
    };
  });

  return {
    doc: "项目待办与挂起事件",
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    items,
  };
}

/** 原子写：先写临时文件再 rename，读的人不会撞上写了一半的文件。 */
async function writeDoc(file, doc) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

/** GET /api/pending.list */
async function handleList() {
  const { ok, file, doc, error } = await readDoc();
  if (!ok) {
    return Response.json(
      { ok: false, error, file },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
  return Response.json(
    { ok: true, file, doc },
    { headers: { "cache-control": "no-store" } }
  );
}

/** POST /api/pending.set */
async function handleSet(request) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  let doc;
  try {
    doc = sanitize(raw);
  } catch (error) {
    return Response.json(
      { ok: false, error: String((error && error.message) || error) },
      { status: 422 }
    );
  }
  const file = await resolveDataFile();
  try {
    await writeDoc(file, doc);
  } catch (error) {
    return Response.json(
      { ok: false, error: String((error && error.message) || error), file },
      { status: 500 }
    );
  }
  return Response.json({ ok: true, file, count: doc.items.length });
}

/**
 * 注册路由。connection 服务缺失时插件保持不激活，
 * 而不是抛错影响整个 profile。
 */
export const inject = ["connection"];

/** POST /api/pending.beacon —— 记录浏览器半的诊断信息。 */
async function handleBeacon(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* 允许空体 */
  }
  const entry = { at: new Date().toISOString(), ...body };
  beacons.push(entry);
  if (beacons.length > 200) beacons.shift();
  return Response.json({ ok: true, count: beacons.length });
}

/**
 * @param ctx 宿主插件上下文；connection 已注入。
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: LIST_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: () => handleList(),
  });

  ctx.connection.fetch.register({
    path: SET_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: (request) => handleSet(request),
  });

  ctx.connection.fetch.register({
    path: BEACON_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: (request) =>
      request.method === "GET"
        ? Response.json({ ok: true, beacons }, { headers: { "cache-control": "no-store" } })
        : handleBeacon(request),
  });
}
