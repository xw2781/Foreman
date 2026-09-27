import { createRoot } from 'react-dom/client';
import { App } from './App';
import { pageTheme } from './api';
import './styles.css';

// Settings load asynchronously; set the theme now so the first paint isn't dark by default.
document.documentElement.dataset.theme = pageTheme(window.atc.initialTheme, window.matchMedia('(prefers-color-scheme: dark)').matches);

createRoot(document.getElementById('root')!).render(<App />);
