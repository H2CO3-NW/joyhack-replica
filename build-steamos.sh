#!/bin/bash
set -e

echo "=================================================="
echo "      JoyHack Player - SteamOS 打包脚本"
echo "=================================================="

# 切换到脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 Node.js 环境
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未检测到 Node.js 环境。"
    echo "💡 请在终端中安装 Node.js (推荐通过 nvm 或 flatpak/pacman 安装)"
    exit 1
fi

echo "✔ 检测到 Node.js 版本: $(node -v)"
echo "✔ 检测到 npm 版本: $(npm -v)"

# 如果 node_modules 不存在或缺少依赖则执行安装
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖包 (npm install)..."
    npm install
fi

echo "🚀 开始打包 Linux AppImage..."
npm run build:linux

echo ""
echo "=================================================="
echo "🎉 打包完成！"
OUTPUT_FILE=$(ls dist/*.AppImage 2>/dev/null | head -n 1)
if [ -n "$OUTPUT_FILE" ]; then
    chmod +x "$OUTPUT_FILE"
    echo "✔ 生成文件路径: $SCRIPT_DIR/$OUTPUT_FILE"
    echo "✔ 已自动赋予该 AppImage 执行权限 (+x)"
    echo ""
    echo "📌 下一步（添加至 Steam）："
    echo "1. 打开 Steam 桌面客户端"
    echo "2. 点击左下角 [添加游戏] -> [添加非 Steam 游戏...]"
    echo "3. 点击 [浏览]，选中 $SCRIPT_DIR/$OUTPUT_FILE"
    echo "4. 点击 [添加选中的程序]，随后切换回掌机模式即可正常启动玩耍！"
fi
echo "=================================================="
