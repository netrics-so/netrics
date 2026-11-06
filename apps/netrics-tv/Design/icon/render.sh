#!/bin/sh
# Renders the app icons from the SVGs in this folder: the tvOS icon and Top
# Shelf images into NetricsTV/Assets.xcassets, and the layers of the iOS icon
# (Icon Composer's layered format) into NetricsTVTouch/AppIcon.icon/Assets.
# Needs Google Chrome (headless, for the SVGs
# and the system font of the wordmark) and ImageMagick (`magick`, to drop the
# alpha channel of opaque images and tag them sRGB). Run from anywhere:
#
#   apps/netrics-tv/Design/icon/render.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
assets="$(cd "$here/../../NetricsTV/Assets.xcassets" && pwd)/App Icon & Top Shelf Image.brandassets"
touch_icon="$(cd "$here/../../NetricsTVTouch/AppIcon.icon" && pwd)"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# shoot <svg> <width> <height> <output.png>: one headless Chrome screenshot
# of an SVG in this folder (or at an absolute path).
# Chrome has a minimum window width, so small sizes are not rendered
# directly: each SVG is shot once at its largest size and scaled down.
shoot() {
  rm -f "$4"
  case $1 in /*) src=$1 ;; *) src=$here/$1 ;; esac
  # Headless Chrome sometimes lingers after writing the screenshot, so wait
  # for the file and then stop that one process.
  "$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --user-data-dir="$tmp/profile" \
    --no-first-run --disable-component-update \
    --window-size="$2,$3" --screenshot="$4" "file://$src" >/dev/null 2>&1 &
  pid=$!
  tries=0
  while kill -0 "$pid" 2>/dev/null && [ ! -s "$4" ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 600 ] || { kill "$pid"; echo "$1: Chrome timed out" >&2; exit 1; }
    sleep 0.2
  done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -s "$4" ] || { echo "$1: no screenshot" >&2; exit 1; }
  size=$(magick identify -format '%wx%h' "$4")
  [ "$size" = "$2x$3" ] || { echo "$1: Chrome rendered $size, want $2x$3" >&2; exit 1; }
}

# emit <source.png> <width> <height> <output.png> <opaque|alpha>
emit() {
  if [ "$5" = opaque ]; then
    flags="-alpha off -define png:color-type=2"
  else
    flags="-define png:color-type=6"
  fi
  # shellcheck disable=SC2086
  magick "$1" -filter Lanczos -resize "$2x$3!" -colorspace sRGB -strip $flags "$4"
  size=$(magick identify -format '%wx%h' "$4")
  [ "$size" = "$2x$3" ] || { echo "$4: got $size, want $2x$3" >&2; exit 1; }
  out=${4#"$assets"/}
  echo "${out#"$touch_icon"/}: $size, $5"
}

shoot icon-back.svg 1280 768 "$tmp/back.png"
shoot icon-front.svg 1280 768 "$tmp/front.png"
shoot top-shelf.svg 3840 1440 "$tmp/shelf.png"
shoot top-shelf-wide.svg 4640 1440 "$tmp/shelf-wide.png"

icon="$assets/App Icon.imagestack"
store="$assets/App Icon - App Store.imagestack"

emit "$tmp/back.png" 400 240 "$icon/Back.imagestacklayer/Content.imageset/back@1x.png" opaque
emit "$tmp/back.png" 800 480 "$icon/Back.imagestacklayer/Content.imageset/back@2x.png" opaque
emit "$tmp/front.png" 400 240 "$icon/Front.imagestacklayer/Content.imageset/front@1x.png" alpha
emit "$tmp/front.png" 800 480 "$icon/Front.imagestacklayer/Content.imageset/front@2x.png" alpha
emit "$tmp/back.png" 1280 768 "$store/Back.imagestacklayer/Content.imageset/back@1x.png" opaque
emit "$tmp/front.png" 1280 768 "$store/Front.imagestacklayer/Content.imageset/front@1x.png" alpha
emit "$tmp/shelf.png" 1920 720 "$assets/Top Shelf Image.imageset/shelf@1x.png" opaque
emit "$tmp/shelf.png" 3840 1440 "$assets/Top Shelf Image.imageset/shelf@2x.png" opaque
emit "$tmp/shelf-wide.png" 2320 720 "$assets/Top Shelf Image Wide.imageset/shelf@1x.png" opaque
emit "$tmp/shelf-wide.png" 4640 1440 "$assets/Top Shelf Image Wide.imageset/shelf@2x.png" opaque

# The iOS icon (ADR 0021): AppIcon.icon takes square layers, and the system
# draws the shape, the glass and the dark, tinted and clear looks. Its
# icon.json fills the background with icon-back.svg's gradient; the layers
# are the same SVGs cut square: the back layer's glow and grid without its
# opaque background, and the front layer's sparkline with room around it.
square() {
  sed -e "s/viewBox=\"0 0 1280 768\"/viewBox=\"$2\"/" -e 's/preserveAspectRatio="none"/preserveAspectRatio="xMidYMid meet"/' \
    -e '/fill="url(#bg)"/d' "$here/$1" >"$3"
}
square icon-back.svg "256 0 768 768" "$tmp/touch-grid.svg"
square icon-front.svg "72 -150 1100 1100" "$tmp/touch-front.svg"
shoot "$tmp/touch-grid.svg" 1024 1024 "$tmp/touch-grid.png"
shoot "$tmp/touch-front.svg" 1024 1024 "$tmp/touch-front.png"
emit "$tmp/touch-grid.png" 1024 1024 "$touch_icon/Assets/grid.png" alpha
emit "$tmp/touch-front.png" 1024 1024 "$touch_icon/Assets/sparkline.png" alpha
