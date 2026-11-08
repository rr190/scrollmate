/**
 * One-time camera permission page. The hidden offscreen page can't show a permission prompt,
 * so this visible extension page asks once; Chrome then remembers it for the extension.
 */
const btn = document.getElementById('allow') as HTMLButtonElement;
const msg = document.getElementById('msg') as HTMLParagraphElement;

btn.onclick = async () => {
  btn.disabled = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop()); // only needed the permission
    msg.textContent = 'Camera allowed. You can close this tab — ScrollMate will start reacting to you.';
    await chrome.runtime.sendMessage({ type: 'CAMERA_PERMISSION_GRANTED' }).catch(() => undefined);
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    msg.textContent = `Camera not allowed (${(e as Error).name}). You can change this in the camera icon of the address bar.`;
    btn.disabled = false;
  }
};
