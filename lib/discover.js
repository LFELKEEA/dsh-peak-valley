/**
 * 自动发现 SnowLuma / 语音包 / surfcore 的位置与端口。
 *
 * 目标：别人下载这个插件后不改配置也能用。
 * 查找顺序（越靠前优先级越高）：
 *   1. 插件 config（profile 的 cordis.patch.yml）
 *   2. 环境变量 PEAK_VALLEY_*
 *   3. surfcore 的 config.json（snowluma.homeDir / launcherPath / 端口 / tts.baseUrl）
 *   4. 运行中的 bridge.js 命令行、~/.dsh/plugins/surfcore 软链 → 推断 surfcore 仓库根
 *   5. 常见安装目录扫描（%LOCALAPPDATA%、%USERPROFILE%、%ProgramFiles%、
 *      Downloads/Desktop、各盘根目录下的 SnowLuma 等）
 *
 * 全部用纯 Node 内置模块，方便单元测试注入 probe。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realIsFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const realIsDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const realList = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};
const realRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const realRealpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const PROBE = {
  isFile: realIsFile,
  isDir: realIsDir,
  list: realList,
  read: realRead,
  realpath: realRealpath,
};

export function readJsonFile(file, probe = PROBE) {
  const text = probe.read(file);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function surfcoreConfigPath(home = dshHome()) {
  return path.join(home, 'surfcore', 'config.json');
}

function pushUnique(list, value) {
  if (!value || typeof value !== 'string') return;
  const normalized = path.resolve(value.trim()).replace(/\\/g, '/');
  if (!list.some((item) => item.replace(/\\/g, '/').toLowerCase() === normalized.toLowerCase())) {
    list.push(value.trim());
  }
}

/** SnowLuma 目录长得对不对：至少要有 index.mjs（node.exe 是它自带的，可选） */
export function looksLikeSnowLuma(dir, probe = PROBE) {
  if (!dir || !probe.isDir(dir)) return false;
  return probe.isFile(path.join(dir, 'index.mjs'));
}

/** 语音包根目录长得对不对：config.toml 是必需项，venv 决定能起哪个引擎 */
export function inspectVoiceRoot(dir, probe = PROBE) {
  const root = { dir: dir || '', configToml: false, voxd: false, gsv: false, gsvConfig: false };
  if (!dir || !probe.isDir(dir)) return root;
  root.configToml = probe.isFile(path.join(dir, 'config.toml'));
  root.voxd = root.configToml && probe.isFile(path.join(dir, '.venv', 'Scripts', 'python.exe'));
  root.gsvConfig = probe.isFile(path.join(dir, 'logs', 'gsv', 'tts_infer.yaml'));
  root.gsv = probe.isFile(path.join(dir, '.venv-gsv', 'Scripts', 'python.exe'));
  return root;
}

