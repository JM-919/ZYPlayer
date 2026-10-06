#!/data/data/com.termux/files/usr/bin/bash
# 把真实收款码放进工程(一条命令, 不用手改任何文件)
#
#   bash pikachu-dl/tools/put_sponsor_qr.sh <打赏码图片1> <打赏码图片2> [--build]
#
# ① 按原后缀复制成 sponsor1.<后缀> / sponsor2.<后缀>, 同时放进
#    安卓端 pikachu-dl/android/assets/ 与网页版 web/site/;
# ② 加 --build 时顺手重建网页版(web/dist) 与安卓 APK。
# 页面里的 <img> 会按 png→jpg→jpeg→webp→svg 依次尝试, 后缀是什么都行。
set -e
cd "$(dirname "$0")/../.."
A="pikachu-dl/android/assets"; W="web/site"
if [ $# -lt 2 ]; then sed -n '2,12p' "$0"; exit 2; fi
IMG1="$1"; IMG2="$2"; BUILD=""; [ "$3" = "--build" ] && BUILD=1
for f in "$IMG1" "$IMG2"; do [ -f "$f" ] || { echo "找不到文件: $f"; exit 1; }; done
put() {
  local src="$1" base="$2" ext
  ext="$(printf '%s' "${src##*.}" | tr 'A-Z' 'a-z')"
  case "$ext" in png|jpg|jpeg|webp) ;; *) echo "后缀 $ext 不认(只收 png/jpg/jpeg/webp)"; exit 1;; esac
  mkdir -p "$A" "$W"
  rm -f "$A/$base".png "$A/$base".jpg "$A/$base".jpeg "$A/$base".webp
  rm -f "$W/$base".png "$W/$base".jpg "$W/$base".jpeg "$W/$base".webp
  cp "$src" "$A/$base.$ext"; cp "$src" "$W/$base.$ext"
  echo "已放入: $A/$base.$ext  ($(wc -c < "$src") 字节)"
}
put "$ALIPAY" sponsor1
put "$WECHAT" sponsor2
if [ -n "$BUILD" ]; then
  echo "--- 重建网页版 ---"; node web/build-web.mjs
  echo "--- 重建安卓 APK ---"; bash abuild/build.sh
else
  echo "下一步: node web/build-web.mjs && bash abuild/build.sh   (或加 --build 让本脚本一起做)"
fi
