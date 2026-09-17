# NFO roselia桌宠

一个用 Electron 做的简易桌面宠物，素材来源于游戏

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

- 拖拽：被拖拽角色挣扎；身后队员自然下垂
- 单击：倒下
- 右键菜单：
  - 行动模式：自由行动 / 跟随鼠标 / 勿扰
  - 打开选角窗口（可多选）
  - 大小设置（100% 原图像素 ~ 200% 放大）
  - 关闭此角色 / 退出全部

## 多角色

选角时可一次勾选多个。相遇后会组队。
约 **5 分钟** 后散开各自闲逛；散队后约 90 秒内不会立刻再结伴。

## 素材

全部来源于BanGDream游戏，无个人原创与AI生成部分

当前已识别：`ako` / `ako2` / `lisa` / `lisa2` / `rinko` / `rinko2` / `sayo` / `sayo2` / `yukina` / `yukina2`

### 角色单独缩放

因为角色素材大小不一，所以使用了固定倍率进行修改和统一。
在 `characters.js` 的 `CHARACTER_SCALE` 里按角色改倍率（`1` 为默认，可与右键「大小设置」叠乘）：

```js
const CHARACTER_SCALE = {
  rinko2: 1.0,
  lisa2: 0.9,
  sayo: 1.45,
  // ...
};
```

