import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';

render(<App />, document.getElementById('app')!);

// End-to-end test builds only; removed from normal builds.
if (import.meta.env.VITE_E2E) void import('./testHooks');

// Offline support and "Add to Home Screen": only for real builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* the app works without it */
    });
  });
}
