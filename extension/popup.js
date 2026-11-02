// Popup: connection status, port (chrome.storage.local "port"), pairing token ("token"),
// optional allowed-domains ceiling ("allowCeiling").
const $ = (id) => document.getElementById(id);

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: 'fb.status' });
  } catch (e) {
    s = { state: 'disconnected', error: e.message };
  }
  s = s || { state: 'disconnected' };
  $('dot').className = 'dot ' + s.state;
  $('state').textContent = `${s.state} — ws://127.0.0.1:${s.port ?? '?'}`;
  $('detail').textContent = s.error
    ? s.error
    : s.state === 'connected'
      ? `current tab: ${s.currentTabId ?? 'none'}`
      : 'Start the Fast Browser MCP server (Claude Code) to connect.';
  $('domains').textContent = s.allowedDomains ? `allowed: ${s.allowedDomains.join(', ') || '(none)'}` : '';
  $('paired').textContent = s.paired ? 'token saved' : 'not paired: paste the token from ~/.fast-browser/token';
  if (document.activeElement !== $('ceiling')) $('ceiling').value = (s.ceiling || []).join(', ');
  if (document.activeElement !== $('port')) $('port').value = s.port ?? 17890;
}

$('save').addEventListener('click', async () => {
  const n = Number($('port').value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    $('detail').textContent = 'port must be 1–65535';
    return;
  }
  await chrome.storage.local.set({ port: n });
  setTimeout(refresh, 300);
});

$('saveToken').addEventListener('click', async () => {
  const t = $('token').value.trim();
  if (!/^[0-9a-f]{32,}$/i.test(t)) {
    $('detail').textContent = 'token must be the hex string from ~/.fast-browser/token';
    return;
  }
  await chrome.storage.local.set({ token: t });
  $('token').value = '';
  setTimeout(refresh, 300);
});

$('saveCeiling').addEventListener('click', async () => {
  const list = $('ceiling').value.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  await chrome.storage.local.set({ allowCeiling: list });
  setTimeout(refresh, 300);
});

$('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'fb.reconnect' });
  setTimeout(refresh, 300);
});

refresh();
setInterval(refresh, 1000);
