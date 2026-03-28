#!/usr/bin/env bash
#
# deploy.sh — Deploy CookedBook Chef voice server to a Proxmox LXC container.
#
# Prerequisites:
#   - SSH access to Proxmox host (rk@192.168.50.57)
#   - Debian 13 template downloaded on Proxmox
#
# Usage: ./deploy.sh
#
set -euo pipefail

PROXMOX_HOST="rk@192.168.50.57"
CT_ID=114
CT_HOSTNAME="chef"
CT_RAM=2048
CT_CORES=2
CT_DISK=8
SERVICE_PORT=8099
APP_DIR="/opt/chef"
DOMAIN="chef.robertkarl.net"

echo "=== CookedBook Chef — Deploy ==="
echo ""

# ---------- Step 1: Create container ----------
echo "[1/7] Creating container CT $CT_ID ($CT_HOSTNAME)..."

ssh "$PROXMOX_HOST" bash <<'CREATEEOF'
set -euo pipefail
CT_ID=114
if sudo pct status $CT_ID 2>/dev/null | grep -q "running\|stopped"; then
  echo "  Container $CT_ID already exists, skipping creation"
else
  sudo pct create $CT_ID local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
    --hostname chef \
    --memory 2048 \
    --swap 512 \
    --cores 2 \
    --net0 name=eth0,bridge=vmbr0,ip=dhcp,firewall=1 \
    --rootfs local-lvm:8 \
    --unprivileged 1 \
    --onboot 1
  echo "  Container created"
fi

if ! sudo pct status $CT_ID | grep -q "running"; then
  sudo pct start $CT_ID
  sleep 3
  echo "  Container started"
fi
CREATEEOF

# ---------- Step 2: Setup user + SSH ----------
echo "[2/7] Setting up SSH access..."

ssh "$PROXMOX_HOST" bash <<'SSHEOF'
set -euo pipefail
CT_ID=114

# Install sudo
sudo pct exec $CT_ID -- bash -c 'apt-get update -qq && apt-get install -y -qq sudo openssh-server wget > /dev/null 2>&1'

# Create user
sudo pct exec $CT_ID -- bash -c '
  id rk >/dev/null 2>&1 || useradd -m -s /bin/bash rk
  echo "rk ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/rk
  mkdir -p /home/rk/.ssh
  chmod 700 /home/rk/.ssh
  chown rk:rk /home/rk/.ssh
'

# Copy SSH key
cat /home/rk/.ssh/authorized_keys | sudo pct exec $CT_ID -- tee /home/rk/.ssh/authorized_keys > /dev/null
sudo pct exec $CT_ID -- chown rk:rk /home/rk/.ssh/authorized_keys
sudo pct exec $CT_ID -- chmod 600 /home/rk/.ssh/authorized_keys

echo "  SSH configured"
SSHEOF

# ---------- Step 3: Get container IP ----------
echo "[3/7] Getting container IP..."

CHEF_IP=$(ssh "$PROXMOX_HOST" "sudo pct exec $CT_ID -- ip -4 addr show eth0 | grep -oP '(?<=inet )[\d.]+'")
echo "  Chef IP: $CHEF_IP"

# ---------- Step 4: Install dependencies ----------
echo "[4/7] Installing Python + system deps (this takes a minute)..."

ssh "$PROXMOX_HOST" "sudo pct exec $CT_ID -- bash -c '
  apt-get install -y -qq python3 python3-venv python3-dev build-essential wget > /dev/null 2>&1
  echo \"  System packages installed\"
'"

# ---------- Step 5: Deploy application ----------
echo "[5/7] Deploying application..."

# Push files to container via Proxmox host
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
scp -q "$SCRIPT_DIR/server.py" "$PROXMOX_HOST:/tmp/chef-server.py"
scp -q "$SCRIPT_DIR/requirements.txt" "$PROXMOX_HOST:/tmp/chef-requirements.txt"

ssh "$PROXMOX_HOST" bash <<DEPLOYEOF
set -euo pipefail
CT_ID=$CT_ID

