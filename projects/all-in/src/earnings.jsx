import { createRoot } from 'react-dom/client';
import EarningsControlCentre from './components/EarningsControlCentre';
import ErrorBoundary from './components/ErrorBoundary';

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <EarningsControlCentre />
  </ErrorBoundary>
);
