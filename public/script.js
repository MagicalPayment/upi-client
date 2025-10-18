// Client script — shows Cancel during active session
let socket;

const amountRow   = document.getElementById('amountRow');
const amountInput = document.getElementById('amountInput');

const kvBlock   = document.getElementById('kvBlock');
const amountOut = document.getElementById('amountOut');
const statusOut = document.getElementById('statusOut');
const timerEl   = document.getElementById('timer');

const statusP    = document.getElementById('status');
const primaryBtn = document.getElementById('primaryBtn'); // Pay
const cancelBtn  = document.getElementById('cancelBtn');  // NEW: Cancel (shown during session)

const serverDownEl = document.getElementById('serverDown');

let currentComment = null;
let countdownInt   = null;
let isActive       = false;

const STORAGE_KEY_COMMENT = 'payment_session_comment';

// --- Resolve endpoints (works from Live Server) ---
const q = new URLSearchParams(location.search);
const CLIENT_BASE  = (q.get('client')  || localStorage.getItem('clientBase')  || 'https://gradz.in').replace(/\/+$/,'');
let   GATEWAY_BASE = (q.get('gateway') || localStorage.getItem('gatewayBase') || null);
localStorage.setItem('clientBase', CLIENT_BASE);
if (GATEWAY_BASE) localStorage.setItem('gatewayBase', GATEWAY_BASE);

// ---------- UI helpers ----------
function hide(el){ el.classList.add('hidden'); }
function show(el){ el.classList.remove('hidden'); }
function fmtMMSS(remainingMs){
  const s = Math.max(0, Math.floor(remainingMs/1000));
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  return `${mm}:${ss}`;
}
function setUIAmount(val){ amountOut.textContent = val != null ? `₹${val}` : '—'; }
function setUIStatus(text){ statusOut.textContent = (text || '—').toUpperCase(); }
function setUITimer(ms){ timerEl.textContent = fmtMMSS(ms); }

function serverDownUI() {
  if (countdownInt) clearInterval(countdownInt);
  currentComment = null;
  isActive = false;

  sessionStorage.removeItem(STORAGE_KEY_COMMENT);

  hide(amountRow);
  hide(kvBlock);
  hide(cancelBtn);
  hide(statusP);
  hide(primaryBtn);
  if (amountInput) {
    amountInput.value = '';
    amountInput.placeholder = '';
    amountInput.disabled = true;
  }

  show(serverDownEl);
  serverDownEl.textContent = 'server down — please check your server';
}

function resetUI(msg){
  if (countdownInt) clearInterval(countdownInt);
  countdownInt = null;
  currentComment = null;
  isActive = false;

  sessionStorage.removeItem(STORAGE_KEY_COMMENT);

  show(amountRow);
  hide(kvBlock);
  hide(cancelBtn);

  amountInput.disabled = false;
  amountInput.value = '';
  amountInput.placeholder = 'Enter amount';

  setUIAmount(null);
  setUIStatus('—');
  setUITimer(0);

  primaryBtn.disabled = false;

  if (msg) { statusP.textContent = msg; show(statusP); }
  else { hide(statusP); }

  hide(serverDownEl);
}

// ---------- network helpers ----------
async function loadConfigFromClient(timeoutMs = 3000){
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${CLIENT_BASE}/config`, { credentials: 'omit', signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cfg = await r.json();
    if (!GATEWAY_BASE) GATEWAY_BASE = (cfg.gatewayUrl || 'https://pay.gradz.in').replace(/\/+$/,'');
    return cfg;
  } finally {
    clearTimeout(to);
  }
}

async function getServerSession(comment, timeoutMs = 3000){
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${CLIENT_BASE}/session/${encodeURIComponent(comment)}`, { credentials: 'omit', signal: controller.signal });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function startCountdown(){
  if (countdownInt) clearInterval(countdownInt);
  countdownInt = setInterval(async ()=>{
    const s = await getServerSession(currentComment);
    if (!s) {
      resetUI('⏰ Time up');
      return;
    }
    const remain = Math.max(0, s.expiresAt - Date.now());
    setUITimer(remain);
    setUIStatus(s.status || 'PENDING');
    if (remain <= 0) {
      clearInterval(countdownInt);
      try { socket.emit('payment-timeup', currentComment); } catch {}
      setUIStatus('TIME UP');
      resetUI('⏰ Time up');
    }
  }, 1000);
}

