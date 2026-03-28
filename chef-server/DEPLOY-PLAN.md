# Chef Voice Server — Deploy Plan

## What this is

CookedBook Chef is a voice assistant backend for the cookedbook.net recipe site.
Browser captures mic audio on recipe pages, sends it over WebSocket to this server.
Server does STT → LLM → TTS and sends audio back.

**No GPU needed.** STT (faster-whisper base.en int8) and TTS (Piper) run on CPU.
LLM inference is proxied to the existing Ollama instance at 192.168.50.115:11434.

## Container spec

- **CT ID:** 114 (check `sudo pct list` first — if taken, use next available)
- **Hostname:** chef
- **Template:** debian-13-standard_13.1-2_amd64.tar.zst
- **RAM:** 2048 MB
- **Cores:** 2
- **Disk:** 8 GB
- **Unprivileged:** yes
- **Onboot:** yes

## Application

- **Code:** `/opt/chef/server.py` (source is at `~/Code/cookedbook/chef-server/server.py`)
- **Requirements:** `/opt/chef/requirements.txt` (source is at `~/Code/cookedbook/chef-server/requirements.txt`)
- **Models dir:** `/opt/chef/models/` (Piper voice auto-downloads on first run, Whisper auto-downloads via HuggingFace cache)
- **Port:** 8099
- **Python:** 3.x in a venv at `/opt/chef/venv/`

### System packages needed

```
python3 python3-venv python3-dev build-essential wget
```

### Python setup

```bash
python3 -m venv /opt/chef/venv
source /opt/chef/venv/bin/activate
pip install --upgrade pip
pip install -r /opt/chef/requirements.txt
```

### Systemd service: `/etc/systemd/system/chef.service`

```ini
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
```

## DNS

Add to Pi-hole (CT 102) custom DNS (`/etc/dnsmasq.d/10-custom.conf`):

```
address=/chef.robertkarl.net/192.168.50.92
```

Then `systemctl restart pihole-FTL` inside CT 102.

## Nginx reverse proxy (CT 103)

Create `/etc/nginx/sites-available/chef`:

```nginx
server {
    listen 80;
    server_name chef.robertkarl.net;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name chef.robertkarl.net;

    ssl_certificate /etc/letsencrypt/live/robertkarl.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/robertkarl.net/privkey.pem;

    location / {
        proxy_pass http://<CHEF_CONTAINER_IP>:8099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support — critical for the voice pipeline
    location /ws/ {
        proxy_pass http://<CHEF_CONTAINER_IP>:8099;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Replace `<CHEF_CONTAINER_IP>` with the actual DHCP IP of CT 114.
Symlink to sites-enabled, `nginx -t && systemctl reload nginx`.

## Verification

1. `curl https://chef.robertkarl.net/health` should return `{"status":"ok","model":"qwen2.5:7b","whisper":"base.en"}`
2. First startup takes 1-2 min to download Whisper + Piper models. Check logs: `journalctl -u chef -f`
3. The WebSocket endpoint is `wss://chef.robertkarl.net/ws/voice`

## Files to copy to the container

From this machine, the source files are:
- `/Users/robertkarl/Code/cookedbook/chef-server/server.py` → `/opt/chef/server.py`
- `/Users/robertkarl/Code/cookedbook/chef-server/requirements.txt` → `/opt/chef/requirements.txt`
