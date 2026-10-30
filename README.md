# dsh-peak-valley

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 用的**峰谷调度插件**：按北京时间的工作日峰时自动停掉本机的 SnowLuma 与语音服务，谷时再自动拉起。适合把「大肥鱼」常驻在 DSH 里、但不想在上班时段占用显卡/显存的人。

> English: A Windows-only DSH plugin that stops SnowLuma and local voice services during Beijing weekday peak hours (09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays) and starts them again off-peak.

## 峰谷规则

| 时间 | 行为 |
| --- | --- |
| 周一至周五 09:00–12:00、14:00–18:00（北京时间，非法定节假日） | **峰时**：停止 SnowLuma、语音服务；QQ 桥接按 surfcore 的设置决定是否停止 |
| 周末、法定节假日全天、工作日其余时间 | **谷时**：拉起 SnowLuma、语音服务（已在运行则跳过） |
| DSH 退出 | 停止上述全部服务，保持「不开 DSH 就没有大肥鱼」 |

节假日表按国务院公布的安排内置在 `lib/index.js` 的 `HOLIDAY_VALLEY` 中，目前覆盖 2026 年。每年 11 月公布次年安排后需要同步更新；当年份没有数据时，日志会提醒，不会静默把节假日当工作日。

## 它会动哪些进程

插件只操作**命令行身份匹配**的进程，不按端口盲杀：

- SnowLuma：`node.exe`，命令行同时包含 `snowluma` 和 `index.mjs`，监听 3000 或 3001；
- 语音：`python.exe`，命令行包含 `api_v2.py` 或 `voxd`，且位于 `voice-packs` / `surfvoicelocal` 目录；端口 8765（voxd）与 9880（GPT-SoVITS）；
- QQ 桥接：`node.exe`，命令行包含 `bridge.js` 和 `surfcore`，端口 3100。

端口被其他程序占用时，插件会记录 `port-conflict` 并跳过，不会杀掉身份对不上的进程。DSH 本体、QQ 客户端以及任何不匹配上述特征的进程都不会被触碰。

### 与 surfcore 的协调

如果本机装了 surfcore，并且开启了「随 DSH 启动 QQ」，surfcore 每 2 分钟会把桥接自愈拉回。此时峰时插件**不会**去停桥接（日志显示 `kept-auto`），否则两边会整点互杀。想让峰时真正停桥接，请在 **设置 → SurfCore → QQ** 关闭「随 DSH 启动 QQ」。DSH 退出时插件仍会强制停一次桥接。

## 安装

要求：Windows 10/11、DSH 0.2.x、PowerShell 5.1+。

### 通过 DSH 插件页（推荐）

打开 **插件 → 添加插件**，输入下面任意一种：

```text
github:LFELKEEA/dsh-peak-valley
```

```text
https://github.com/LFELKEEA/dsh-peak-valley
```

也可以使用 GitHub Release 里的预打包文件：

```text
https://github.com/LFELKEEA/dsh-peak-valley/releases/latest/download/dsh-peak-valley.tgz
```

安装后启用 `dsh-peak-valley`，重启 DSH 生效。

### 命令行

```sh
dsh plugin --profile <你的 profile> add github:LFELKEEA/dsh-peak-valley
```

## 配置

默认路径是插件作者的目录结构。**其他人的 SnowLuma / 语音装在哪里，需要改成自己的路径。**

在 profile 的 `cordis.patch.yml` 中加一条覆盖项（`<profile>` 通常是 `desktop` 或 `web`）：

```yaml
- id: dsh-peak-valley
  name: dsh-peak-valley
  config:
    snowLumaNode: D:/SnowLuma/node.exe
    snowLumaMain: D:/SnowLuma/index.mjs
    snowLumaDir: D:/SnowLuma
    voiceRoot: D:/Deepseek/工作区/surfcore/state/voice-packs/voice-local/surfvoicelocal-main
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `snowLumaNode` | `D:/SnowLuma/node.exe` | SnowLuma 使用的 node.exe |
| `snowLumaMain` | `D:/SnowLuma/index.mjs` | SnowLuma 入口文件 |
| `snowLumaDir` | `D:/SnowLuma` | SnowLuma 工作目录 |
| `voiceRoot` | surfcore 的 voice-local 目录 | 语音包根目录，需包含 `.venv`、`.venv-gsv`、`config.toml`、`vendor/GPT-SoVITS` |

也可以用环境变量覆盖（优先级低于配置文件，高于默认值）：

```text
PEAK_VALLEY_SNOWLUMA_NODE
PEAK_VALLEY_SNOWLUMA_MAIN
PEAK_VALLEY_SNOWLUMA_DIR
PEAK_VALLEY_VOICE_ROOT
```

没有语音服务、或没有 surfcore 的用户可以保持默认：插件找不到匹配进程时会报 `already-off` / `already-on`，不会报错，也不会影响 SnowLuma 的调度。

修改配置后重启 DSH。

## 运行细节

- 首次巡检在启动后 30 秒；之后每 10 分钟心跳一次。
- 峰谷边界按 09:00 / 12:00 / 14:00 / 18:00 对齐，边界后 2 秒触发，不依赖心跳的准点性。
- 同一服务 5 分钟内不重复拉起，避免启动失败时反复刷进程。
- 语音启动顺序：先 GPT-SoVITS（9880），最长等 45 秒，再起 voxd（8765）。
- 日志写在插件目录的 `peak-valley.log`（北京时间）；只在状态变化或每小时心跳时写。超过 2 MB 时原地保留最近 512 KB。
- 插件被重复加载时会跳过第二次注册，避免重复定时器和重复启动服务。

## 排错

| 日志 | 含义 / 处理 |
| --- | --- |
| `port-conflict` | 端口被其他程序占用，插件不会杀它。换端口或关掉占用者。 |
| `kept-auto` / `kept-unknown` | surfcore 开着「随 DSH 启动 QQ」，峰时不抢停桥接。要停请在 surfcore 设置里关掉该开关。 |
| `gsv-timeout` | GPT-SoVITS 45 秒内没监听 9880。检查 `voiceRoot`、`.venv-gsv` 和 `logs/gsv/tts_infer.yaml`。 |
| `start-failed` / `gsv-start-failed` | 启动命令执行失败。检查路径、Python 环境和日志里的报错。 |
| `巡检跳过：无法枚举进程/端口` | PowerShell 查询失败。检查 PowerShell 是否可用、是否有权限。 |
| `节假日表没有 XXXX 年的数据` | 更新 `lib/index.js` 的 `HOLIDAY_VALLEY`，或等插件新版本。 |

## 开发

```sh
npm test        # 峰谷判定 / 边界 / 进程身份 / surfcore 开关的单元测试
```

代码在 `lib/index.js`，只使用 Node 内置模块和 Windows PowerShell，没有运行时依赖。

## 许可

MIT。见 [LICENSE](LICENSE)。
