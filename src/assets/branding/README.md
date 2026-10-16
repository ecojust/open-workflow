# Open Workflow 图标

`open-workflow-logo.png` 根据用户提供的橙色生肖龙应用图标，经图像工具整理为透明背景图稿。保留橙色圆角底板、黑色与米白色雕刻纹理，不包含名称文字。

应用界面、网页和桌面安装包使用同一图稿生成的资源：

```sh
./node_modules/.bin/tauri icon src/assets/branding/open-workflow-logo.png --output /tmp/open-workflow-icons
```

将生成的 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.ico` 和 `icon.icns` 复制到 `src-tauri/icons/`。`public/brand-mark.png` 使用生成的 `128x128@2x.png`，`public/favicon.png` 使用生成的 `32x32.png`。

图稿自身带有透明边距与圆角，界面无需再次裁切。以上命令只转换图标资源，不构建应用。
