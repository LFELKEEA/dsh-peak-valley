import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('hide-windows.ps1 必须带 UTF-8 BOM：PowerShell 5.1 无 BOM 会把中文注释按 GBK 读坏，导致语法错误', () => {
  const raw = fs.readFileSync(path.join(root, 'hide-windows.ps1'));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '缺少 BOM');
  const text = raw.toString('utf8');
  assert.match(text, /param\(\[string\[\]\]\$Keywords/, '保留 -Keywords 参数');
  assert.match(text, /\.Split\(','\)/, '支持 -Keywords a,b,c 逗号串');
});

test('发布包里该带的文件都在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const file of ['lib/index.js', 'lib/discover.js', 'cordis.patch.yml', 'hide-windows.ps1', 'assets/icon.svg']) {
    assert.ok(fs.existsSync(path.join(root, file)), `缺少 ${file}`);
  }
  assert.ok(pkg.files.includes('lib'), 'files 要包含 lib（否则发出去没有代码）');
  assert.ok(pkg.files.includes('hide-windows.ps1'), 'files 要包含 hide-windows.ps1');
});