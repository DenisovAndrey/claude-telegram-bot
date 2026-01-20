# Claude Telegram Bot

A Telegram bot that allows you to execute tasks via Claude Code CLI on a Raspberry Pi (or any Linux/macOS system) with strong security gates.

## Features

- **Single-user access**: Bot responds only to one authorized Telegram user
- **Password protection**: Requires unlock with password before executing tasks
- **10-minute execution quanta**: Tasks automatically pause after 10 minutes and ask for approval to continue
- **Live status panel**: Real-time updates via Telegram message editing
- **Inline buttons**: Control panel with Status, Pause, Stop, Lock buttons
- **State persistence**: Survives restarts, resumes interrupted tasks
- **Full Claude Code access**: Execute any task with terminal and filesystem access

## Requirements

- Node.js 18+
- Claude Code CLI installed and configured (`claude` command available in PATH)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Your Telegram User ID (from [@userinfobot](https://t.me/userinfobot))

## Hardware Requirements (Raspberry Pi)

| Model | RAM | Status |
|-------|-----|--------|
| Pi 3B/3B+ | 1GB | ✅ Works (limited browser automation) |
| Pi 4 (2GB) | 2GB | ✅ Recommended |
| Pi 4 (4GB+) | 4GB+ | ✅ Best performance |
| Pi 5 | 4GB+ | ✅ Best performance |

### Resource Usage

| Component | RAM Usage | Notes |
|-----------|-----------|-------|
| Node.js bot | ~50-100MB | Lightweight |
| Claude Code CLI | ~100-150MB | API client only |
| Playwright/Chromium | ~300-500MB | Optional, memory hungry |

**Note for Pi 3 users:** The bot and Claude CLI work fine. Browser automation (Playwright) will be slow due to 1GB RAM limit. Consider increasing swap to 1GB:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/DenisovAndrey/claude-telegram-bot.git
cd claude-telegram-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
TG_BOT_TOKEN=your_bot_token_here
ALLOWED_USER_ID=your_telegram_user_id
```

### 4. Set unlock password

```bash
echo "your-secure-password" > .secret
chmod 600 .secret
```

### 5. Build and run

```bash
npm run build
npm start
```

## Raspberry Pi Deployment

### Quick setup

```bash
# Clone to Pi
cd /home/pi
git clone https://github.com/DenisovAndrey/claude-telegram-bot.git claude-bot
cd claude-bot

# Install dependencies
npm install

# Configure
cp .env.example .env
nano .env  # Edit with your values

# Set password
echo "your-password" > .secret
chmod 600 .secret

# Build
npm run build

# Test run
npm start
```

### Systemd service (auto-start on boot)

```bash
# Copy service file
sudo cp claude-bot.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable claude-bot
sudo systemctl start claude-bot

# Check status
sudo systemctl status claude-bot

# View logs
sudo journalctl -u claude-bot -f
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Show status and control panel |
| `/unlock <password>` | Unlock bot for 10 minutes |
| `/lock` | Lock bot immediately |
| `/run <task>` | Start a new task |
| `/status` | Show current task status |
| `/continue` | Continue paused task |
| `/pause` | Pause running task |
| `/stop` | Stop current task gracefully |
| `/cancel` | Cancel task immediately |
| `/device_status` | Show device stats (CPU, RAM, temp) |

### Example workflow

1. Open your bot in Telegram
2. Send `/unlock your-password`
3. Send `/run create a Python script that prints hello world`
4. Watch the live status panel update
5. If task exceeds 10 minutes, approve continuation or stop

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TG_BOT_TOKEN` | Yes | - | Telegram bot token |
| `ALLOWED_USER_ID` | Yes | - | Your Telegram user ID |
| `WORKDIR` | No | Current dir | Working directory for Claude |
| `SECRET_FILE` | No | `./.secret` | Path to password file |
| `UNLOCK_TTL_MIN` | No | 10 | Unlock duration in minutes |
| `QUANTUM_MIN` | No | 10 | Execution quantum in minutes |
| `STATE_FILE` | No | `./state/state.json` | State persistence file |
| `LOG_DIR` | No | `./logs` | Task log directory |
| `HEARTBEAT_SEC` | No | 25 | Status update interval |
| `TAIL_LINES` | No | 20 | Output lines in status |

## Security

- **Single user only**: All messages from other users are silently ignored
- **Private chats only**: Bot only works in private chats
- **Password gate**: Must unlock before any task execution
- **Rate limiting**: 3 second minimum between execution requests
- **No secrets echoed**: Password messages are deleted after processing
- **Menu restricted**: Command menu only visible to authorized user

## License

MIT
