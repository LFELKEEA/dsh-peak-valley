import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyConfig, isBridgeProc, isPeakAt, isSnowLumaProc, isVoiceProc, nextTransitionAt, readSurfcoreStartQQ,
} from '../lib/index.js';

const bj = (text) => Date.parse(`${text}+08:00`);

test('峰谷判定：工作日 / 午休 / 周末 / 法定节假日', () => {
  assert.equal(isPeakAt(bj('2026-10-30T10:00:00')), true, '周五上午是峰时');
  assert.equal(isPeakAt(bj('2026-10-30T12:00:00')), false, '12:00 整进入谷时');
  assert.equal(isPeakAt(bj('2026-10-30T13:59:59')), false, '午休是谷时');
  assert.equal(isPeakAt(bj('2026-10-30T14:00:00')), true, '14:00 整进入峰时');
  assert.equal(isPeakAt(bj('2026-10-30T18:00:00')), false, '18:00 整进入谷时');
  assert.equal(isPeakAt(bj('2026-10-31T10:00:00')), false, '周六是谷时');
  assert.equal(isPeakAt(bj('2026-10-01T10:00:00')), false, '国庆是谷时');
  assert.equal(isPeakAt(bj('2026-11-02T14:30:00')), true, '节后周一 14:30 是峰时');
});

test('下一个边界：9/12/14/18 点对齐', () => {
  assert.equal(nextTransitionAt(bj('2026-10-30T08:00:00')), bj('2026-10-30T09:00:00'));
  assert.equal(nextTransitionAt(bj('2026-10-30T12:30:00')), bj('2026-10-30T14:00:00'));
  assert.equal(nextTransitionAt(bj('2026-10-30T18:30:00')), bj('2026-10-31T09:00:00'));
  assert.equal(nextTransitionAt(bj('2026-10-30T23:00:00')), bj('2026-10-31T09:00:00'));
  assert.equal(nextTransitionAt(bj('2026-10-30T09:00:00')), bj('2026-10-30T12:00:00'), '边界当刻不重复调度过去时间');
});

test('进程身份：只认 SnowLuma / voice-packs / surfcore bridge.js', () => {
  assert.equal(isSnowLumaProc({ Name: 'node.exe', CommandLine: 'D:/SnowLuma/node.exe D:/SnowLuma/index.mjs' }), true);
  assert.equal(isSnowLumaProc({ Name: 'node.exe', CommandLine: 'D:\\SnowLuma\\node.exe D:\\SnowLuma\\index.mjs' }), true);
  assert.equal(isSnowLumaProc({ Name: 'node.exe', CommandLine: 'node C:/other/index.mjs' }), false);
  assert.equal(isSnowLumaProc({ Name: 'python.exe', CommandLine: 'node SnowLuma/index.mjs' }), false);

  assert.equal(isVoiceProc({
    Name: 'python.exe',
    CommandLine: 'python.exe -m voxd --config D:\\Deepseek\\工作区\\surfcore\\state\\voice-packs\\voice-local\\surfvoicelocal-main\\config.toml',
  }), true);
  assert.equal(isVoiceProc({
    Name: 'python.exe',
    CommandLine: 'python.exe -s api_v2.py -a 127.0.0.1 -p 9880 -c D:\\x\\voice-packs\\tts_infer.yaml',
  }), true);
  assert.equal(isVoiceProc({ Name: 'python.exe', CommandLine: 'python.exe -m http.server 8765' }), false);
  assert.equal(isVoiceProc({ Name: 'node.exe', CommandLine: 'node voxd voice-packs' }), false);

  assert.equal(isBridgeProc({
    Name: 'node.exe',
    CommandLine: 'node.exe D:\\Deepseek\\工作区\\surfcore\\src\\bridge.js',
  }), true);
  assert.equal(isBridgeProc({ Name: 'node.exe', CommandLine: 'node C:\\app\\bridge.js' }), false);
  assert.equal(isBridgeProc({ Name: 'node.exe', CommandLine: 'node surfcore\\other.js' }), false);
});

test('自定义 voiceRoot 后仍能识别语音进程', () => {
  applyConfig({ voiceRoot: 'D:/MyVoice/pack-local' });
  try {
    assert.equal(isVoiceProc({
      Name: 'python.exe',
      CommandLine: 'python.exe -m voxd --config D:\\MyVoice\\pack-local\\config.toml',
    }), true);
    assert.equal(isVoiceProc({
      Name: 'python.exe',
      CommandLine: 'python.exe -m http.server 8765',
    }), false);
  } finally {
    applyConfig({});
  }
});

test('surfcore 自动启动 QQ 开关：新字段 > 旧字段 > enabled 列表 > 默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-valley-test-'));
  const file = path.join(dir, 'config.json');
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');

  try {
    write({ platforms: { start: { qq: false } }, bridge: { autoStart: true } });
    assert.equal(readSurfcoreStartQQ(file), false, '新字段优先');

    write({ bridge: { autoStart: false } });
    assert.equal(readSurfcoreStartQQ(file), false, '旧字段迁移');

    write({ platforms: { enabled: ['bili'] } });
    assert.equal(readSurfcoreStartQQ(file), false, 'enabled 列表');

    write({});
    assert.equal(readSurfcoreStartQQ(file), true, 'surfcore 默认开启');

    fs.writeFileSync(file, '{not json', 'utf8');
    assert.equal(readSurfcoreStartQQ(file), null, '读不到配置返回 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
