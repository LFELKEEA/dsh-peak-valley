import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { pickGsvConfig } = await import('../lib/index.js');

test('GSV 配置：语音包自己的 logs/gsv 优先，其次 vendor，最后返回空串', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-gsv-'));
  try {
    assert.equal(pickGsvConfig(root), '', '什么都没有时返回空串，不能返回不存在的路径');

    const vendor = path.join(root, 'vendor', 'GPT-SoVITS', 'code', 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
    fs.mkdirSync(path.dirname(vendor), { recursive: true });
    fs.writeFileSync(vendor, 'device: cpu\n');
    assert.equal(pickGsvConfig(root), vendor, '只有 vendor 时用 vendor 的');

    const own = path.join(root, 'logs', 'gsv', 'tts_infer.yaml');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'device: cpu\n');
    assert.equal(pickGsvConfig(root), own, '自己生成的那份优先');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});