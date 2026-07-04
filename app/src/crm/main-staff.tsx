import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crm/styles/tailwind.css';
import { App } from '@crm/App';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <App page="staff" />
  </StrictMode>,
);
