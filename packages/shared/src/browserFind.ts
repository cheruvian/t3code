/** Opens a page-local find toolbar in Chromium, including streamed browser pages. */
export const OPEN_BROWSER_FIND_SCRIPT = `(() => {
  const id = '__t3_browser_find__';
  const existing = document.getElementById(id);
  if (existing) { existing.shadowRoot.querySelector('input').select(); return; }
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647';
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = '<style>:host{color-scheme:light dark}form{display:flex;gap:6px;align-items:center;padding:8px;border:1px solid #888;border-radius:8px;background:Canvas;color:CanvasText;font:14px system-ui;box-shadow:0 2px 12px #0003}input{font:inherit;width:180px;max-width:40vw}button{font:inherit;min-width:28px;min-height:28px}output{font-size:12px}</style><form role="search" aria-label="Find in page"><input aria-label="Find in page" placeholder="Find in page"><output aria-live="polite"></output><button type="button" aria-label="Previous match">↑</button><button type="submit" aria-label="Next match">↓</button><button type="button" aria-label="Close find">×</button></form>';
  const input = root.querySelector('input');
  const status = root.querySelector('output');
  const find = (backwards) => {
    if (!input.value) { status.textContent = ''; return; }
    status.textContent = window.find(input.value, false, backwards, true) ? '' : 'No matches';
    input.focus({preventScroll:true});
  };
  const close = () => { host.remove(); if (previousFocus instanceof HTMLElement) previousFocus.focus({preventScroll:true}); };
  root.querySelector('form').onsubmit = (event) => { event.preventDefault(); find(false); };
  root.querySelectorAll('button')[0].onclick = () => find(true);
  root.querySelectorAll('button')[2].onclick = close;
  input.oninput = () => find(false);
  input.onkeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); }
  };
  document.documentElement.append(host);
  input.focus({preventScroll:true});
})()`;
