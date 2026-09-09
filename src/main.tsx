import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import '@/styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('[fretly:main] 挂载点 #root 不存在');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
