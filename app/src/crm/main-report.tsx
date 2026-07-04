import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@crm/styles/tailwind.css';
import { ReportView } from '@crm/pages/farm/ReportView';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ReportView />
    </QueryClientProvider>
  </StrictMode>,
);