function enterActiveState(amount, expiresAt){
  isActive = true;
  hide(amountRow);
  show(kvBlock);
  show(cancelBtn);                 // <-- show cancel during session
  cancelBtn.disabled = false;

  setUIAmount(amount);
  setUIStatus('PENDING'); 
  setUITimer(Math.max(0, expiresAt - Date.now()));

  statusP.textContent = 'Waiting for payment…';
  show(statusP);

  startCountdown();
}

function restoreIfAny(){
  const saved = sessionStorage.getItem(STORAGE_KEY_COMMENT);
  if (!saved) return false;
  currentComment = saved;
  try { socket.emit('join-session', currentComment); } catch {}
  getServerSession(currentComment).then(s => {
    if (!s) { resetUI('⏰ Time up'); return; }
    enterActiveState(s.amount, s.expiresAt);
  });
  return true;
}

// ---------- boot ----------
async function boot(){
  // 1) Detect server down quickly
  try {
    await loadConfigFromClient(3000);
  } catch {
    serverDownUI();
    return;
  }

  // 2) Socket connection (guard timeout)
  let connected = false;
  try {
    socket = io(CLIENT_BASE, { transports: ['websocket'], timeout: 3000 });
    socket.on('connect', () => { connected = true; });
    const connectTimer = setTimeout(() => {
      if (!connected) { try { socket.close(); } catch {} serverDownUI(); }
    }, 3000);
    socket.on('connect', () => clearTimeout(connectTimer));
    socket.on('connect_error', () => { clearTimeout(connectTimer); if (!connected) serverDownUI(); });
    socket.on('error',        () => { clearTimeout(connectTimer); if (!connected) serverDownUI(); });
    socket.on('reconnect_error', () => { clearTimeout(connectTimer); if (!connected) serverDownUI(); });
  } catch {
    serverDownUI();
    return;
  }

  // 3) Pay
  primaryBtn.addEventListener('click', async ()=>{
    const amt = Number(String(amountInput.value || '').trim());
    if (!amt || isNaN(amt) || amt <= 0) {
      statusP.textContent='Please enter a valid amount';
      show(statusP);
      return;
    }
    primaryBtn.disabled = true; amountInput.disabled = true;
    statusP.textContent = 'Generating payment link…'; show(statusP);
    try {
      socket.emit('payment', amt);
    } catch {
      serverDownUI();
    }
  });

  // 4) Cancel (NEW: separate button)
  cancelBtn.addEventListener('click', async ()=>{
    cancelBtn.disabled = true;
    if (!currentComment) return;
    try {
      await fetch(`${GATEWAY_BASE}/api/cancel/${encodeURIComponent(currentComment)}`, { method: 'POST' }).catch(()=>{});
    } catch {}
    try { socket.emit('payment-cancel', currentComment); } catch {}
    resetUI('❌ Payment cancelled by user');
  });

  // 5) Socket events
  socket.on('session-created', payload => {
    const { comment, amount, expiresAt } = payload || {};
    if (!comment || !amount || !expiresAt) { resetUI('❌ Error starting session'); return; }
    currentComment = comment;
    sessionStorage.setItem(STORAGE_KEY_COMMENT, currentComment);
    try { socket.emit('join-session', currentComment); } catch {}
    window.open(`${GATEWAY_BASE}/${encodeURIComponent(currentComment)}`, '_blank');
    enterActiveState(amount, expiresAt);
  });

  // Back-compat (if emitted)
  socket.on('payment-comment', comment => {
    currentComment = comment;
    sessionStorage.setItem(STORAGE_KEY_COMMENT, currentComment);
    try { socket.emit('join-session', currentComment); } catch {}
    getServerSession(currentComment).then(s => {
      if (!s) { resetUI('❌ Error starting session'); return; }
      window.open(`${GATEWAY_BASE}/${encodeURIComponent(currentComment)}`, '_blank');
      enterActiveState(s.amount, s.expiresAt);
    });
  });

  socket.on('payment-failure', comment => {
    if (comment !== currentComment) return;
    setUIStatus('FAILED');
    resetUI('❌ Payment failed');
  });

  socket.on('payment-success', comment => {
    if (comment !== currentComment) return;
    setUIStatus('SUCCESS');
    resetUI('✅ Payment successful');
  });

  socket.on('payment-cancelled', comment => {
    if (comment !== currentComment) return;
    setUIStatus('CANCELLED');
    resetUI('❌ Payment cancelled by user');
  });

  socket.on('payment-timeup', comment => {
    if (comment !== currentComment) return;
    setUIStatus('TIME UP'); 
    resetUI('⏰ Time up');
  });

  // 6) Try restoring (only if server is up)
  restoreIfAny();
}

window.addEventListener('DOMContentLoaded', boot);
