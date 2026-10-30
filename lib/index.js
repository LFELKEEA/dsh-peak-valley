/**
 * dsh-peak-valley —— 峰谷自动调度（随 DSH 运行）。
 *
 * 规则与 dsh-whale-widget 完全同源：
 *   峰时 = 北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00；
 *   其余时间（周末、法定节假日全天）= 谷时。
 * ⚠️ 每年 11 月国务院发布次年节假日安排后需同步更新 HOLIDAY_VALLEY；
 *    当年份没覆盖时，激活日志会明确提醒，不会静默把节假日当工作日。
 *
 * 行为：
 *   峰时 → 停止 SnowLuma + 语音服务（voxd/GSV）；QQ 桥接在 surfcore 未开启
 *          「随 DSH 启动 QQ」时停止，否则保留（避免与 surfcore 的 2 分钟自愈互杀）；
 *   谷时 → 全部拉起（幂等，已运行则跳过）。
 *   永不触碰：DSH 本体、QQ 客户端，以及任何"身份对不上"的进程。
 *   DSH 退出（dispose）→ 停止上述服务（保持「未开 DSH 就没有大肥鱼」）。
 *
 * 2026-10-30 重构要点：
 *   1. 不再按端口盲杀：端口占用者必须是 node/python 且命令行匹配
 *      SnowLuma / voice-packs / surfcore bridge.js，否则报 port-conflict 并跳过；
 *   2. 与 surfcore 的桥接自愈协调：surfcore 开启「随 DSH 启动 QQ」时，
 *      峰时不抢停桥接（否则每 2 分钟被自愈拉回，形成整点互杀）；
 *   3. 每轮巡检只查一次进程表 + 一次监听端口（快照），不再每个服务各起一个 PowerShell；
 *   4. 峰谷切换按 9/12/14/18 点边界对齐（+2 秒），另有 10 分钟心跳兜底；
 *   5. 只在状态变化或每小时心跳时写日志，日志超过 2MB 保留最近 512KB；
 *   6. 所有定时器统一登记，dispose 后不再触发；启动/停止结果如实上报。
 *
 * 路径：默认 D:/SnowLuma 与 surfcore 的 voice-local；可用插件 config
 *      （profile 的 cordis.patch.yml）或环境变量 PEAK_VALLEY_* 覆盖。
 * 日志：<插件目录>/peak-valley.log（北京时间）
 * 依赖：Windows PowerShell、taskkill、net（Node 内置）。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG_FILE = path.join(PLUGIN_ROOT, 'peak-valley.log');
const HIDE_PS1 = path.join(PLUGIN_ROOT, 'hide-windows.ps1');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;   // 心跳兜底
const FIRST_SYNC_DELAY_MS = 30 * 1000;     // 启动后 30 秒首次巡检（等 surfcore 把桥接拉起）
const BOUNDARY_DELAY_MS = 2000;            // 峰谷边界后 2 秒执行
const START_COOLDOWN_MS = 5 * 60 * 1000;   // 同一服务 5 分钟内不重复拉起
const WAIT_GSV_MS = 45 * 1000;             // 等 GSV(9880) 就绪再起 voxd(8765)
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 512 * 1024;
const HEARTBEAT_LOG_MS = 60 * 60 * 1000;   // 状态没变化时每小时留一条心跳

/**
 * 可配置路径。优先级：插件 config（profile 的 cordis.patch.yml）> 环境变量 > 默认值。
 * config 示例见 README「配置」一节。
 */
const DEFAULT_SETTINGS = {
  snowLumaNode: process.env.PEAK_VALLEY_SNOWLUMA_NODE || 'D:/SnowLuma/node.exe',
  snowLumaMain: process.env.PEAK_VALLEY_SNOWLUMA_MAIN || 'D:/SnowLuma/index.mjs',
  snowLumaDir: process.env.PEAK_VALLEY_SNOWLUMA_DIR || 'D:/SnowLuma',
  voiceRoot: process.env.PEAK_VALLEY_VOICE_ROOT
    || 'D:/Deepseek/工作区/surfcore/state/voice-packs/voice-local/surfvoicelocal-main',
};
let settings = { ...DEFAULT_SETTINGS };

export function applyConfig(config) {
  const next = { ...DEFAULT_SETTINGS };
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = config[key];
      if (typeof value === 'string' && value.trim()) next[key] = value.trim();
    }
  }
  settings = next;
}

