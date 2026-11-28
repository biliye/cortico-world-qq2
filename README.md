# QQ 2 for Coopanion / Cortico

通过 NapCat 的 OneBot 11 正向 WebSocket 收发 QQ 消息。支持群聊的攒批、专注、压缩和睡眠四档，按监听名单收取私聊和群聊，查找历史、读取合并转发、挂载图片和读取文件。发送工具会区分已入队、桥确认和结果未知。

## 安装与连接

1. 在 Cortico 或 Coopanion 的 World 扩展页按 npm 包名安装 `cortico-world-qq2`，然后重启。也可解压 Release 的 tarball，在包含 `package.json` 的目录运行 `pnpm install --prod` 后从本地导入。本地导入使用链接，请保留导入目录及其运行依赖。
2. 在 NapCat 开启 OneBot 11 WebSocket **服务器**，设置访问令牌。NapCat 同机时，可填 `ws://127.0.0.1:3001`，端口以 NapCat 配置为准。
3. 在「QQ 2」配置连接地址和令牌，添加允许接收的群号与私聊 QQ 号，再启用。现有官方 QQ World 使用相同的事件来源，切换时先停用旧 World。原有 QQ 2 配置仍在 `worlds.qq2`，工具仍用 `qq2_` 前缀。

如果此前安装过 World ID 同为 `qq2` 的本地旧版，安装正式包时移除旧版的安装条目即可沿用原设置和本地历史。

本包面向 World API 6，已在 Coopanion 0.2.16 和 Cortico 0.2.14 验证装载。语音合成和辅助看图需要配置相应服务。

QQ 语音条默认由 NapCat 的 `fetch_ptt_text` 调用 QQ 原生转写。QQ2 只传消息号并读取文字结果，无需本机转写服务。NapCat 缺少该动作或转写失败时会显示原因。升级沿用已有的转写开关和超时设置，旧的转写地址、端口、语言和大小上限设置可以删除。

在「QQ 2 → 语音」保存 MiniMax API Key 后，下一次语音合成即可使用。该面板只显示配置状态，Key 由宿主保存在部署的 .env 中，默认变量名为 `MINIMAX_API_KEY`。

收到 GIF 时会从首帧到末帧均匀取九帧，按行拼成一张 PNG 九宫图。原 GIF 与预览都保存在本地。自动看图和 `qq2_get_image` 默认使用九宫图，旧缓存中的 GIF 也能按需生成预览。要取回原 GIF，请给 `qq2_get_image` 传 `original: true`。字节完全相同的 GIF 沿用原图 SHA-256 查重。

重复来件按原件字节判定。重复图片显示已有编号和标签或可用的文件名，重复文件显示本次文件名和旧编号。需要把原件交给 DevShop 或其他扩展时，用 `qq2_get_attachment` 传完整的 `IMG-N` 或 `FILE-N`。工具回执将原件存入 Cortico 附件库，并提供文件名和 `log:` 句柄。图片原件用二进制附件交接，文件名和扩展名以回执为准。GIF 保留原动画，预览请用 `qq2_get_image`。初次取址或下载失败的文件可按原编号重试。

原名不符合 DevShop 的命名要求时，可在 `attachments` 的 `filename` 使用一个可用的文件名，继续传同一个句柄。例如将 `.gitignore` 导入为 `gitignore.txt`。

消息通过 NapCat 收发，已确认的消息可由宿主写入本地历史。发送结果未知时，请先去 QQ 核对。启用辅助视觉或语音合成后，相应媒体或文本会交给所配置的服务处理。

## 构建与发布

源码开发时，用 `pnpm install` 安装依赖，再运行 `pnpm typecheck`、`pnpm test`、`pnpm pack`。类型检查和测试使用同一源码工作区中的 Cortico checkout。安装包包含已构建的面板，运行只依赖宿主的扩展 API 和清单所列的 npm 依赖。

打包后，在干净目录解包、安装生产依赖，并用 Cortico 的 `check:extension` 检查解包产物。公开发行时，把验证通过的同一份 tarball 发到 npm。扩展市场通过清单里的 `cortico-world` 关键字收录。

## 许可

`src/onebot/` 中的 OneBot、消息解析、历史和视觉模块基于 [Cortico v0.2.17 的 QQ 源码](https://github.com/Pal-AI-Lab/Cortico/tree/v0.2.17/src/worlds/qq)，使用随包的 [MIT 许可](LICENSE)。QQ 2 扩展也采用 MIT 许可。
