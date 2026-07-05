import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crm/styles/tailwind.css';
import { StudioMap } from '@crm/pages/farm/studio/StudioMap';
import { TwinStudio } from '@crm/pages/farm/studio/TwinStudio';
import { TwinDetail } from '@crm/pages/farm/studio/TwinDetail';

// Query-string routing (mirrors FarmConsole):
//   /studio.html                 → property placement map (the studio)
//   /studio.html?view=explorer   → twins explorer (grid)
//   /studio.html?twin=<id>       → a twin's workspace
const params = new URLSearchParams(window.location.search);
const twinId = params.get('twin');
const view = params.get('view');

function Studio() {
  if (twinId) return <TwinDetail twinId={twinId} />;
  if (view === 'explorer') return <TwinStudio />;
  return <StudioMap />;
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(<StrictMode><Studio /></StrictMode>);