const PORTS = { snow: 3000, snowAlt: 3001, bridge: 3100, voxd: 8765, gsv: 9880 };
const ALL_PORTS = Object.values(PORTS);
const GUARD = Symbol.for('dsh-peak-valley.active');

const PEAK_HOURS = [[9, 12], [14, 18]];
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
};

let disposed = false;
const timers = new Set();
let hideBusy = false;
let syncBusy = false;
let pendingSync = false;
let lastSyncAt = 0;
let lastStateKey = '';
let lastStateLoggedAt = 0;
let lastSnowStartAt = 0;
let lastGsvStartAt = 0;
let lastVoxdStartAt = 0;

// ── 通用工具 ────────────────────────────────────────────────────────────────
function trackTimer(timer) {
  timers.add(timer);
  return timer;
}

function clearTimers() {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 北京时间字符串（本机时区不一定是 +08:00，日志统一按北京时间写） */
function bjStamp(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

function errText(error) {
  return String(error?.stderr || error?.message || error)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 日志超过 2MB 时原地保留最近 512KB（不删除任何用户文件） */
function trimLogIfNeeded() {
  let fd;
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(LOG_KEEP_BYTES);
    fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, st.size - LOG_KEEP_BYTES);
    const text = buf.toString('utf8');
    const firstNl = text.indexOf('\n');
    const tail = firstNl >= 0 ? text.slice(firstNl + 1) : text;
    fs.writeFileSync(LOG_FILE, `[${bjStamp()} 北京] 日志超过 2MB，已保留最近 512KB\n${tail}`);
  } catch {} finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function log(msg) {
  const line = `[${bjStamp()} 北京] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function uniquePids(list) {
  return [...new Set(list.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

// ── PowerShell / 端口 ───────────────────────────────────────────────────────
const PS_EXEC_OPTS = {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 20_000,
  maxBuffer: 4 * 1024 * 1024,
};

async function psJson(script) {
  const { stdout } = await run('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`,
  ], PS_EXEC_OPTS);
  const text = String(stdout).trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function portOpen(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitPortClosed(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true;
    await sleep(300);
  }
  return !(await portOpen(port));
}

async function waitPortOpen(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (disposed) return false;
    if (await portOpen(port, '127.0.0.1', 800)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * 一次巡检只取一份快照：
 *   listeners: Map<port, pid[]>
 *   procs:     node.exe / python.exe 的进程行（含 Name、CommandLine）
 * 任一查询失败 => ok:false，本轮不做任何启停（避免拿残缺信息误杀）。
 */
async function snapshot() {
  try {
    const [listeners, procs] = await Promise.all([
      psJson(`$ports=@(${ALL_PORTS.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress`),
      psJson("Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='python.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='AgeSec';Expression={[int]((Get-Date)-$_.CreationDate).TotalSeconds}} | ConvertTo-Json -Compress"),
    ]);

    const byPort = new Map();
    for (const row of listeners) {
      const port = Number(row.LocalPort);
      const pid = Number(row.OwningProcess);
      if (!ALL_PORTS.includes(port) || !Number.isInteger(pid) || pid <= 0) continue;
      const list = byPort.get(port) ?? [];
      if (!list.includes(pid)) list.push(pid);
      byPort.set(port, list);
    }
    return { ok: true, listeners: byPort, procs };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}

function pidsOn(snap, port) {
  return snap.listeners.get(port) ?? [];
}

function rowPid(row) {
  return Number(row?.ProcessId);
}

function normCmd(row) {
  return String(row?.CommandLine ?? '').replace(/\\/g, '/').toLowerCase();
}

function nameIs(row, name) {
  return String(row?.Name ?? '').toLowerCase() === name;
}

function isOwnedBy(snap, pid, predicate) {
  const row = snap.procs.find((p) => rowPid(p) === pid);
  return Boolean(row && predicate(row));
}

function matchingPids(snap, predicate) {
  return uniquePids(snap.procs.filter(predicate).map(rowPid));
}

// ── 进程身份判定（宁可不杀，也不误杀）─────────────────────────────────────
export function isSnowLumaProc(row) {
  if (!nameIs(row, 'node.exe')) return false;
  const cmd = normCmd(row);
  return cmd.includes('snowluma') && cmd.includes('index.mjs');
}

export function isVoiceProc(row) {
  if (!nameIs(row, 'python.exe')) return false;
  const cmd = normCmd(row);
  const isVoiceApp = cmd.includes('api_v2.py') || cmd.includes('voxd');
  // 默认按 voice-packs / surfvoicelocal 识别；自定义 voiceRoot 时把目录名也当作标记，
  // 否则换了语音包目录就认不出自己拉起的进程。
  const root = String(settings.voiceRoot || '').replace(/\\/g, '/').toLowerCase();
  const base = root.split('/').filter(Boolean).pop() || '';
  const markers = new Set(['voice-packs', 'surfvoicelocal']);
  if (base.length >= 3) markers.add(base);
  const inVoiceRoot = [...markers].some((marker) => cmd.includes(marker));
  return isVoiceApp && inVoiceRoot;
}

export function isBridgeProc(row) {
  if (!nameIs(row, 'node.exe')) return false;
  const cmd = normCmd(row);
  return cmd.includes('bridge.js') && cmd.includes('surfcore');
}

// ── 峰谷时间 ────────────────────────────────────────────────────────────────
export function isPeakAt(ms) {
  const bj = new Date(ms + 8 * 3600_000);
  const dow = bj.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAY_VALLEY[bj.toISOString().slice(0, 10)]) return false;
  const hour = bj.getUTCHours();
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}

export function isPeakNow() {
  return isPeakAt(Date.now());
}

/** 下一个 9/12/14/18 点边界（真实时间戳，非北京时间字面值） */
export function nextTransitionAt(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600_000);
  const base = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const candidates = [];
  for (let day = 0; day < 10; day += 1) {
    for (const [start, end] of PEAK_HOURS) {
      candidates.push(base + day * 86_400_000 + start * 3_600_000);
      candidates.push(base + day * 86_400_000 + end * 3_600_000);
    }
  }
  const next = candidates
    .map((t) => t - 8 * 3600_000)
    .filter((t) => t > nowMs)
    .sort((a, b) => a - b)[0];
  return next ?? nowMs + SYNC_INTERVAL_MS;
}

/** surfcore 的「随 DSH 启动 QQ」开关；null = 配置读不到 */
export function readSurfcoreStartQQ(file = surfcoreConfigFile()) {
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const explicit = user?.platforms?.start?.qq;
    if (typeof explicit === 'boolean') return explicit;
    const legacy = user?.bridge?.autoStart;
    if (typeof legacy === 'boolean') return legacy;
    const enabled = Array.isArray(user?.platforms?.enabled) ? user.platforms.enabled.map(String) : null;
    if (enabled) return enabled.includes('qq');
    return true; // surfcore 自己的默认值
  } catch {
    return null;
  }
}

function surfcoreConfigFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'surfcore', 'config.json');
}

