// Client UI: single button toggles Pay <-> Cancel, with TIMEUP state
let socket;
let gatewayUrl = '';
let socketUrl  = '';

const amountRow   = document.getElementById('amountRow');
const amountInput = document.getElementById('amountInput');

const kvBlock   = document.getElementById('kvBlock');
const amountOut = document.getElementById('amountOut');
const statusOut = document.getElementById('statusOut');
const timerEl   = document.getElementById('timer');

const statusP   = document.getElementById('status');
const primaryBtn= document.getElementById('primaryBtn');

let currentComment = null;
let countdownInt   = null;
let isActive       = false;

const STORAGE_KEY_COMMENT = 'payment_session_comment';
const DFL_STATUS = 'PENDING';
const BTN_TEXT = { PAY: 'Pay', CANCEL: 'Cancel' };

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
function setButtonPay(){ primaryBtn.textContent = BTN_TEXT.PAY; primaryBtn.classList.remove('cancel'); }
function setButtonCancel(){ primaryBtn.textContent = BTN_TEXT.CANCEL; primaryBtn.classList.add('cancel'); }

function resetUI(msg){
  if (countdownInt) clearInterval(countdownInt);
  countdownInt = null;
  currentComment = null;
  isActive = false;

  sessionStorage.removeItem(STORAGE_KEY_COMMENT);

  show(amountRow);
  hide(kvBlock);

  amountInput.disabled = false;
  amountInput.value = '';
  amountInput.placeholder = 'Enter amount';

  setUIAmount(null);
  setUIStatus('—');
  setUITimer(0);

  setButtonPay();
  primaryBtn.disabled = false;

  if (msg) { statusP.textContent = msg; show(statusP); }
  else { hide(statusP); }
}

async function fetchConfig(){
  const cfg = await fetch('/config').then(r=>r.json());
  gatewayUrl = cfg.gatewayUrl;
  socketUrl  = cfg.socketUrl;
}

async function getServerSession(comment){
  const r = await fetch(`/session/${encodeURIComponent(comment)}`);
  if (!r.ok) return null;
  return r.json();
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
    setUIStatus(s.status || DFL_STATUS);
    if (remain <= 0) {
      clearInterval(countdownInt);
      // Tell server: TIMEUP (do NOT cancel gateway)
      // eslint-disable-next-line no-undef
      socket.emit('payment-timeup', currentComment);
      setUIStatus('TIME UP');
      resetUI('⏰ Time up');
    }
  }, 1000);
}

function enterActiveState(amount, expiresAt){
  isActive = true;
  hide(amountRow);
  show(kvBlock);
  setUIAmount(amount);
  setUIStatus(DFL_STATUS);
  setUITimer(Math.max(0, expiresAt - Date.now()));
  setButtonCancel();
  primaryBtn.disabled = false;
  statusP.textContent = 'Waiting for payment…';
  show(statusP);
  startCountdown();
}

function restoreIfAny(){
  const saved = sessionStorage.getItem(STORAGE_KEY_COMMENT);
  if (!saved) return false;
  currentComment = saved;
  // eslint-disable-next-line no-undef
  socket.emit('join-session', currentComment);
  getServerSession(currentComment).then(s => {
    if (!s) { resetUI('⏰ Time up'); return; }
    enterActiveState(s.amount, s.expiresAt);
  });
  return true;
}

async function boot(){
  await fetchConfig();
  // eslint-disable-next-line no-undef
  socket = io(socketUrl);

  socket.on('connect', ()=> console.log('[client] socket connected', socket.id));

  primaryBtn.addEventListener('click', async ()=>{
    if (!isActive) {
      // PAY flow
      const amt = Number(String(amountInput.value || '').trim());
      if (!amt || isNaN(amt) || amt <= 0) {
        statusP.textContent='Please enter a valid amount';
        show(statusP);
        return;
      }
      primaryBtn.disabled = true; amountInput.disabled = true;
      statusP.textContent = 'Generating payment link…'; show(statusP);
      // eslint-disable-next-line no-undef
      socket.emit('payment', amt);
    } else {
      // CANCEL flow
      primaryBtn.disabled = true;
      if (!currentComment) return;
      try {
        await fetch(`${gatewayUrl}/api/cancel/${encodeURIComponent(currentComment)}`, { method: 'POST' }).catch(()=>{});
      } catch {}
      // eslint-disable-next-line no-undef
      socket.emit('payment-cancel', currentComment);
      resetUI('❌ Payment cancelled by user');
    }
  });

  // eslint-disable-next-line no-undef
  socket.on('session-created', payload => {
    const { comment, amount, expiresAt } = payload || {};
    if (!comment || !amount || !expiresAt) {
      resetUI('❌ Error starting session');
      return;
    }
    currentComment = comment;
    sessionStorage.setItem(STORAGE_KEY_COMMENT, currentComment);
    // eslint-disable-next-line no-undef
    socket.emit('join-session', currentComment);
    window.open(`${gatewayUrl}/${encodeURIComponent(currentComment)}`, '_blank');
    enterActiveState(amount, expiresAt);
  });

  // Back-compat
  // eslint-disable-next-line no-undef
  socket.on('payment-comment', comment => {
    currentComment = comment;
    sessionStorage.setItem(STORAGE_KEY_COMMENT, currentComment);
    // eslint-disable-next-line no-undef
    socket.emit('join-session', currentComment);
    getServerSession(currentComment).then(s => {
      if (!s) { resetUI('❌ Error starting session'); return; }
      window.open(`${gatewayUrl}/${encodeURIComponent(currentComment)}`, '_blank');
      enterActiveState(s.amount, s.expiresAt);
    });
  });

  // Gateway → failure (amount mismatch)
  // eslint-disable-next-line no-undef
  socket.on('payment-failure', comment => {
    if (comment !== currentComment) return;
    setUIStatus('FAILED');
    resetUI('❌ Payment failed');
  });

  // Gateway → success
  // eslint-disable-next-line no-undef
  socket.on('payment-success', comment => {
    if (comment !== currentComment) return;
    setUIStatus('SUCCESS');
    resetUI('✅ Payment successful');
  });

  // Server → cancelled by user
  // eslint-disable-next-line no-undef
  socket.on('payment-cancelled', comment => {
    if (comment !== currentComment) return;
    setUIStatus('CANCELLED');
    resetUI('❌ Payment cancelled by user');
  });

  // TIMEUP from server/gateway
  // eslint-disable-next-line no-undef
  socket.on('payment-timeup', comment => {
    if (comment !== currentComment) return;
    setUIStatus('TIME UP');
    resetUI('⏰ Time up');
  });

  restoreIfAny();
}

window.addEventListener('DOMContentLoaded', boot);
