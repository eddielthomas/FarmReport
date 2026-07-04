import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@crm/styles/tailwind.css';
import { LoginPage } from '@crm/pages/Login';

const queryClient = new QueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LoginPage />
    </QueryClientProvider>
  </StrictMode>,
);
