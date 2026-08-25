import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthGuard } from './components/auth/AuthGuard';
import { Layout } from './components/layout/Layout';
import { FullPageLoader } from './components/layout/Skeletons';

// Code-split pages for performance (NFR-004)
const Dashboard = React.lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Workflows = React.lazy(() => import('./pages/Workflows').then((m) => ({ default: m.Workflows })));
const Ingestion = React.lazy(() => import('./pages/Ingestion').then((m) => ({ default: m.Ingestion })));
const Chat = React.lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })));

function PageLoader() {
  return <FullPageLoader />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<AuthGuard />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/ingestion" element={<Ingestion />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/chat" element={<Chat />} />
            </Route>
          </Route>
          {/* Catch-all redirect */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
