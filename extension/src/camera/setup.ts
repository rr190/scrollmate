/**
 * One-time camera permission page. The hidden offscreen page can't show a permission prompt,
 * so this visible extension page asks once; Chrome then remembers it for the extension.
 */
const btn = document.getElementById('allow') as HTMLButtonElement;
const msg = document.getElementById('msg') as HTMLParagraphElement;
const microphone = new URLSearchParams(location.search).has('microphone');
if (microphone) {
  document.title = 'ScrollMate microphone access';
  document.querySelector('h1')!.textContent = 'Talk to your buddy';
  document.querySelector('main > p')!.textContent = 'Allow your microphone once, then return to the reel and tap the microphone on your buddy.';
  document.querySelector('ul')!.innerHTML = '<li>During a conversation you start, microphone audio streams through your backend to Gemini, including while the buddy replies.</li><li>You can interrupt by speaking. ScrollMate does not save audio or transcripts to disk.</li><li>Tap the microphone again or press Escape to end and turn the microphone off.</li>';
  btn.textContent = 'Allow microphone';
}

btn.onclick = async () => {
  btn.disabled = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia(microphone ? { video: false, audio: true } : { video: true, audio: false });
    s.getTracks().forEach((t) => t.stop()); // only needed the permission
    msg.textContent = microphone ? 'Microphone allowed. Return to your reel and tap the buddy microphone again.'
      : 'Camera allowed. You can close this tab — ScrollMate will start reacting to you.';
    await chrome.runtime.sendMessage({ type: microphone ? 'TALK_MIC_PERMISSION_GRANTED' : 'CAMERA_PERMISSION_GRANTED' }).catch(() => undefined);
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    msg.textContent = `${microphone ? 'Microphone' : 'Camera'} not allowed (${(e as Error).name}). You can change permissions in the address bar.`;
    btn.disabled = false;
  }
};
