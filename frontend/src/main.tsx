import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
// Side-effect import: runs the theme store's module init (applies the stored
// theme, registers the OS-change listener) before first render, so the store and
// the anti-FOUC script in index.html agree on the class from the first frame.
import './stores/themeStore'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
