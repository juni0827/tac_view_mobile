import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadRuntimeBootstrap } from './runtime/bootstrap'

async function start() {
  try {
    await loadRuntimeBootstrap()

    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch (error) {
    const root = document.getElementById('root')
    if (root) {
      root.innerHTML = `<pre style="padding:16px;color:#fff;background:#000;">Failed to bootstrap TAC_VIEW:\n${String(error)}</pre>`
    }
  }
}

void start()
