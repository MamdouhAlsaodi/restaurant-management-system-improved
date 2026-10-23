import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import GuestPage from './components/qr/GuestPage';
import AdminGate from './components/qr/AdminGate';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const path = window.location.pathname;
const guestMatch = path.match(/^\/q\/([^/]+)\/?$/);

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {guestMatch ? (
      // Guest QR route: guest-only page; the admin App is never mounted and
      // localStorage is never read here.
      <GuestPage token={decodeURIComponent(guestMatch[1])} />
    ) : (
      // / and /login (and any admin path): require an authenticated session
      // before mounting the original App and exposing localStorage data.
      <AdminGate>
        <App />
      </AdminGate>
    )}
  </React.StrictMode>
);
