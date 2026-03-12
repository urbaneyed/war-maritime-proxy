#!/bin/bash
# Deploy maritime-proxy to iMac (192.168.68.58)
# Run from laptop: bash deploy-imac.sh

IMAC="rishikhiani@192.168.68.58"
REMOTE_DIR="/Users/rishikhiani/maritime-proxy"
REMOTE_LOGS="/Users/rishikhiani/logs"

echo "═══ WAR.DIRECT Maritime Proxy — Deploy to iMac ═══"

# 1. Create dirs on iMac
echo "[1/5] Creating directories..."
ssh $IMAC "mkdir -p $REMOTE_DIR $REMOTE_LOGS"

# 2. Copy files (not node_modules — install fresh on iMac)
echo "[2/5] Copying files..."
scp server.js package.json package-lock.json .env ecosystem.config.js $IMAC:$REMOTE_DIR/

# 3. Install dependencies on iMac
echo "[3/5] Installing dependencies..."
ssh $IMAC "cd $REMOTE_DIR && npm ci --production"

# 4. Start/restart with PM2
echo "[4/5] Starting with PM2..."
ssh $IMAC "cd $REMOTE_DIR && pm2 delete war-maritime 2>/dev/null; pm2 start ecosystem.config.js && pm2 save"

# 5. Verify
echo "[5/5] Verifying..."
sleep 3
ssh $IMAC "pm2 status war-maritime"
echo ""
echo "Test: curl http://192.168.68.58:3001/stats?secret=war-maritime-2026"
echo "═══ Done ═══"