let holidayCheckedYear = '';
function checkHolidayCoverage() {
  const year = String(new Date(Date.now() + 8 * 3600_000).getUTCFullYear());
  if (holidayCheckedYear === year) return;
  holidayCheckedYear = year;
  const covered = Object.keys(HOLIDAY_VALLEY).some((date) => date.startsWith(`${year}-`));
  if (!covered) {
    log(`提醒：节假日表没有 ${year} 年的数据，节假日会被当成工作日；请更新 lib/index.js 的 HOLIDAY_VALLEY`);
  }
}

// ── 启停动作 ────────────────────────────────────────────────────────────────
async function killTree(pid) {
  try {
    await run('taskkill', ['/F', '/T', '/PID', String(pid)], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function stopPids(pids) {
  for (const pid of uniquePids(pids)) await killTree(pid);
}

async function startHidden(exe, args, cwd, extraEnv = {}) {
  const envSet = Object.entries(extraEnv)
    .map(([key, value]) => `$env:${key}='${String(value).replace(/'/g, "''")}';`)
    .join(' ');
  const argList = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${envSet} `
    + `Start-Process -FilePath ${quote(exe)} -ArgumentList ${argList} `
    + `-WorkingDirectory ${quote(cwd)} -WindowStyle Hidden`;
  try {
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    return true;
  } catch (error) {
    log(`隐藏启动失败：${errText(error).slice(0, 160)}`);
    return false;
  }
}

function voiceEnv() {
  return {
    PYTHONPATH: `${settings.voiceRoot}/vendor/GPT-SoVITS/code/GPT_SoVITS;${settings.voiceRoot}/vendor/GPT-SoVITS/code`,
    PYTHONIOENCODING: 'utf-8',
    PATH: `${settings.voiceRoot}/tools/bin;${process.env.PATH || ''}`,
  };
}

/** SnowLuma 的 OneBot 端口可能是 3000 或 3001；两个都认，避免重复拉起 */
function snowActivePort(snap) {
  for (const port of [PORTS.snow, PORTS.snowAlt]) {
    if (pidsOn(snap, port).some((pid) => isOwnedBy(snap, pid, isSnowLumaProc))) return port;
  }
  return null;
}

async function stopSnowLuma(snap) {
  const activePort = snowActivePort(snap);
  const targets = matchingPids(snap, isSnowLumaProc);
  if (!targets.length) return activePort ? 'stop-failed' : 'already-off';
  await stopPids(targets);
  if (activePort && !(await waitPortClosed(activePort))) return 'stop-failed';
  return activePort ? 'stopped' : 'cleaned';
}

async function startSnowLuma(snap) {
  if (disposed) return 'aborted';
  if (snowActivePort(snap)) return 'already-on';
  // 3000 被别的程序占着就别起（SnowLuma 默认听这个口），也不去杀别人
  if (pidsOn(snap, PORTS.snow).length) return 'port-conflict';
  const snowProcs = snap.procs.filter(isSnowLumaProc);
  if (snowProcs.some((row) => Number(row.AgeSec) < 60)) {
    return 'starting'; // 刚拉起、还没监听端口，别把它当残留杀掉
  }
  const zombies = uniquePids(snowProcs.map(rowPid));
  if (zombies.length) {
    await stopPids(zombies);
    log(`清理 SnowLuma 残留进程 ${zombies.length} 个（端口未监听）`);
    await sleep(1000);
  }
  if (disposed) return 'aborted';
  if (Date.now() - lastSnowStartAt < START_COOLDOWN_MS) return 'cooldown';
  lastSnowStartAt = Date.now();
  const ok = await startHidden(settings.snowLumaNode, [settings.snowLumaMain], settings.snowLumaDir, { SNOWLUMA_HOOK_AUTOLOAD: '1' });
  if (!ok) return 'start-failed';
  scheduleHide();
  return 'starting';
}

async function stopVoice(snap) {
  const owners = uniquePids([...pidsOn(snap, PORTS.voxd), ...pidsOn(snap, PORTS.gsv)]);
  const foreign = owners.filter((pid) => !isOwnedBy(snap, pid, isVoiceProc));
  if (foreign.length) return 'port-conflict';
  const targets = uniquePids([...owners, ...matchingPids(snap, isVoiceProc)]);
  if (!targets.length) return 'already-off';
  await stopPids(targets);
  const closed = (await waitPortClosed(PORTS.voxd)) && (await waitPortClosed(PORTS.gsv));
  return closed ? (owners.length ? 'stopped' : 'cleaned') : 'stop-failed';
}

async function startVoice(snap) {
  if (disposed) return 'aborted';
  const voxdOwners = pidsOn(snap, PORTS.voxd);
  const gsvOwners = pidsOn(snap, PORTS.gsv);
  const foreign = [...voxdOwners, ...gsvOwners].filter((pid) => !isOwnedBy(snap, pid, isVoiceProc));
  if (foreign.length) return 'port-conflict';
  if (voxdOwners.length && gsvOwners.length) return 'already-on';

  // 刚拉起、还没监听端口的进程不算“没启动”，避免一分钟内叠第二个实例
  const voiceRows = snap.procs.filter(isVoiceProc);
  const isGsvRow = (row) => normCmd(row).includes('api_v2.py');
  const isVoxdRow = (row) => normCmd(row).includes('voxd');
  if (!voxdOwners.length && voiceRows.some((row) => isVoxdRow(row) && Number(row.AgeSec) < 60)) {
    return 'starting';
  }
  if (!gsvOwners.length && voiceRows.some((row) => isGsvRow(row) && Number(row.AgeSec) < 60)) {
    return 'gsv-starting';
  }

  const env = voiceEnv();
  if (!gsvOwners.length) {
    if (Date.now() - lastGsvStartAt < START_COOLDOWN_MS) {
      return voxdOwners.length ? 'gsv-cooldown' : 'cooldown';
    }
    lastGsvStartAt = Date.now();
    const ok = await startHidden(
      `${settings.voiceRoot}/.venv-gsv/Scripts/python.exe`,
      ['-s', 'api_v2.py', '-a', '127.0.0.1', '-p', String(PORTS.gsv), '-c', `${settings.voiceRoot}/logs/gsv/tts_infer.yaml`],
      `${settings.voiceRoot}/vendor/GPT-SoVITS/code`,
      env,
    );
    if (!ok) return 'gsv-start-failed';
    scheduleHide();
    if (!(await waitPortOpen(PORTS.gsv, WAIT_GSV_MS))) return disposed ? 'aborted' : 'gsv-timeout';
  }

  if (disposed) return 'aborted';
  if (voxdOwners.length) return 'gsv-starting';
  if (Date.now() - lastVoxdStartAt < START_COOLDOWN_MS) return 'cooldown';
  lastVoxdStartAt = Date.now();
  const ok = await startHidden(
    `${settings.voiceRoot}/.venv/Scripts/python.exe`,
    ['-m', 'voxd', '--config', `${settings.voiceRoot}/config.toml`],
    settings.voiceRoot,
    env,
  );
  if (!ok) return 'start-failed';
  scheduleHide();
  return 'starting';
}

async function stopBridge(snap, { force = false } = {}) {
  const owners = pidsOn(snap, PORTS.bridge);
  const targets = uniquePids([...owners, ...matchingPids(snap, isBridgeProc)]);
  if (!targets.length) return 'already-off';
  if (owners.length && !owners.every((pid) => isOwnedBy(snap, pid, isBridgeProc))) {
    return 'port-conflict';
  }
  // surfcore 开着「随 DSH 启动 QQ」时，杀了也会在 2 分钟内被自愈拉回；
  // 峰时不抢停，直接报告 kept-auto。DSH 退出（force）时仍要停。
  if (!force) {
    const autoStart = readSurfcoreStartQQ();
    if (autoStart !== false) return autoStart === true ? 'kept-auto' : 'kept-unknown';
  }
  await stopPids(targets);
  const closed = await waitPortClosed(PORTS.bridge);
  return closed ? 'stopped' : 'stop-failed';
}

async function startBridge(snap) {
  const owners = pidsOn(snap, PORTS.bridge);
  if (!owners.length) return 'defer-to-surfcore';
  return owners.every((pid) => isOwnedBy(snap, pid, isBridgeProc)) ? 'already-on' : 'port-conflict';
}

// ── 弹窗清理：隐藏残留的控制台窗口（进程继续后台运行）──────────────────────
async function hidePopupWindows() {
  if (hideBusy || disposed) return;
  hideBusy = true;
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HIDE_PS1,
    ], PS_EXEC_OPTS);
    const lastLine = String(stdout).trim().split(/\r?\n/).pop();
    const count = Number(lastLine);
    if (Number.isInteger(count) && count > 0) {
      log(`已隐藏 ${count} 个弹窗窗口（服务继续后台运行）`);
    }
  } catch {}
  finally {
    hideBusy = false;
  }
}

/** 启动后分几个时间点扫弹窗，越早越不扎眼；dispose 时统一清掉 */
let lastHideScheduledAt = 0;
function scheduleHide() {
  if (disposed) return;
  const now = Date.now();
  if (now - lastHideScheduledAt < 30_000) return; // 同一轮启动只扫一遍
  lastHideScheduledAt = now;
  for (const ms of [1200, 4000, 10000, 25000]) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void hidePopupWindows();
    }, ms);
    timers.add(timer);
  }
}

// ── 一次巡检 ────────────────────────────────────────────────────────────────
function logSync(peak, results) {
  const key = `${peak ? 'peak' : 'valley'}|${results.join('|')}`;
  const now = Date.now();
  if (key === lastStateKey && now - lastStateLoggedAt < HEARTBEAT_LOG_MS) return;
  log(`${peak ? '峰时' : '谷时'}动作：SnowLuma=${results[0]} voice=${results[1]} bridge=${results[2]}`);
  lastStateKey = key;
  lastStateLoggedAt = now;
}

async function guarded(fn, label) {
  try {
    return await fn();
  } catch (error) {
    log(`${label} 动作异常：${errText(error).slice(0, 160)}`);
    return 'error';
  }
}

async function sync({ urgent = false } = {}) {
  if (disposed) return;
  if (syncBusy) { pendingSync = true; return; }
  if (!urgent && Date.now() - lastSyncAt < 10_000) return;
  syncBusy = true;
  lastSyncAt = Date.now();
  try {
    trimLogIfNeeded();
    checkHolidayCoverage();
    const snap = await snapshot();
    if (!snap.ok) {
      if (lastStateKey !== 'degraded') {
        log(`巡检跳过：无法枚举进程/端口（${snap.error || '未知错误'}）`);
        lastStateKey = 'degraded';
        lastStateLoggedAt = Date.now();
      }
      return;
    }
    if (disposed) return;

    if (isPeakNow()) {
      const snow = await guarded(() => stopSnowLuma(snap), 'SnowLuma');
      const voice = await guarded(() => stopVoice(snap), '语音');
      const bridge = await guarded(() => stopBridge(snap), 'QQ桥接');
      logSync(true, [snow, voice, bridge]);
    } else {
      const snow = await guarded(() => startSnowLuma(snap), 'SnowLuma');
      const voice = await guarded(() => startVoice(snap), '语音');
      const bridge = await guarded(() => startBridge(snap), 'QQ桥接');
      logSync(false, [snow, voice, bridge]);
    }
  } catch (error) {
    log(`巡检异常：${errText(error)}`);
  } finally {
    syncBusy = false;
    if (pendingSync && !disposed) {
      pendingSync = false;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void sync({ urgent: true });
      }, 0);
      timers.add(timer);
    }
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────
export default function peakValleyPlugin(ctx, config = {}) {
  if (globalThis[GUARD]) {
    log('插件已被加载过，跳过重复注册（防重复定时器/重复启动服务）');
    return;
  }
  globalThis[GUARD] = true;
  disposed = false;
  lastStateKey = '';
  lastStateLoggedAt = 0;
  lastHideScheduledAt = 0;
  applyConfig(config);

  log(`插件已激活：峰时=工作日 9-12 / 14-18（非法定节假日）；边界+${BOUNDARY_DELAY_MS / 1000}s 触发，心跳 ${SYNC_INTERVAL_MS / 60000} 分钟`);
  log(`SnowLuma=${settings.snowLumaDir}；语音根目录=${settings.voiceRoot}`);
  checkHolidayCoverage();
  if (readSurfcoreStartQQ() === true) {
    log('提示：surfcore 已开启「随 DSH 启动 QQ」，峰时不会停桥接（避免与 surfcore 的 2 分钟自愈互相打架）；要峰时停桥接请在 设置 → SurfCore → QQ 关闭该开关');
  }
  trimLogIfNeeded();
  scheduleHide();

  const first = setTimeout(() => {
    timers.delete(first);
    void sync();
  }, FIRST_SYNC_DELAY_MS);
  trackTimer(first);
  trackTimer(setInterval(() => { void sync(); }, SYNC_INTERVAL_MS));

  const scheduleBoundary = () => {
    if (disposed) return;
    const at = nextTransitionAt(Date.now());
    const delay = Math.max(1000, at - Date.now() + BOUNDARY_DELAY_MS);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void sync({ urgent: true });
      scheduleBoundary();
    }, delay);
    timers.add(timer);
  };
  scheduleBoundary();

  ctx.on('dispose', async () => {
    if (disposed) return;
    disposed = true;
    pendingSync = false;
    clearTimers();
    log('DSH 退出：停止大肥鱼服务（保持「未开 DSH 就没有大肥鱼」）');
    try {
      // 等在途巡检收手（最多 8 秒），避免它刚拉起服务就绕过了下面的停止；
      // sync 里每个长等待都会检查 disposed，正常 1 秒内就会退出。
      const deadline = Date.now() + 8_000;
      while (syncBusy && Date.now() < deadline) await sleep(200);
      const snap = await snapshot();
      if (snap.ok) {
        await stopSnowLuma(snap);
        await stopVoice(snap);
        await stopBridge(snap, { force: true });
      } else {
        log(`退出清理跳过：无法枚举进程（${snap.error || '未知错误'}）`);
      }
    } catch (error) {
      log(`退出清理失败：${errText(error)}`);
    } finally {
      globalThis[GUARD] = false;
    }
  });
}
