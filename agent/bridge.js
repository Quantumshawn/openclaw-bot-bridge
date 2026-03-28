'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const chokidar = require('chokidar');

// ---- Config ----
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('ERROR: config.json not found.');
  console.error('       Copy config.example.json to config.json and fill in your settings.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error('ERROR: Failed to parse config.json:', err.message);
  process.exit(1);
}

const { name, serverUrl, authToken = '', workspacePath: rawWorkspace } = config;

if (!name || !/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
  console.error('ERROR: "name" in config.json must be 1-32 alphanumeric/dash/underscore characters.');
  process.exit(1);
}
if (!serverUrl || !serverUrl.startsWith('ws')) {
  console.error('ERROR: "serverUrl" in config.json is required (e.g. ws://192.168.1.100:3000)');
  process.exit(1);
}

// Resolve workspace path - expand ~ and resolve relative paths
const workspaceBase = rawWorkspace
  ? path.resolve(rawWorkspace.replace(/^~(?=$|\/|\\)/, os.homedir()))
  : path.join(os.homedir(), '.openclaw', 'workspace');

const OUTBOX_DIR = path.join(workspaceBase, 'outbox');
const SENT_DIR   = path.join(OUTBOX_DIR, 'sent');
const INBOX_DIR  = path.join(workspaceBase, 'inbox');

[OUTBOX_DIR, SENT_DIR, INBOX_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

console.log(`OpenClaw Bridge | name="${name}"`);
console.log(`Workspace : ${workspaceBase}`);
console.log(`Outbox    : ${OUTBOX_DIR}`);
console.log(`Inbox     : ${INBOX_DIR}`);
console.log(`Server    : ${serverUrl}`);
console.log('');

// ---- WebSocket ----
let ws = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 30000;

// Files waiting to be sent (agent was offline when they were found)
const pendingQueue = []; // [{filepath, envelope}]

function sendRaw(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function flushPendingQueue() {
  while (pendingQueue.length > 0) {
    const item = pendingQueue[0];
    if (!sendRaw(item.envelope)) break; // not connected yet
    moveSent(item.filepath);
    pendingQueue.shift();
    console.log(`[SENT queued] ${path.basename(item.filepath)}`);
  }
}

function connect() {
  console.log(`Connecting to relay server...`);
  ws = new WebSocket(serverUrl);

  ws.on('open', () => {
    reconnectDelay = 2000;
    console.log('Connected to relay server.');
    sendRaw({ type: 'register', name, token: authToken });
    flushPendingQueue();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'message') {
      receiveMessage(msg);
    } else if (msg.type === 'peer_online') {
      console.log(`[PEER+] "${msg.name}" is now online`);
    } else if (msg.type === 'peer_offline') {
      console.log(`[PEER-] "${msg.name}" went offline`);
    }
    // pong is silently ignored
  });

  ws.on('close', (code, reason) => {
    console.log(`Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
    ws = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    // close event will trigger reconnect
  });
}

// ---- Receive: write incoming message to inbox/<from>/ ----
function sanitizeName(raw) {
  return String(raw || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'unknown';
}

function receiveMessage(msg) {
  const fromSafe = sanitizeName(msg.from);
  const fromDir  = path.join(INBOX_DIR, fromSafe);
  fs.mkdirSync(fromDir, { recursive: true });

  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${ts}_from_${fromSafe}.json`;
  const destPath = path.join(fromDir, filename);

  try {
    // 'wx' flag: fail if file already exists (prevents accidental overwrite)
    fs.writeFileSync(destPath, JSON.stringify(msg, null, 2), { flag: 'wx' });
    console.log(`[RECV] ${msg.from} -> ${msg.to}  →  inbox/${fromSafe}/${filename}`);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.error('Failed to write inbox message:', err.message);
    }
  }
}

// ---- Outbox watcher: send files placed in outbox/ ----
function moveSent(filepath) {
  const base = path.basename(filepath);
  let dest = path.join(SENT_DIR, base);
  // Avoid collision if a file with the same name was already sent
  if (fs.existsSync(dest)) {
    dest = path.join(SENT_DIR, `${Date.now()}_${base}`);
  }
  try {
    fs.renameSync(filepath, dest);
  } catch {
    // cross-device rename fallback
    try {
      fs.copyFileSync(filepath, dest);
      fs.unlinkSync(filepath);
    } catch (e) {
      console.error('Could not move file to sent/:', e.message);
    }
  }
}

const processedSet = new Set();

function processOutboxFile(filepath) {
  // Ignore files inside the sent/ subdirectory
  if (filepath.startsWith(SENT_DIR) || path.dirname(filepath) === SENT_DIR) return;
  if (processedSet.has(filepath)) return;
  processedSet.add(filepath);

  let data;
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read/parse ${path.basename(filepath)}:`, err.message);
    processedSet.delete(filepath);
    return;
  }

  // Expected outbox file format:
  //   { "to": "all" | "<botname>", "content": <string or object> }
  // If "to" is missing it defaults to "all".
  const toTarget = typeof data.to === 'string' ? data.to : 'all';
  const content  = data.content !== undefined ? data.content : data;

  const envelope = {
    type: 'message',
    to: toTarget,
    content,
    filename: path.basename(filepath)
  };

  if (sendRaw(envelope)) {
    moveSent(filepath);
    console.log(`[SENT] ${path.basename(filepath)} -> ${toTarget}`);
  } else {
    // Agent is offline — queue it and flush when reconnected
    pendingQueue.push({ filepath, envelope });
    console.log(`[QUEUED] ${path.basename(filepath)} (not connected, will send on reconnect)`);
  }
}

function startWatcher() {
  // Normalize to forward slashes for chokidar glob (required on Windows)
  const watchGlob = OUTBOX_DIR.split(path.sep).join('/') + '/*.json';

  const watcher = chokidar.watch(watchGlob, {
    persistent: true,
    ignoreInitial: false,      // pick up files that existed before the agent started
    awaitWriteFinish: {
      stabilityThreshold: 500, // wait 500ms after last write before processing
      pollInterval: 100
    }
  });

  watcher.on('add', (filepath) => {
    processOutboxFile(path.normalize(filepath));
  });

  watcher.on('error', (err) => {
    console.error('Watcher error:', err.message);
  });

  console.log('Watching outbox for new messages... (drop a .json file in outbox/ to send)');
}

// ---- Heartbeat ----
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);

// ---- Start ----
connect();
startWatcher();