export function portFromUrl(url, fallback) {
  if (typeof url !== 'string' || !url) return fallback;
  const match = /:(\d{2,5})(?:[/?#]|$)/.exec(url);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/** voiceRoot/config.toml 里的 gsv_url 决定 GPT-SoVITS 端口 */
export function portFromConfigToml(text, fallback) {
  const match = /gsv_url\s*=\s*["']([^"']+)["']/.exec(String(text || ''));
  return match ? portFromUrl(match[1], fallback) : fallback;
}

/** 给定 surfcore 配置，推断仓库根（配置里没有，只能从 bridge 进程 / 插件软链推断） */
export function surfcoreRootCandidates({ env = process.env, home = dshHome(env), probe = PROBE } = {}) {
  const list = [];
  pushUnique(list, env.PEAK_VALLEY_SURFCORE_ROOT);
  const pluginLink = path.join(home, 'plugins', 'surfcore');
  if (probe.isDir(pluginLink)) {
    // ~/.dsh/plugins/surfcore → <repo>/plugins/surfcore
    const real = probe.realpath(pluginLink);
    pushUnique(list, path.resolve(real, '..', '..'));
    pushUnique(list, real);
  }
  for (const candidate of [path.join(home, 'surfcore'), path.resolve(home, '..', 'surfcore')]) {
    if (probe.isDir(candidate)) pushUnique(list, candidate);
  }
  return list;
}

/** 从 `node .../surfcore/src/bridge.js` 这种命令行反推仓库根 */
export function surfcoreRootFromCommandLine(commandLine) {
  const cmd = String(commandLine || '').replace(/\\/g, '/');
  const match = /(^|[\s"'])([A-Za-z]:\/[^"']*?)\/src\/bridge\.js/i.exec(cmd);
  if (match) return path.resolve(match[2]);
  return '';
}

export function snowLumaCandidates({ env = process.env, home = dshHome(env), surfcoreConfig = null, probe = PROBE } = {}) {
  const list = [];
  pushUnique(list, env.PEAK_VALLEY_SNOWLUMA_DIR);
  const cfg = surfcoreConfig || {};
  pushUnique(list, cfg?.snowluma?.homeDir);
  const launcher = cfg?.snowluma?.launcherPath;
  if (typeof launcher === 'string' && launcher.trim()) {
    // launcherPath 可能是目录，也可能是 launcher.bat
    pushUnique(list, /\.(bat|cmd|exe)$/i.test(launcher.trim()) ? path.dirname(launcher.trim()) : launcher.trim());
  }
  const userHome = home && path.dirname(home) ? path.dirname(home) : os.homedir();
  const bases = [
    env.LOCALAPPDATA,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    userHome,
    path.join(userHome, 'Desktop'),
    path.join(userHome, 'Downloads'),
    path.join(userHome, 'Documents'),
  ].filter(Boolean);
  for (const base of bases) pushUnique(list, path.join(base, 'SnowLuma'));
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) pushUnique(list, `${drive}:/SnowLuma`);
  }
  return list;
}

export function voiceRootCandidates({ env = process.env, home = dshHome(env), surfcoreConfig = null, surfcoreRoots = [], probe = PROBE } = {}) {
  const list = [];
  pushUnique(list, env.PEAK_VALLEY_VOICE_ROOT);
  const cfg = surfcoreConfig || {};
  const packsDir = cfg?.voicePacks?.dir;
  const roots = [];
  for (const root of surfcoreRoots) if (probe.isDir(root)) roots.push(root);
  const packDirs = [];
  if (typeof packsDir === 'string' && packsDir.trim()) {
    packDirs.push(path.resolve(packsDir.trim()));
    for (const root of roots) packDirs.push(path.join(root, packsDir.trim()));
  }
  for (const root of roots) packDirs.push(path.join(root, 'state', 'voice-packs'));
  packDirs.push(path.join(home, 'voice-packs'));

  for (const dir of packDirs) {
    if (!probe.isDir(dir)) continue;
    // <packs>/voice-local/<某个包>/ —— 包里可能有 surfvoicelocal-main 这一层
    for (const child of probe.list(dir)) {
      const local = path.join(dir, child);
      pushUnique(list, local);
      if (!probe.isDir(local)) continue;
      for (const inner of probe.list(local)) {
        pushUnique(list, path.join(local, inner));
      }
    }
  }
  return list;
}

function deepFill(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepFill(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

/**
 * 汇总一次运行环境。config = 插件配置；未提供的字段全部走自动发现。
 * 返回的 source 说明每个值是从哪来的，方便日志和排错。
 */
export function discoverRuntime(config = {}, { env = process.env, home = dshHome(env), probe = PROBE, bridgeCommandLine = '' } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};

  const surfcoreRoots = surfcoreRootCandidates({ env, home, probe });
  const fromBridge = surfcoreRootFromCommandLine(bridgeCommandLine);
  if (fromBridge) pushUnique(surfcoreRoots, fromBridge);

  // surfcore 的配置可能在 DSH 状态目录，也可能在仓库根；两处都读，后读的只补缺失字段
  const surfcoreConfig = {};
  const configFiles = [surfcoreConfigPath(home)];
  for (const root of surfcoreRoots) configFiles.push(path.join(root, 'config.json'));
  for (const file of configFiles) {
    const parsed = readJsonFile(file, probe);
    if (parsed && typeof parsed === 'object') deepFill(surfcoreConfig, parsed);
  }

  const picks = [];
  const pick = (value, source) => {
    if (typeof value === 'string' && value.trim()) picks.push({ value: value.trim(), source });
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  };

  // ── SnowLuma ──
  let snowLumaDir = pick(cfg.snowLumaDir, '插件配置 snowLumaDir') || pick(env.PEAK_VALLEY_SNOWLUMA_DIR, '环境变量 PEAK_VALLEY_SNOWLUMA_DIR');
  if (!snowLumaDir) {
    for (const dir of snowLumaCandidates({ env, home, surfcoreConfig, probe })) {
      if (!looksLikeSnowLuma(dir, probe)) continue;
      snowLumaDir = dir;
      picks.push({ value: dir, source: dirsMatch(dir, surfcoreConfig) ? 'surfcore 配置 snowluma' : '自动扫描常见目录' });
      break;
    }
  }

  let snowLumaNode = pick(cfg.snowLumaNode, '插件配置 snowLumaNode') || pick(env.PEAK_VALLEY_SNOWLUMA_NODE, '环境变量 PEAK_VALLEY_SNOWLUMA_NODE');
  if (!snowLumaNode) snowLumaNode = snowLumaDir ? path.join(snowLumaDir, 'node.exe') : '';
  let snowLumaMain = pick(cfg.snowLumaMain, '插件配置 snowLumaMain') || pick(env.PEAK_VALLEY_SNOWLUMA_MAIN, '环境变量 PEAK_VALLEY_SNOWLUMA_MAIN');
  if (!snowLumaMain) snowLumaMain = snowLumaDir ? path.join(snowLumaDir, 'index.mjs') : '';

  // ── 语音包 ──
  let voiceRoot = pick(cfg.voiceRoot, '插件配置 voiceRoot') || pick(env.PEAK_VALLEY_VOICE_ROOT, '环境变量 PEAK_VALLEY_VOICE_ROOT');
  if (!voiceRoot) {
    for (const dir of voiceRootCandidates({ env, home, surfcoreConfig, surfcoreRoots, probe })) {
      const info = inspectVoiceRoot(dir, probe);
      if (!info.voxd && !info.gsv) continue;
      voiceRoot = dir;
      picks.push({ value: dir, source: 'surfcore 语音包目录自动扫描' });
      break;
    }
  }
  const voice = inspectVoiceRoot(voiceRoot, probe);

  // ── 端口 ──
  const ports = {
    snow: Number(cfg.snowLumaPort) || portFromUrl(surfcoreConfig?.snowluma?.httpUrl, 3000),
    bridge: Number(cfg.bridgePort) || portFromUrl(surfcoreConfig?.consoleUrl, 3100),
    voxd: Number(cfg.voxdPort) || portFromUrl(surfcoreConfig?.socialV2?.voice?.tts?.baseUrl, 8765),
    gsv: Number(cfg.gsvPort) || portFromConfigToml(voiceRoot ? probe.read(path.join(voiceRoot, 'config.toml')) : '', 9880),
  };

  return {
    snowLumaDir,
    snowLumaNode,
    snowLumaMain,
    voiceRoot,
    voice,
    surfcoreRoots,
    surfcoreConfig,
    ports,
    picks,
    snowLumaSource: picks.find((p) => p.value === snowLumaDir)?.source || (snowLumaDir ? '未知' : '未找到'),
    voiceSource: picks.find((p) => p.value === voiceRoot)?.source || (voiceRoot ? '未知' : '未找到'),
  };
}

function dirsMatch(dir, surfcoreConfig) {
  const home = surfcoreConfig?.snowluma?.homeDir;
  return Boolean(home && path.resolve(home).toLowerCase() === path.resolve(dir).toLowerCase());
}