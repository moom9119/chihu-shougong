# 花朵图鉴插画

9 张插画来自用户上传的原图，统一处理过：

- 原图 768×1024 RGBA（自带透明背景）
- 按 alpha 裁掉四周空白 → 居中放进正方形画布（留 6% 边距）→ 缩放到 **256×256**
- PNG 优化后单张 32–67 KB，总计约 440 KB

| 文件 | 花名 | 花语 | 星级 | 稀有度 | 抽取权重 |
|---|---|---|---|---|---|
| `daisy.png` | 小雏菊 | 纯真 | ★ | common | 16 |
| `sunflower.png` | 向日葵 | 仰望与忠诚 | ★ | common | 15 |
| `periwinkle.png` | 长春花 | 永恒青春 | ★ | common | 15 |
| `lily.png` | 百合 | 纯洁祝福 | ★★ | rare | 10 |
| `hydrangea.png` | 绣球花 | 团圆美满 | ★★ | rare | 9 |
| `lavender.png` | 薰衣草 | 等待与思念 | ★★ | rare | 9 |
| `rose.png` | 玫瑰 | 真爱 | ★★★ | epic | 6 |
| `apple-blossom.png` | 苹果花 | 温柔甜美 | ★★★ | epic | 5 |
| `clover.png` | 四叶草 | 幸运 | ★★★★ | legend | 1 |

概率大致：一星 53%、二星 33%、三星 13%、四星 1.2%（总权重 86）。

## 想换成自己的图

把同名 PNG 覆盖掉即可，代码不用改（`src/core/collection.js` 里的 `image` 字段决定文件名）。
建议同样是正方形、透明背景、256px 左右；不是正方形也不会变形，`object-fit: contain` 会等比缩放。

改完记得重新打包单文件版：

```bat
node tools/build-single.mjs
```

`tools/build-single.mjs` 会把 `assets/flowers/*.png` 全部内联成 `window.__FLOWER_ASSETS`，
所以 `演示.html` 里不依赖外部图片；服务版则直接读这些文件。
