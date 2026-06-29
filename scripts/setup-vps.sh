#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Dialog — Oracle VPS initial setup
# Run ONCE after creating the instance:
#   ssh ubuntu@<VPS_IP> -t 'bash -s' < scripts/setup-vps.sh
# ============================================================

echo "[1/6] Updating system..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

echo "[2/6] Installing Docker..."
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

echo "[3/6] Installing Docker Compose plugin..."
sudo apt-get install -y -qq docker-compose-plugin

echo "[4/6] Creating app directory..."
mkdir -p /home/ubuntu/dialog

echo "[5/6] Setting up UFW firewall..."
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 3000/tcp comment "Dialog app"
sudo ufw --force enable

echo "[6/6] Installing fail2ban for SSH protection..."
sudo apt-get install -y -qq fail2ban
sudo systemctl enable --now fail2ban

echo ""
echo "====== SETUP COMPLETE ======"
echo ""
echo "Next steps (run on your local machine, NOT on the VPS):"
echo ""
echo "  1. Add your SSH key for deploy:"
echo "     ssh-copy-id ubuntu@<VPS_IP>"
echo ""
echo "  2. Generate an SSH deploy key (no passphrase):"
echo "     ssh-keygen -t ed25519 -f ~/.ssh/dialog-deploy-key -N ''"
echo "     cat ~/.ssh/dialog-deploy-key.pub | ssh ubuntu@<VPS_IP> 'cat >> ~/.ssh/authorized_keys'"
echo ""
echo "  3. Add the PRIVATE key to GitHub repo secrets as DEPLOY_SSH_KEY"
echo "     cat ~/.ssh/dialog-deploy-key"
echo ""
echo "  4. Then I'll walk you through the rest!"
echo ""
