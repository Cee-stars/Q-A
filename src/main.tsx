import { render } from 'preact'
import { App } from './app'
import './styles.css'

render(<App />, document.getElementById('app') as HTMLElement)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  })
}
