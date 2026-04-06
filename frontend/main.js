import Alpine from 'alpinejs'
import './styles.css'
import { parlorApp } from './app.js'
import { ensureVendorScripts } from './vendor-loader.js'

window.parlorApp = parlorApp
window.Alpine = Alpine
window.ensureVendorScripts = ensureVendorScripts

Alpine.start()
