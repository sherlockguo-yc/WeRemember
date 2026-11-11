#!/bin/bash
# WeRemember N150 重启脚本（随 CI 产物分发，部署后位于 ~/weremember/restart.sh）
#
# 由 deploy-agent 在解压产物后调用，也会被 cron 健康检查（端口无响应时）调用。
# 退出码有意义：起不来返回 1，让 deploy-agent 判为失败，而不是把"未启动"当成功。
set -uo pipefail

PORT=5176
DIR="$HOME/weremember"
DEPS_DIR="$HOME/weremember-deps"
LOCK_FILE=/tmp/weremember-restart.lock
LOG=/tmp/weremember.log

log() { echo "[weremember] $*"; }

# 同一时刻只允许一个 restart.sh 执行：webhook 部署与 cron 健康检查会并发触发，
# 而首次安装依赖（含 better-sqlite3 原生模块）可能持续数分钟，并发会互相踩坏 node_modules。
# 锁必须在拉起常驻服务时显式关闭（9>&-），否则 node 继承 fd 9 会永久持有锁，
# 之后每次部署都卡死在 flock 上。
exec 9>"$LOCK_FILE"
flock 9

if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node || echo node)"; fi
if [ -x /usr/local/bin/npm ]; then NPM=/usr/local/bin/npm; else NPM="$(command -v npm || echo npm)"; fi

cd "$DIR" || { log "✗ 目录不存在：$DIR"; exit 1; }
mkdir -p "$DIR/data" "$DEPS_DIR"
chmod 700 "$DIR/data" 2>/dev/null || true
[ -f "$DIR/.env" ] && chmod 600 "$DIR/.env"

# ── 依赖 ─────────────────────────────────────────────────────────────
# 装在部署目录之外：deploy-agent 用 rsync -a --delete 同步 $DIR，包里没有的都会被清掉。
# 只有 package-lock.json 变化时才重装。装在停旧进程之前：安装期间旧版本继续服务。
ensure_deps() {
  local want
  want=$(sha1sum "$DIR/package-lock.json" 2>/dev/null | cut -d' ' -f1)
  [ -n "$want" ] || { log "✗ 缺少 package-lock.json"; return 1; }

  if [ "$(cat "$DEPS_DIR/.lock-hash" 2>/dev/null)" = "$want" ] && [ -d "$DEPS_DIR/node_modules" ]; then
    log "依赖未变更，跳过安装"
  else
    cp "$DIR/package.json" "$DIR/package-lock.json" "$DEPS_DIR/"
    log "安装依赖到 $DEPS_DIR（含 better-sqlite3 原生模块，首次可能需要几分钟）…"
    if ! (cd "$DEPS_DIR" && "$NPM" ci --omit=dev --prefer-offline --no-audit --no-fund \
        --registry=https://registry.npmmirror.com); then
      log "✗ 依赖安装失败"
      return 1
    fi
    # 安装后必须真的能加载原生模块，否则 npm 报成功也不算数
    if ! (cd "$DEPS_DIR" && "$NODE" -e "new (require('better-sqlite3'))(':memory:').close()"); then
      log "✗ better-sqlite3 无法加载"
      return 1
    fi
    printf '%s' "$want" > "$DEPS_DIR/.lock-hash"
  fi

  if [ -e "$DIR/node_modules" ] && [ ! -L "$DIR/node_modules" ]; then rm -rf "$DIR/node_modules"; fi
  ln -sfn "$DEPS_DIR/node_modules" "$DIR/node_modules"
  return 0
}

if ! ensure_deps; then
  log "✗ 依赖准备失败，保持旧版本继续运行（不重启）"
  exit 1
fi

# ── OCR 资源 ─────────────────────────────────────────────────────────
# public/vendor 不在产物里，且 deploy-agent 的 rsync --delete 每次都会清掉它，所以每次部署都要重新同步
# （从已安装的依赖拷 16MB 本地文件，毫秒级，不走网络）。
# 失败只降级：OCR 不可用，但提醒、录入等主功能不受影响，所以不阻止重启。
if ! "$NODE" "$DIR/scripts/sync-ocr.mjs" "$DIR/public/vendor/tesseract" "$DEPS_DIR"; then
  log "⚠ OCR 资源同步失败，拍照识别暂不可用（其余功能不受影响）"
fi

# ── 配置 ─────────────────────────────────────────────────────────────
# .env 受 rsync --exclude 保护，跨版本持久。set -a 让 "KEY=value" 与 "export KEY=value" 两种写法都生效。
if [ -f "$DIR/.env" ]; then set -a; . "$DIR/.env"; set +a; fi
# .env 里若出现 PORT 会覆盖上面的端口约定，下面的 lsof/kill 会用错端口，所以显式恢复
PORT=5176

# ── 停旧进程 ─────────────────────────────────────────────────────────
OLD_PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 $OLD_PID 2>/dev/null || break; sleep 1; done
  kill -0 $OLD_PID 2>/dev/null && kill -9 $OLD_PID 2>/dev/null
  log "已停止旧进程 PID $OLD_PID"
fi

# ── 启动 ─────────────────────────────────────────────────────────────
nohup env PORT="$PORT" NODE_ENV=production "$NODE" server/index.js >> "$LOG" 2>&1 9>&- &

for _ in $(seq 1 15); do
  NEW_PID=$(lsof -ti:$PORT 2>/dev/null || true)
  [ -n "$NEW_PID" ] && break
  sleep 1
done

if [ -n "${NEW_PID:-}" ]; then
  log "✓ 启动成功 PID $NEW_PID 端口 $PORT（版本 $(cat "$DIR/.version" 2>/dev/null || echo unknown)）"
  exit 0
fi
log "✗ 启动失败，最近日志："
tail -20 "$LOG" 2>/dev/null
exit 1
