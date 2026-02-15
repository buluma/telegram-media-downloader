# 📱 Telegram Media Downloader

**A robust, self-hosted tool to monitor, download, and backup media from Telegram channels and groups.**
Features a modern Web Dashboard, Docker support, and automatic security handling.

**Version**: 2.1.0

---

## ✨ Key Features

### 🛡️ Core & Security
*   **Auto-Download**: Monitors channels in real-time and downloads new media (Photos, Videos, Files, Audio).
*   **Secure by Design**: Automatically generates and manages secure session secrets. No hardcoded passwords.
*   **Resumable Downloads**: Smartly skips existing files to prevent duplicates and save bandwidth.
*   **Resilience**: Auto-reconnects on network loss and handles Telegram's FloodWait limits gracefully.
*   **Docker Ready**: Deploy instantly on any VPS or local machine using Docker Compose.

### 💻 Web Dashboard
*   **Modern UI**: Responsive interface built with efficient ES Modules.
*   **Media Gallery**: Grid/List view with lazy loading for thousands of files.
*   **Video Resume**: Automatically remembers playback position for all videos.
*   **Group Management**: Toggle monitoring, configure filters, and set download paths per group.
*   **Auto-Forward**: Forward downloaded media to another channel or "Saved Messages" automatically.

---

## 🚀 Installation & Setup

### Option A: Docker (Recommended)
The easiest way to run the application. Requires Docker and Docker Compose.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/botnick/telegram-media-downloader.git
    cd telegram-media-downloader
    ```

2.  **Start the application:**
    ```bash
    docker-compose up -d
    ```
    *This will start the Web UI on port `3000`.*

3.  **First Run (Login):**
    To log in to Telegram, you need to attach to the container:
    ```bash
    docker-compose run telegram-downloader npm start
    ```
    *Follow the prompts to enter your API ID, API Hash, and Phone Number. Once logged in, you can exit/stop this temporary container.*

4.  **Access Dashboard:**
    Open `http://localhost:3000` in your browser.

### Option B: Manual Installation (Node.js)
Requires Node.js v18 or higher.

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Setup & Login:**
    ```bash
    npm start
    ```
    *Follow the interactive login prompts.*

3.  **Run Web Dashboard:**
    ```bash
    npm run web
    ```
    *Access at `http://localhost:3000`*

---

## 📖 CLI Command Reference

This tool provides a comprehensive CLI for managing all aspects of the downloader.

### 🟢 Usage: `npm run [command]`

| Command | Description |
| :--- | :--- |
| `start` | **Main Menu**. Interactive dashboard to access all features. |
| `monitor` | **Headless Mode**. Starts background monitoring (ideal for servers/cron). |
| `history` | **History Downloader**. Download past messages from a group (with date/limit options). |
| `dialogs` | **List Chats**. Shows all available groups/channels and their IDs. |
| `config` | **Group Config**. Interactive menu to enable/disable groups and set filters. |
| `settings` | **System Settings**. Configure download speed, disk limits, and concurrency. |
| `viewer` | **Stats Viewer**. View download statistics (file counts, sizes) by group. |
| `auth` | **Security Manager**. Enable/Disable password protection for the Web Dashboard. |
| `migrate` | **Database Migration**. Import legacy JSON logs to the new SQLite database. |

### 💡 Examples

**1. Download History from a Channel:**
```bash
npm run history
# Select group -> Select media types -> Choose "Last 1000 messages" or "Custom Date"
```

**2. Configure Download Speed Limit:**
```bash
npm run settings
# Select "Max Download Speed" -> Enter "5 MB/s"
```

**3. Secure the Web Dashboard:**
```bash
npm run auth
# Choose "Enable Security" -> Set a password
```

---

## ⚙️ Configuration

Settings are stored in `data/config.json`. You can modify them via the **Web UI (Settings page)**, the **CLI (`npm run settings`)**, or by editing the file manually.

### Key Configuration Options

| Key | Description | Default |
| :--- | :--- | :--- |
| `concurrent` | Simultaneous downloads. Higher = faster but more CPU/RAM. | `3` |
| `requestsPerMinute` | API Rate limit. Keep below 20 to avoid FloodWait. | `15` |
| `maxSpeed` | Limit bandwidth usage (bytes/sec). `0` = Unlimited. | `0` |
| `maxTotalSize` | Global disk usage limit (e.g., "50GB"). Stops downloading when reached. | `Unlimited` |
| `groups` | Array of monitored groups with their specific filters. | `[]` |

**Security Note:**
The application generates a `data/secret.key` file on first launch. This key generates the session encryption password. **Keep this file safe** if you back up your data.

---

## �️ Troubleshooting

*   **Request failed (403/401)**:
    *   **Cause**: Session expired or invalid.
    *   **Fix**: Run `npm start` again to re-login. If using Docker, use the "First Run" command.

*   **FloodWait Errors**:
    *   **Cause**: Telegram is rate-limiting you for sending too many requests.
    *   **Fix**: The app handles this automatically by pausing. **Do not restart** repeatedly; just wait. Lower your `concurrent` or `requestsPerMinute` settings if it happens often.

*   **Docker Permission Issues**:
    *   **Cause**: Docker container cannot write to `data/`.
    *   **Fix**: Ensure your local `data` folder is writable by the user running Docker (`chown -R 1000:1000 data` on Linux).

*   **Database Locked**:
    *   **Cause**: Multiple instances running.
    *   **Fix**: Ensure only **one** instance (CLI or Web) is writing to the database at a time.

---

## 📜 Disclaimer
This tool is for personal use and educational purposes. Please respect copyright laws and Telegram's Terms of Service.
