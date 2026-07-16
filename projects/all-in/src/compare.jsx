import { createRoot } from 'react-dom/client';
import CompareTracker from './components/CompareTracker';
import ErrorBoundary from './components/ErrorBoundary';

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <CompareTracker />
  </ErrorBoundary>
);
