# @omnidebuglink/react-native

OmniDebugLink React Native client SDK — 把 React Native App 接入 AI 远程调试。

## 安装（GitHub git 依赖，不发布 npm）

```bash
npm install omnidebuglink/omnidebuglink_react_native#v0.1.0
cd ios && pod install        # iOS autolinking（RN 0.60+；Android 自动）
```

或在 `package.json` 里锁版本：

```json
"dependencies": {
  "@omnidebuglink/react-native": "omnidebuglink/omnidebuglink_react_native#v0.1.0"
}
```

无需手动改 `MainApplication.kt` / `AppDelegate` —— RN CLI autolinking 会自动注册 `OmlReactPackage` 和 pod（dist 构建产物已提交进仓库，git 安装开箱即用）。

**Expo**：bare / prebuild workflow 可用（`npx expo prebuild` 后照常）；managed + `expo-dev-client` 可用（需重建 dev client）；**Expo Go 不可用**（不含第三方原生模块）。

## 快速开始

```typescript
import { OmniDebugLink } from '@omnidebuglink/react-native';

const client = new OmniDebugLink({
  onLog: (msg) => console.log('[ODL]', msg),
  onStateChange: (connected) => console.log('[ODL] connected:', connected),
});

client.start('your-client-token-here'); // 控制台获取

// 可选：让 get_state 上报路由栈（react-navigation）
OmniDebugLink.setNavigator(navigationRef.current);

// 注册自定义 task（注册表变化自动重发 hello）
client.registry.register(
  'my_task',
  async (payload) => ({ status: 'done' }),
  '做一件事，返回 status。',
  { type: 'object', properties: { value: { type: 'string' } } },
);

client.stop();
```

## API

### `new OmniDebugLink(options?)`

| 选项 | 默认 | 说明 |
|---|---|---|
| `onLog` | — | 日志回调 |
| `onStateChange` | — | 连接状态回调 |
| `captureConsole` | `true` | patch console.log/warn/error 进日志缓冲（供 read_logs） |

构造时自动安装 `ErrorUtils.setGlobalHandler` 捕获 JS 全局异常（红屏/Fatal）进日志缓冲。

### `start(token)` / `stop()`

连接 `wss://api.omnidebuglink.dev/ws?token=<token>`；stop 后不再重连。断线自动指数退避重连（1s→30s）；**关闭码 4000（token 被顶替）永久停机**。

### `setActionsEnabled(bool)`

写操作总开关。`false` 时所有 write task 返回 `ACTION_DISABLED`，变更自动重发 hello。

### `OmniDebugLink.setNavigator(nav)`

静态方法。注册 react-navigation 的 navigation 对象（或 ref.current），get_state 即可上报路由栈。不注册则 `routes: null` + 引导提示。

### `registry.register(type, handler, description?, schema?, { write })`

注册自定义 task；`write: true` 标记写操作（受 actionsEnabled 拦截）。

## 内置 task（18 个 + dev 构建 1 个）

**纯 JS（无需原生）：**

| type | write | 说明 |
|---|---|---|
| `echo` / `ping` / `get_stats` | no | 连通性三件套 |
| `read_logs` | no | 日志缓冲 500 行：console + 全局异常 + SDK 事件；level/contains/sinceMs 过滤 |
| `find_objects` | no | 按 text/type/id 子串查节点，返回中心 px + 归一化坐标 + 原子操作提示 |
| `wait_for` | no | 200ms 轮询等待节点出现，超时 `found:false` 不报错 |
| `reload` | yes | 重载 JS bundle（等同 dev 菜单 Reload）。**dev 构建才注册**；配合 metro 实现"AI 改代码→reload→验证"闭环 |

**需要原生模块（OmlReactModule，autolinking 自动链接）：**

