const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const { mkdirSync } = require('node:fs')

// The renderer is exactly the browser app. It receives no Node or Electron API.
const address = new URL(process.env.HOSTAI_UI_URL || 'http://127.0.0.1:3000')
if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.username || address.password) {
  throw new Error('HostAI desktop can only load a local HTTP workspace.')
}
if (process.env.HOSTAI_DESKTOP_USER_DATA) {
  mkdirSync(process.env.HOSTAI_DESKTOP_USER_DATA, { recursive: true, mode: 0o700 })
  app.setPath('userData', process.env.HOSTAI_DESKTOP_USER_DATA)
}
app.setName('HostAI')
if (process.env.HOSTAI_SOFTWARE_RENDERING === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}
// npm's development binary has no root-owned SUID helper. Use Chromium's
// unprivileged user-namespace sandbox on Linux; renderer sandboxing stays on.
if (process.platform === 'linux' && !app.isPackaged) app.commandLine.appendSwitch('disable-setuid-sandbox')
let mainWindow

async function openLink(value) {
  try {
    const { externalUrl } = await import('../shared/external-url.mjs')
    const url = externalUrl(value)
    if (url) await shell.openExternal(url)
  } catch { /* Invalid URLs and unavailable system browsers leave the workspace open. */ }
}
function canWriteClipboard(contents, permission, requestingUrl, isMainFrame) {
  try {
    return contents === mainWindow.webContents && permission === 'clipboard-sanitized-write' &&
      isMainFrame === true && new URL(requestingUrl).origin === address.origin &&
      new URL(contents.getURL()).origin === address.origin
  } catch { return false }
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'HostAI', width: 1380, height: 940, minWidth: 360, minHeight: 600,
    backgroundColor: '#f5f7fa', show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false },
  })
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(canWriteClipboard(contents, permission, details.requestingUrl, details.isMainFrame)))
  mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) =>
    canWriteClipboard(contents, permission, origin, details.isMainFrame))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void openLink(url); return { action: 'deny' } })
  mainWindow.webContents.on('will-navigate', (event, value) => {
    try {
      if (new URL(value).origin !== address.origin) { event.preventDefault(); void openLink(value) }
    } catch { event.preventDefault() }
  })
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  await mainWindow.loadURL(address.href)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Workspace', submenu: [
      { label: 'Open in browser', click: () => void shell.openExternal(address.href) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]))
  await createWindow()
}).catch(error => { dialog.showErrorBox('Could not open HostAI', `${error.message}\nStart the workspace with pnpm desktop:dev.`); app.quit() })
app.on('window-all-closed', () => app.quit())
