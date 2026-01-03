import { createRoot } from 'react-dom/client';
import StockTracker from './components/StockTracker';
import ErrorBoundary from './components/ErrorBoundary';

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <StockTracker />
  </ErrorBoundary>
);
