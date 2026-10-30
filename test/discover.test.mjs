import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  discoverRuntime, inspectVoiceRoot, looksLikeSnowLuma, portFromConfigToml, portFromUrl,
  surfcoreRootFromCommandLine,
} from '../lib/discover.js';

/** 假的文件系统：dirs 是目录集合，files 是文件集合（都用正斜杠、大小写不敏感） */
function fakeProbe({ dirs = [], files = [] } = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const dirSet = new Set(dirs.map(norm));
  const fileSet = new Set(files.map(norm));
  const children = (dir) => {
    const base = norm(dir);
    const out = new Set();
    for (const entry of [...dirSet, ...fileSet]) {
      if (!entry.startsWith(`${base}/`)) continue;
      const rest = entry.slice(base.length + 1);
      if (!rest || rest.includes('/')) continue;
      out.add(rest);
    }
    return [...out];
  };
  return {
    isFile: (p) => fileSet.has(norm(p)),
    isDir: (p) => dirSet.has(norm(p)),
    list: children,
    read: (p) => (fileSet.has(norm(p)) ? '' : ''),
    realpath: (p) => p,
  };
}

test('SnowLuma 目录判定：只认含 index.mjs 的目录', () => {
  const probe = fakeProbe({ dirs: ['D:/SnowLuma', 'D:/NotLuma'], files: ['D:/SnowLuma/index.mjs'] });
  assert.equal(looksLikeSnowLuma('D:/SnowLuma', probe), true);
  assert.equal(looksLikeSnowLuma('D:/NotLuma', probe), false);
  assert.equal(looksLikeSnowLuma('D:/Missing', probe), false);
});

test('语音包判定：config.toml 必需，venv 决定能起哪个引擎', () => {
  const probe = fakeProbe({
    dirs: ['D:/packs/local'],
    files: ['D:/packs/local/config.toml', 'D:/packs/local/.venv/Scripts/python.exe'],
  });
  const info = inspectVoiceRoot('D:/packs/local', probe);
  assert.equal(info.voxd, true, '有 .venv 说明能起 voxd');
  assert.equal(info.gsv, false, '没有 .venv-gsv 就起不了 GSV');
  const none = fakeProbe({ dirs: ['D:/packs/empty'] });
  assert.equal(inspectVoiceRoot('D:/packs/empty', none).voxd, false);
});

test('端口解析：URL 与 voiceRoot/config.toml', () => {
  assert.equal(portFromUrl('http://127.0.0.1:3000', 9999), 3000);
  assert.equal(portFromUrl('ws://127.0.0.1:3001/ws', 9999), 3001);
  assert.equal(portFromUrl('', 8765), 8765);
  assert.equal(portFromUrl('http://127.0.0.1', 3100), 3100);
  assert.equal(portFromConfigToml('[engine]\ngsv_url = "http://127.0.0.1:9881"\n', 9880), 9881);
  assert.equal(portFromConfigToml('nothing here', 9880), 9880);
});

test('从 bridge.js 命令行反推 surfcore 仓库根', () => {
  assert.equal(
    surfcoreRootFromCommandLine('node.exe D:\\tools\\surfcore\\src\\bridge.js --x'),
    path.resolve('D:/tools/surfcore'),
  );
  assert.equal(surfcoreRootFromCommandLine('node.exe D:\\app\\other.js'), '');
});

test('自动发现：surfcore 配置优先，其次常见目录；端口从配置推导', () => {
  const home = 'C:/Users/someone/.dsh';
  const probe = fakeProbe({
    dirs: [
      'D:/SnowLuma',
      'D:/other/SnowLuma',
      'D:/tools/surfcore',
      'D:/tools/surfcore/state',
      'D:/tools/surfcore/state/voice-packs',
      'D:/tools/surfcore/state/voice-packs/voice-local',
      'D:/tools/surfcore/state/voice-packs/voice-local/pack',
      'C:/Users/someone/.dsh/plugins',
      'C:/Users/someone/.dsh/plugins/surfcore',
    ],
    files: [
      'D:/SnowLuma/index.mjs',
      'D:/SnowLuma/node.exe',
      'D:/tools/surfcore/config.json',
      'D:/tools/surfcore/state/voice-packs/voice-local/pack/config.toml',
      'D:/tools/surfcore/state/voice-packs/voice-local/pack/.venv/Scripts/python.exe',
      'D:/tools/surfcore/state/voice-packs/voice-local/pack/.venv-gsv/Scripts/python.exe',
    ],
  });
  const surfcoreConfig = {
    snowluma: { homeDir: 'D:/SnowLuma', httpUrl: 'http://127.0.0.1:3010' },
    socialV2: { voice: { tts: { baseUrl: 'http://127.0.0.1:8770' } } },
  };
  // 让 readJsonFile 能读到配置：把 surfcore 配置写进 fake read
  const withConfig = {
    ...probe,
    read: (file) => (String(file).replace(/\\/g, '/').toLowerCase().endsWith('.dsh/surfcore/config.json')
      ? JSON.stringify(surfcoreConfig) : ''),
    // ~/.dsh/plugins/surfcore 是指向 <repo>/plugins/surfcore 的软链
    realpath: (p) => (/\.dsh\/plugins\/surfcore$/i.test(String(p).replace(/\\/g, '/'))
      ? 'D:/tools/surfcore/plugins/surfcore' : p),
  };
  const runtime = discoverRuntime({}, {
    env: { DSH_HOME: home, LOCALAPPDATA: 'C:/Users/someone/AppData/Local' },
    home,
    probe: withConfig,
  });
  assert.equal(runtime.snowLumaDir, 'D:/SnowLuma', '从 surfcore 配置拿到 SnowLuma 目录');
  assert.equal(runtime.snowLumaMain, path.join('D:/SnowLuma', 'index.mjs'), '入口默认在目录里');
  assert.equal(runtime.ports.snow, 3010, 'SnowLuma 端口跟 surfcore 的 httpUrl 走');
  assert.equal(runtime.ports.voxd, 8770, 'voxd 端口跟 tts.baseUrl 走');
  assert.equal(runtime.voice.voxd, true);
  assert.equal(runtime.voice.gsv, true);
});

test('自动发现：什么都没装时全部为空，但端口有默认值', () => {
  const home = 'C:/Users/nobody/.dsh';
  const probe = fakeProbe({ dirs: ['C:/Windows'], files: [] });
  const runtime = discoverRuntime({}, { env: { DSH_HOME: home }, home, probe });
  assert.equal(runtime.snowLumaDir, '');
  assert.equal(runtime.snowLumaMain, '');
  assert.equal(runtime.voiceRoot, '');
  assert.equal(runtime.voice.voxd, false);
  assert.equal(runtime.voice.gsv, false);
  assert.deepEqual(runtime.ports, { snow: 3000, bridge: 3100, voxd: 8765, gsv: 9880 });
  assert.equal(runtime.snowLumaSource, '未找到');
});

test('插件 config 覆盖自动发现', () => {
  const home = 'C:/Users/nobody/.dsh';
  const probe = fakeProbe({ dirs: ['D:/SnowLuma'], files: ['D:/SnowLuma/index.mjs', 'D:/SnowLuma/node.exe'] });
  const runtime = discoverRuntime({ snowLumaDir: 'E:/MyBot', voiceRoot: 'E:/MyVoice' }, {
    env: { DSH_HOME: home }, home, probe,
  });
  assert.equal(runtime.snowLumaDir, 'E:/MyBot');
  assert.equal(runtime.snowLumaNode, path.join('E:/MyBot', 'node.exe'));
  assert.equal(runtime.voiceRoot, 'E:/MyVoice');
});