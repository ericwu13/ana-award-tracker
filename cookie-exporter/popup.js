document.getElementById('btn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Exporting...';
  status.style.color = '#666';

  chrome.runtime.sendMessage({ action: 'exportCookies' }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = '❌ ' + chrome.runtime.lastError.message;
      status.style.color = '#c62828';
      return;
    }
    if (response?.ok) {
      status.textContent = `✅ Sent ${response.count} cookies to bot`;
      status.style.color = '#2e7d32';
    } else {
      status.textContent = `⚠️ ${response?.error || 'Failed'}. Is the bot running?`;
      status.style.color = '#e65100';
    }
  });
});