sudo pct exec \$CT_ID -- mkdir -p /opt/chef/models

sudo pct push \$CT_ID /tmp/chef-server.py /opt/chef/server.py
sudo pct push \$CT_ID /tmp/chef-requirements.txt /opt/chef/requirements.txt
sudo pct exec \$CT_ID -- chown -R rk:rk /opt/chef

echo "  Files deployed"

# Create venv and install deps
sudo pct exec \$CT_ID -- bash -c '
  cd /opt/chef
  if [ ! -d venv ]; then
    python3 -m venv venv
  fi
  source venv/bin/activate
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  echo "  Python deps installed"
'
DEPLOYEOF

# ---------- Step 6: Create systemd service ----------
echo "[6/7] Creating systemd service..."

ssh "$PROXMOX_HOST" bash <<'SVCEOF'
set -euo pipefail
CT_ID=114

sudo pct exec $CT_ID -- tee /etc/systemd/system/chef.service > /dev/null <<'UNIT'
[Unit]
Description=CookedBook Chef Voice Assistant
After=network.target

[Service]
Type=simple
User=rk
WorkingDirectory=/opt/chef
Environment=OLLAMA_URL=http://192.168.50.115:11434
Environment=OLLAMA_MODEL=qwen2.5:7b
Environment=WHISPER_MODEL_SIZE=base.en
Environment=PIPER_MODEL_DIR=/opt/chef/models
Environment=PIPER_VOICE=en_US-lessac-medium
ExecStart=/opt/chef/venv/bin/python /opt/chef/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo pct exec $CT_ID -- systemctl daemon-reload
sudo pct exec $CT_ID -- systemctl enable chef
sudo pct exec $CT_ID -- systemctl restart chef
echo "  Service started"
SVCEOF

# ---------- Step 7: DNS + Reverse Proxy ----------
echo "[7/7] Configuring DNS and nginx reverse proxy..."

ssh "$PROXMOX_HOST" bash <<DNSEOF
set -euo pipefail

# Add DNS entry to Pi-hole
sudo pct exec 102 -- bash -c "
  if ! grep -q 'chef.robertkarl.net' /etc/dnsmasq.d/10-custom.conf 2>/dev/null; then
    echo 'address=/chef.robertkarl.net/192.168.50.92' >> /etc/dnsmasq.d/10-custom.conf
    systemctl restart pihole-FTL
    echo '  DNS entry added'
  else
    echo '  DNS entry already exists'
  fi
"

# Add nginx reverse proxy with WebSocket support
sudo pct exec 103 -- tee /etc/nginx/sites-available/chef > /dev/null <<'NGINX'
server {
    listen 80;
    server_name chef.robertkarl.net;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name chef.robertkarl.net;

    ssl_certificate /etc/letsencrypt/live/robertkarl.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/robertkarl.net/privkey.pem;

    location / {
        proxy_pass http://$CHEF_IP:$SERVICE_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /ws/ {
        proxy_pass http://$CHEF_IP:$SERVICE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX

sudo pct exec 103 -- bash -c '
  ln -sf /etc/nginx/sites-available/chef /etc/nginx/sites-enabled/chef
  nginx -t && systemctl reload nginx
'
echo "  Nginx configured"
DNSEOF

echo ""
echo "=== Deploy complete ==="
echo ""
echo "  Container: CT $CT_ID ($CT_HOSTNAME)"
echo "  IP: $CHEF_IP"
echo "  Service: https://$DOMAIN"
echo "  Health: https://$DOMAIN/health"
echo "  WebSocket: wss://$DOMAIN/ws/voice"
echo ""
echo "  Check status:  ssh $PROXMOX_HOST 'sudo pct exec $CT_ID -- systemctl status chef'"
echo "  View logs:     ssh $PROXMOX_HOST 'sudo pct exec $CT_ID -- journalctl -u chef -f'"
echo ""
echo "  NOTE: First startup takes ~1 min to download Whisper + Piper models."
