import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Controller, type Env } from './controller';
import css from './styles.css?inline';
import orbitCss from './orbit.css?inline';

export interface Mounted {
  ctl: Controller;
  /** Remove ScrollMate from the page completely: UI gone, camera off, nothing watched or sent. */
  unmount(): void;
}

/** Mount ScrollMate inside a Shadow DOM so page CSS and ours never mix. */
export function mountScrollMate(env: Env): Mounted {
  const host = document.createElement('div');
  host.id = 'scrollmate-root';
  // The host itself takes no space and catches no events.
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${css}\n${orbitCss}`;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.documentElement.appendChild(host);

  const ctl = new Controller(env, host);
  const root = createRoot(mountPoint);
  root.render(<App ctl={ctl} />);
  void ctl.init();
  return {
    ctl,
    unmount() {
      ctl.destroy();
      root.unmount();
      host.remove();
    },
  };
}
