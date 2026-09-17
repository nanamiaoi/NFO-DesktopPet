# 桌宠

一个用 Electron 做的简易桌面宠物

## 开发运行

```bash
npm install
npm start
```

启动后会弹出**角色选择窗口**。勾选「记住选择」后，下次会直接用该角色启动。

### 指定角色启动

```bash
npm start -- --character=yukina2
```

### 强制重新选角

```bash
npm run pick
```

PowerShell 若提示禁止运行脚本，请用 `npm.cmd run dist`，或在 cmd 里执行 `npm run dist`。

## 操作

- 拖拽：队头挣扎；身后队员像有重力的链子自然下垂、随甩摆荡
- 单击：倒下再爬起复活
- 右键菜单：
  - 行动模式：自由行动 / 跟随鼠标 / 勿扰（走到角落待机）
  - 打开选角窗口（可多选）
  - 大小设置（100% 原图像素 ~ 200% 放大）
  - 关闭此角色 / 退出全部

## 多角色

选角时可一次勾选多个。相遇后会排成队伍：新人跟到当前队尾；两支队伍相遇时，较小的一支会接到较大一支的队尾。约 **5 分钟** 后散开各自闲逛；散队后约 90 秒内不会立刻再结伴。

## 素材

把角色帧放进 `assets/`，命名规则：

```text
{角色名}_idle_01.png ~ _04.png
{角色名}_run_01.png  ~ _04.png
{角色名}_dead_01.png ~ _04.png
```

当前已识别：`ako` / `ako2` / `lisa` / `lisa2` / `rinko` / `rinko2` / `sayo` / `sayo2` / `yukina` / `yukina2`

### 角色单独缩放

素材大小不一时，在 `characters.js` 的 `CHARACTER_SCALE` 里按角色改倍率（`1` 为默认，可与右键「大小设置」叠乘）：

```js
const CHARACTER_SCALE = {
  rinko2: 1.0,
  lisa2: 0.9,
  sayo: 1.45,
  // ...
};
```

