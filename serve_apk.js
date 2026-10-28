const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const APK_NAME = 'SanketVaani-v1.0.1-release.apk';
const APK_PATH = path.join(__dirname, APK_NAME);

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    let apkStats = { size: 0, mtime: new Date() };
    try {
      apkStats = fs.statSync(APK_PATH);
    } catch (e) {
      // ignore
    }
    const sizeMb = (apkStats.size / (1024 * 1024)).toFixed(1);
    const mtimeStr = apkStats.mtime.toLocaleString();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Download Sanket Vaanni (संकेत वाणी) APK</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131b2e;
      --border: #1e293b;
      --accent: #3b82f6;
      --accent-glow: #60a5fa;
      --success: #10b981;
      --text: #f8fafc;
      --subtext: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body {
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 460px;
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 32px 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      text-align: center;
    }
    .badge {
      display: inline-block;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent-glow);
      font-size: 12px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 999px;
      margin-bottom: 16px;
      letter-spacing: 0.5px;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      margin-bottom: 6px;
      color: #fff;
    }
    .subtitle {
      font-size: 15px;
      color: var(--subtext);
      margin-bottom: 24px;
    }
    .info-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      text-align: left;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: var(--subtext); }
    .info-val { font-weight: 600; color: #fff; }
    .btn {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
      font-size: 17px;
      font-weight: 700;
      text-decoration: none;
      padding: 16px 20px;
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(37, 99, 235, 0.4);
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .btn:hover, .btn:active {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(37, 99, 235, 0.6);
      background: linear-gradient(135deg, #3b82f6, #2563eb);
    }
    .features {
      margin-top: 24px;
      text-align: left;
    }
    .features h3 {
      font-size: 14px;
      font-weight: 700;
      color: var(--subtext);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 12px;
    }
    .features ul {
      list-style: none;
      font-size: 13px;
      color: #cbd5e1;
    }
    .features li {
      margin-bottom: 10px;
      padding-left: 22px;
      position: relative;
      line-height: 1.4;
    }
    .features li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: var(--success);
      font-weight: 800;
    }
    .footer {
      margin-top: 24px;
      font-size: 12px;
      color: var(--subtext);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">PRODUCTION RELEASE v1.0.1</div>
    <h1>संकेत वाणी (Sanket Vaanni)</h1>
    <p class="subtitle">AI Sign Language Translation Glove Ecosystem</p>

    <div class="info-card">
      <div class="info-row">
        <span class="info-label">File Name</span>
        <span class="info-val">${APK_NAME}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Package Size</span>
        <span class="info-val">${sizeMb} MB</span>
      </div>
      <div class="info-row">
        <span class="info-label">Built Time</span>
        <span class="info-val">${mtimeStr}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Sign Languages</span>
        <span class="info-val">ISL, ASL, BSL</span>
      </div>
      <div class="info-row">
        <span class="info-label">Security</span>
        <span class="info-val" style="color: #10b981;">Admin Gated ML Studio</span>
      </div>
    </div>

    <a href="/${APK_NAME}" class="btn" download>📥 Download Release APK</a>

    <div class="features">
      <h3>What's New in this Build</h3>
      <ul>
        <li><strong>Multi-Device Shared Vocabulary:</strong> Admin words and signs instantly synchronize across all devices from cloud registry.</li>
        <li><strong>Training Data Persistence:</strong> Consented training frames are preserved globally so new words never overwrite previous signs.</li>
        <li><strong>Fixed Reconnect Crash:</strong> High-frequency BLE live inference no longer crashes when returning to Dashboard.</li>
        <li><strong>Global Model Publishing:</strong> Authoritative model publication with immutability and instant client sync.</li>
      </ul>
    </div>

    <p class="footer">Sanket Vaanni • Made with ❤️ for Accessibility</p>
  </div>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (url === `/${APK_NAME}` || url === '/app-release.apk') {
    fs.stat(APK_PATH, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('APK file not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${APK_NAME}"`,
        'Cache-Control': 'no-cache',
      });

      const stream = fs.createReadStream(APK_PATH);
      stream.pipe(res);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SanketVaani Server] Running on http://0.0.0.0:${PORT}`);
  console.log(`[SanketVaani Server] Local download: http://localhost:${PORT}/${APK_NAME}`);
});
