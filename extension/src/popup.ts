const statusElement = document.getElementById('status')!;
async function refresh(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: 'status' })) as { status: string };
  statusElement.textContent = reply.status;
}
for (const type of ['connect', 'open', 'select']) {
  document.getElementById(type)!.addEventListener('click', () => {
    void chrome.runtime
      .sendMessage({ type })
      .then(async (reply: { ok?: boolean; message?: string }) => {
        if (reply.ok === false)
          statusElement.textContent = reply.message ?? 'Check your Fidelity tab.';
        else if (type === 'select') statusElement.textContent = 'This Fidelity tab is selected.';
        else await refresh();
      })
      .catch(() => {
        statusElement.textContent = 'Extension unavailable. Reload it in chrome://extensions.';
      });
  });
}
void refresh();
setInterval(() => void refresh().catch(() => {}), 1500);
