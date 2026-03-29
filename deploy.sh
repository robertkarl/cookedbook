#!/usr/bin/env bash
#
# deploy.sh — Build and deploy CookedBook.
#
# What it does:
#   1. Build Hugo site
#   2. Push to GitHub Pages (via git push to main, which triggers GH Actions)
#   3. Deploy chef-server to homelab (copy files, restart service)
#
# Usage:
#   ./deploy.sh           # full deploy (pages + chef-server)
#   ./deploy.sh pages     # Hugo build + GitHub Pages only
#   ./deploy.sh chef      # chef-server deploy only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXMOX_HOST="rk@192.168.50.57"
CT_ID=114

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

deploy_pages() {
    info "Building Hugo site..."
    cd "$SCRIPT_DIR"

    if ! command -v hugo &>/dev/null; then
        error "hugo not found. Install it: brew install hugo"
        exit 1
    fi

    hugo --minify
    info "Hugo build complete (public/)"

    # Push to main triggers GitHub Actions deploy
    info "Pushing to GitHub (triggers Pages deploy via Actions)..."
    git push origin main
    info "GitHub Pages deploy triggered."
}

deploy_chef() {
    info "Deploying chef-server to CT $CT_ID..."

    # Copy server files to Proxmox, then push into container
    scp -q "$SCRIPT_DIR/chef-server/server.py" "$PROXMOX_HOST:/tmp/chef-server.py"
    scp -q "$SCRIPT_DIR/chef-server/auth.py" "$PROXMOX_HOST:/tmp/chef-auth.py"
    scp -q "$SCRIPT_DIR/chef-server/requirements.txt" "$PROXMOX_HOST:/tmp/chef-requirements.txt"
    scp -q "$SCRIPT_DIR/chef-server/users.toml" "$PROXMOX_HOST:/tmp/chef-users.toml"

    ssh "$PROXMOX_HOST" bash <<DEPLOYEOF
set -euo pipefail
CT_ID=$CT_ID

sudo pct push \$CT_ID /tmp/chef-server.py /opt/chef/server.py
sudo pct push \$CT_ID /tmp/chef-auth.py /opt/chef/auth.py
sudo pct push \$CT_ID /tmp/chef-requirements.txt /opt/chef/requirements.txt
sudo pct push \$CT_ID /tmp/chef-users.toml /opt/chef/users.toml

# Install any new deps
sudo pct exec \$CT_ID -- bash -c '
  cd /opt/chef
  source venv/bin/activate
  pip install --quiet -r requirements.txt
'

# Restart service
sudo pct exec \$CT_ID -- systemctl restart chef

echo "Service restarted"
DEPLOYEOF

    info "Chef server deployed. Checking health..."
    sleep 3
    if curl -sf "https://chef.robertkarl.net/health" | python3 -m json.tool; then
        info "Health check passed."
    else
        warn "Health check failed — server may still be starting up (model loading takes ~1 min)."
    fi
}

deploy_static_to_chef() {
    info "Deploying Hugo static build to chef-server..."
    cd "$SCRIPT_DIR"
    hugo --minify

    # Tar up public/ and push to container
    tar -czf /tmp/chef-public.tar.gz -C public .
    scp -q /tmp/chef-public.tar.gz "$PROXMOX_HOST:/tmp/chef-public.tar.gz"

    ssh "$PROXMOX_HOST" bash <<EOF
set -euo pipefail
CT_ID=$CT_ID
sudo pct exec \$CT_ID -- mkdir -p /opt/chef/public
sudo pct push \$CT_ID /tmp/chef-public.tar.gz /tmp/chef-public.tar.gz
sudo pct exec \$CT_ID -- bash -c 'cd /opt/chef/public && tar -xzf /tmp/chef-public.tar.gz && rm /tmp/chef-public.tar.gz'
EOF

    rm -f /tmp/chef-public.tar.gz
    info "Static site deployed to chef-server."
}

case "${1:-all}" in
    pages)
        deploy_pages
        ;;
    chef)
        deploy_chef
        deploy_static_to_chef
        ;;
    all)
        deploy_pages
        deploy_chef
        deploy_static_to_chef
        ;;
    *)
        echo "Usage: $0 [pages|chef|all]"
        exit 1
        ;;
esac

info "Done."