| type | write | 说明 |
|---|---|---|
| `screenshot` | no | JPEG + `__odl_file` 信封；超预算先降质、到底后降采样 |
| `ui_traverse` | no | View 树 dump，**默认 flat 平铺**（省 token），`flat:false` 嵌套；3000 节点封顶；屏幕绝对像素左上原点 |
| `tap_screen` | yes | 归一化 [0,1] 点击，左上原点 |
| `long_press` | yes | 归一化坐标长按（默认 800ms） |
| `swipe` | yes | 归一化滑动手势，durationMs 可控 |
| `ui_click` | yes | **text/type/index/fieldId 定位，单次调用内 find+click 原子完成**（React tag 会随 re-render 失效，优先 text/type） |
| `input_text` | yes | fieldId/type+index 定位字段写入；text 是要输入的值 |
| `send_key` | yes | Android: back/home/recents；iOS: enter/escape/backspace/tab/space（软派发） |
| `get_state` | no | 屏幕/网络/原生 Activity·VC 栈 + react-navigation 路由栈（需 setNavigator） |
| `get_perf` | no | ~1s fps 采样（p50/p95/p99 帧耗）+ 进程内存（Android java堆/PSS；iOS resident/available） |
| `view_component` | no | 单节点详情：布局 + 原生视图状态（alpha/visibility/enabled/focused…） |
| `prefs` | no/yes | 读写**原生**偏好（SharedPreferences / NSUserDefaults）；get/set/delete/list，valueType 强转 |

原生模块未链接时这些 task 返回 `TASK_FAILED` 并带安装指引，不影响纯 JS task。

## 原生实现说明

**Android（Kotlin）**：`android/` — 触摸注入直接 `dispatchTouchEvent` 到 decorView（同进程无需权限）；长按用 `postDelayed` 保持（UI 线程不 sleep）；swipe 全轨迹同步派发（事件时间戳单调，识别器从时间戳推速度）；fps 用 Choreographer 主线程采样 1s；Activity 栈经 `ActivityLifecycleCallbacks` 维护；inputText/view_component 的 tag 解析走 `UIManagerModule.resolveView`（**仅 Paper 架构**，Fabric 下报错引导）。

**iOS（Swift）**：`ios/` — 触摸注入合成 UITouch（KVC 写 `_phase/_window/_locationInWindow` 等私有字段）经 `UIWindow.sendEvent` 投递；键盘事件经第一响应者捕获（`UIApplication.sendAction(to: nil)` 响应链技巧，无私有 API）+ UIKeyInput；fps 用 CADisplayLink；网络探测 NWPathMonitor（500ms 超时兜底）。

**坐标**：一律**左上原点**。归一化坐标相对全屏 window；ui_traverse 返回屏幕绝对像素（Android px / iOS pt）。

## 已知限制

- `input_text` / `view_component` / `ui_click`(by fieldId) 在 Android **Fabric 新架构**下依赖的 `UIManagerModule` 不可用，返回错误提示切回 Paper（RN 0.76+ 默认 Fabric，可在 gradle.properties 关 `newArchEnabled`）；text/type 定位的 ui_click 走原生 find 不受影响；screenshot/ui_traverse/tap/swipe/get_state/get_perf 不依赖 UIManager，Fabric 可用
- `input_text` 对完全受控组件（value 由 JS state 驱动）可能被 re-render 覆盖——Android setText 触发 TextWatcher→onChange 同步回 JS，iOS 走 `editingChanged`，多数场景可同步；受控 TextInput 建议事后验证
- iOS 触摸注入依赖 UITouch 私有字段（同所有进程内注入方案），iOS 大版本更新可能需适配
- `prefs` 只覆盖原生偏好存储；RN AsyncStorage（SQLite）/MMKV 数据不可见——用自定义 task 包装自己的存储
- `reload` 期间设备连接断开，依赖自动重连恢复（task 返回先于断开）

## 文档

- 协议与开发指引：[clients/guide/zh/third-party-client-guide.md](../guide/zh/third-party-client-guide.md)
- 本组件开发文档：[CLAUDE.md](./CLAUDE.md)
