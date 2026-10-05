#!/usr/bin/env node
// Browser smoke test of the panel.
//
// It starts its own mock relay and two throwaway copies of the API on local
// ports of the 39xxx range, then walks the panel as an operator would: the
// setup of a fresh install, every page, the order book and a phone-sized
// screen. An error in the browser console fails the run; a request the test
// makes fail on purpose is asserted through what the page shows instead.
//
// The copies of the API get a temporary configuration and backup directory
// and none of the variables that would connect them to LND, to Mostro, to a
// webhook or to an existing identity. The only relay in their configuration
// is the mock one: the step that publishes the community card checks that
// before it turns the switch on, so no event leaves this machine.
//
// What it cannot cover with the built-in mock relay, which serves a single
// published order: real disputes, orders in progress and the open-market
// state. Those are exercised with stubbed API answers, which checks the
// panel's own logic but not the server's.
//
// Before running it:
//   cargo build -p mostro-community-api
//   npm --prefix web run build
//
// Playwright is not a dependency of the project. Point the script at a copy:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core node scripts/playwright-smoke.cjs
//
// Optional:
//   PLAYWRIGHT_CHROMIUM=/path/to/chrome   browser binary, found in ~/.cache/ms-playwright otherwise
//   SMOKE_SHOTS=/some/dir                 keep a screenshot of each page

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const API_BINARY = path.join(REPO_ROOT, 'target', 'debug', 'mostro-community-api');
const STATIC_DIR = path.join(REPO_ROOT, 'web', 'dist');
const SHOTS_DIR = process.env.SMOKE_SHOTS || '';
const API_HEADERS = { 'x-requested-with': 'mostro-community', 'content-type': 'application/json' };

// Every page of the panel: its route and the heading it must show.
const PAGES = [
  { hash: '#/', nav: 'Resumen', heading: null },
  { hash: '#/ordenes', nav: 'Órdenes', heading: 'Órdenes' },
  { hash: '#/disputas', nav: 'Disputas', heading: 'Disputas' },
  { hash: '#/nodo', nav: 'Nodo Mostro', heading: 'Nodo Mostro' },
  { hash: '#/lightning', nav: 'Lightning', heading: 'Lightning' },
  { hash: '#/conexion', nav: 'Conexión de apps', heading: 'Conexión de apps' },
  { hash: '#/configuracion', nav: 'Configuración', heading: 'Configuración' },
  { hash: '#/respaldos', nav: 'Respaldos', heading: 'Respaldos' },
  { hash: '#/alertas', nav: 'Alertas', heading: 'Alertas' },
  { hash: '#/simulador', nav: 'Simulador', heading: 'Simulador de operaciones' },
];
const NAV_GROUPS = ['Inicio', 'Mercado', 'Nodo', 'Ajustes', 'Herramientas'];

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) {
      // try the next one
    }
  }
  throw new Error('Playwright not found. Set PLAYWRIGHT_MODULE to the path of a playwright or playwright-core module.');
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const names = ['chrome-headless-shell', 'chrome'];
  for (const entry of fs.readdirSync(cache).sort().reverse()) {
    if (!entry.startsWith('chromium')) continue;
    for (const sub of fs.readdirSync(path.join(cache, entry))) {
      for (const name of names) {
        const candidate = path.join(cache, entry, sub, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined; // let Playwright use its own
}

/** The newest modification time under a directory. */
function newestIn(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestIn(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

const children = [];
const tempDirs = [];
function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

/** A free local port between `from` and `to`, the range kept for test services on this machine. */
async function freePort(from, to) {
  for (let port = from; port <= to; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port between ${from} and ${to}.`);
}

/**
 * Starts a child and resolves with the first match of `pattern` in its
 * output. The match carries `output()`, everything the child has printed so far.
 */
function startAndWaitFor(args, env, pattern, what) {
  const child = spawn(API_BINARY, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) resolve(Object.assign(match, { output: () => output }));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`${what} exited with code ${code}. Output: ${output}`)));
    setTimeout(() => reject(new Error(`Timeout waiting for ${what}. Output: ${output}`)), 15000);
  });
}

async function startMockRelay() {
  const port = await freePort(39700, 39799);
  const match = await startAndWaitFor(['mock-relay', `127.0.0.1:${port}`], process.env, /MOCK_RELAY_READY npub=(\S+) url=(\S+)\r?\n/, 'the mock relay');
  /** The events published to the relay so far. */
  const published = () => [...match.output().matchAll(/^MOCK_RELAY_EVENT (.+)$/gm)].map((line) => JSON.parse(line[1]));
  return { npub: match[1], url: match[2], published };
}

/** One copy of the API that serves the built UI and can reach nothing but its own temporary directories. */
async function startPanel(configDir) {
  const env = { ...process.env, CONFIG_DIR: configDir, API_BIND: `127.0.0.1:${await freePort(39300, 39399)}`, STATIC_DIR, BACKUP_OFFSITE_DIR: tempDir('mostro-smoke-backups-') };
  for (const name of ['LND_REST_URL', 'LND_TLS_CERT', 'LND_READONLY_MACAROON', 'LND_CONNECT_HOST', 'MOSTRO_RPC_URL', 'BACKUP_PASSPHRASE', 'MOCK_LND_CHANNELS', 'WEBHOOK_URL', 'MOSTRO_PUBLIC_KEY', 'MOSTRO_PUBKEY']) delete env[name];
  const match = await startAndWaitFor([], env, /Community API listening on ([0-9.:]+)\r?\n/, 'the API');
  return `http://${match[1]}`;
}

let stepNumber = 0;
async function step(title, run) {
  stepNumber += 1;
  process.stdout.write(`[${String(stepNumber).padStart(2, '0')}] ${title} … `);
  await run();
  console.log('ok');
}

async function main() {
  for (const required of [API_BINARY, path.join(STATIC_DIR, 'index.html')]) {
    assert.ok(fs.existsSync(required), `Missing ${path.relative(REPO_ROOT, required)}. Build the API and the UI first.`);
  }
  // A build older than the sources would test yesterday's panel.
  assert.ok(
    fs.statSync(path.join(STATIC_DIR, 'index.html')).mtimeMs >= newestIn(path.join(REPO_ROOT, 'web', 'src')),
    'web/dist is older than web/src. Run `npm --prefix web run build` first.',
  );
  if (SHOTS_DIR) fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const errors = [];

  /** A page that records its console errors and answers the confirmation dialogs with `dialogs.answer`. */
  async function openPage(viewport) {
    const page = await browser.newPage({ viewport });
    const dialogs = { answer: true, seen: [] };
    page.on('pageerror', (error) => errors.push(`PageError: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // The browser logs every rejected request; the steps that provoke one assert on the page instead.
      if (text.includes('favicon') || text.includes('Failed to load resource')) return;
      errors.push(`ConsoleError: ${text}`);
    });
    page.on('dialog', (dialog) => {
      dialogs.seen.push(dialog.message());
      void (dialogs.answer ? dialog.accept() : dialog.dismiss());
    });
    return { page, dialogs };
  }

  const heading = (page) => page.locator('.page-header h1');
  const marketTitle = (page) => page.locator('#market-status-title');
  const navLink = (page, label) => page.locator('.side-nav a.side-link', { hasText: new RegExp(`^${label}`) });
  const currentHash = (page) => new URL(page.url()).hash;
  const hasOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  async function shot(page, name) {
    if (SHOTS_DIR) await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
  }

  const relay = await startMockRelay();

  // ------------------------------------------------------------------
  // A. A fresh install, from an empty directory to an activated node.
  // ------------------------------------------------------------------
  const freshUrl = await startPanel(tempDir('mostro-smoke-fresh-'));
  const { page, dialogs } = await openPage({ width: 1280, height: 900 });

  await step('fresh install: the summary says what is missing and lists the setup', async () => {
    await page.goto(freshUrl, { waitUntil: 'networkidle' });
    await marketTitle(page).filter({ hasText: 'Tu comunidad aún no está preparada' }).waitFor();
    await page.getByText('0 de 6', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.side-group-label').allTextContents(), NAV_GROUPS);
    assert.equal(await page.locator('.side-nav a.side-link').count(), PAGES.length);
    // Before there is anything to manage, the setup list is the only call to action.
    assert.equal(await page.locator('#attention').count(), 0);
    await shot(page, 'fresh-01-summary');
  });

  await step('fresh install: the main button leads to the identity', async () => {
    await page.locator('.status-hero-action button').click();
    await heading(page).filter({ hasText: 'Nodo Mostro' }).waitFor();
    assert.equal(currentHash(page), '#/nodo');
    // Without an identity there is nothing to switch on.
    assert.ok(await page.getByRole('button', { name: 'Activar Mostro', exact: true }).isDisabled());
  });

  await step('identity: an invalid key is refused inside a dialog that keeps the keyboard', async () => {
    await page.getByRole('button', { name: 'Tengo una clave nsec' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Usar una clave que ya tienes' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'import-nsec');
    for (let presses = 0; presses < 8; presses += 1) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'Tab left the dialog');
    }
    await dialog.locator('input').fill('nsec1nolaes');
    await dialog.getByRole('button', { name: 'Importar la clave' }).click();
    await dialog.locator('.form-message.error').waitFor();
    await shot(page, 'fresh-01b-import-dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    // Focus goes back to the button that opened the dialog.
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Tengo una clave nsec');
  });

  await step('identity: a new key is shown once, must be acknowledged and cannot be asked for again', async () => {
    await page.getByRole('button', { name: 'Crear una identidad nueva' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Guarda la clave privada de tu nodo' }).waitFor();
    assert.match(await dialog.locator('.copy-box code').first().textContent(), /^nsec1[a-z0-9]{50,}$/);
    const next = dialog.getByRole('button', { name: 'Continuar con la configuración' });
    assert.ok(await next.isDisabled());
    // Escape does not throw the only copy of the key away without asking.
    dialogs.answer = false;
    dialogs.seen.length = 0;
    await page.keyboard.press('Escape');
    assert.equal(dialogs.seen.length, 1, 'closing an unsaved key must ask for confirmation');
    await dialog.getByRole('heading', { name: 'Guarda la clave privada de tu nodo' }).waitFor();
    dialogs.answer = true;
    if (SHOTS_DIR) {
      // The key is a throwaway, but a private key has no place in a screenshot.
      await dialog.locator('.copy-box code').first().evaluate((element) => { element.style.visibility = 'hidden'; });
      await shot(page, 'fresh-01c-new-identity-dialog');
    }
    await dialog.locator('input[type="checkbox"]').check();
    await next.click();
    await heading(page).filter({ hasText: 'Configuración' }).waitFor();
    assert.equal(currentHash(page), '#/configuracion');
    // The private key is gone from the page, and the server neither repeats it nor makes another.
    assert.equal(await page.getByText(/nsec1[a-z0-9]{20,}/).count(), 0);
    const again = await page.request.post(`${freshUrl}/api/identity/generate`, { headers: API_HEADERS, data: {} });
    assert.equal(again.ok(), false, 'a second identity must be refused');
    for (const endpoint of ['/api/daemon/status', '/api/connection', '/api/community']) {
      const body = await (await page.request.get(`${freshUrl}${endpoint}`, { headers: API_HEADERS })).text();
      assert.equal(/nsec1[a-z0-9]{20,}/.test(body), false, `${endpoint} returned a private key`);
    }
  });

  await step('configuration: fill the rules, apply a template and save', async () => {
    await page.locator('.flash', { hasText: 'Identidad lista' }).waitFor();
    await page.getByPlaceholder('Ej. Bitcoin Quito').fill('Comunidad de prueba');
    const currencySearch = page.getByPlaceholder(/^Buscar moneda/);
    await currencySearch.fill('USD');
    await currencySearch.press('Enter');
    await page.locator('.currency-selected-chips', { hasText: 'USD' }).waitFor();
    await page.getByPlaceholder('wss://relay.example.org').fill(relay.url);
    await page.getByRole('button', { name: 'Añadir relay' }).click();
    await page.getByRole('button', { name: '+ Añadir método de pago' }).click();
    await page.getByLabel('Identificador del método').fill('transferencia');
    await page.getByLabel('Nombre del método').fill('Transferencia bancaria');
    await page.getByLabel('Categoría del método').fill('Banco');
    // A template says on its card everything it is going to change.
    const template = page.locator('.preset-commission-card-btn').first();
    assert.match(
      (await template.locator('.preset-facts').textContent()).replace(/\s/g, ' '),
      /^Comisión 0,5 % · aporte al desarrollo 10 % · enrutamiento máximo 0,1 % · garantía 3 % con mínimo de 5 000 sats, la paga quien publica y quien toma · penalización automática por vencimiento activada$/,
    );
    await template.click();
    await page.getByText(/Plantilla aplicada/).first().waitFor();
    await page.locator('.save-state', { hasText: 'Cambios sin guardar' }).waitFor();
    await page.getByRole('button', { name: 'Guardar configuración' }).click();
    await page.locator('.save-state', { hasText: 'Guardado · revisión 1' }).waitFor();
    await shot(page, 'fresh-02-config');
  });

  await step('summary: the next step is the backup, in the headline and in its button', async () => {
    await navLink(page, 'Resumen').click();
    await marketTitle(page).filter({ hasText: 'El mercado está sin iniciar' }).waitFor();
    await page.getByText('2 de 6', { exact: true }).waitFor();
    await page.locator('.status-hero', { hasText: 'Siguiente paso: guarda un respaldo cifrado.' }).waitFor();
    assert.equal((await page.locator('.side-community b').textContent()).trim(), 'Comunidad de prueba');
    await page.locator('.status-hero-action button').click();
    await heading(page).filter({ hasText: 'Respaldos' }).waitFor();
  });

  await step('backups: an encrypted backup is created and listed', async () => {
    const create = page.getByRole('button', { name: 'Crear respaldo', exact: true });
    assert.ok(await create.isDisabled());
    await page.getByPlaceholder('Mínimo 16 caracteres').fill('una frase larga de prueba 42');
    await create.click();
    await page.locator('.file-list li').first().waitFor();
    assert.equal(await page.locator('.file-list li').count(), 1);
    // The passphrase does not stay in the form.
    assert.equal(await page.getByPlaceholder('Mínimo 16 caracteres').inputValue(), '');
    // The restore command writes inside the backup folder, the one the package keeps private.
    assert.match(await page.locator('#backup-restore .command').nth(1).textContent(), /restore-backup (\S+)\/<archivo\.age> \1\/restaurado$/);
    await navLink(page, 'Resumen').click();
    await page.getByText('3 de 6', { exact: true }).waitFor();
  });

  await step('connection: the node can be shared with an app', async () => {
    await navLink(page, 'Conexión de apps').click();
    await heading(page).filter({ hasText: 'Conexión de apps' }).waitFor();
    await page.locator('.qr-box-wrapper svg').waitFor();
    await page.getByText(relay.url).first().waitFor();
    await page.getByText('Cómo resolver «Invalid parameters» o «prima no válida»').click();
    await page.getByText('Importe fijo', { exact: false }).first().waitFor();
    await shot(page, 'fresh-03-connection');
  });

  const publication = async (baseUrl) => (await page.request.get(`${baseUrl}/api/community/card/publication`, { headers: API_HEADERS })).json();
  const publishSwitch = () => page.getByRole('switch', { name: 'Publicar la tarjeta de la comunidad' });
  const publishPanel = () => page.locator('#connect-publish');
  /** The switch may only be turned on where every relay of the configuration is the mock one. */
  const assertOnlyTheMockRelay = async (baseUrl) => {
    const saved = await (await page.request.get(`${baseUrl}/api/community`, { headers: API_HEADERS })).json();
    assert.deepEqual(saved.config.nostr.relays, [relay.url], 'the test would publish outside the mock relay');
    assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:397\d\d$/);
  };

  await step('connection: the card is not published until the operator says so', async () => {
    await publishPanel().getByRole('heading', { name: 'Publicar la tarjeta en los relays' }).waitFor();
    assert.equal(await publishSwitch().getAttribute('aria-checked'), 'false');
    await publishPanel().locator('.badge', { hasText: 'Desactivada' }).waitFor();
    // The panel says in plain words what becomes public and what turning it off can and cannot undo.
    const facts = (await publishPanel().locator('.publish-facts').textContent()).replace(/\s+/g, ' ');
    for (const expected of ['los métodos de pago activos, la web y el contacto', 'Cualquiera que consulte los relays puede leerlo', 'firmado con su clave', 'una app que ya la leyó la conserva']) {
      assert.ok(facts.includes(expected), `the explanation does not say: ${expected}`);
    }
    assert.equal((await publication(freshUrl)).enabled, false);
    assert.deepEqual(relay.published(), []);

    // Turning it on asks first, and saying no leaves everything as it was.
    await assertOnlyTheMockRelay(freshUrl);
    dialogs.answer = false;
    dialogs.seen.length = 0;
    await publishSwitch().click();
    assert.equal(dialogs.seen.length, 1, 'publishing must ask for confirmation');
    assert.match(dialogs.seen[0], /^¿Publicar la tarjeta de la comunidad en el relay del nodo\?/);
    assert.match(dialogs.seen[0], /firmados con la clave del nodo: el nombre, la moneda, el método de pago, la web y el contacto/);
    assert.equal(await publishSwitch().getAttribute('aria-checked'), 'false');
    assert.equal((await publication(freshUrl)).enabled, false);
    assert.deepEqual(relay.published(), []);
    dialogs.answer = true;
  });

  await step('connection: the card is published as an event and the panel shows what the relay answered', async () => {
    await publishSwitch().click();
    await publishPanel().locator('.callout', { hasText: 'Publicada en el relay del nodo' }).waitFor({ timeout: 15000 });
    assert.equal(await publishSwitch().getAttribute('aria-checked'), 'true');
    await publishPanel().locator('.badge', { hasText: 'Publicada' }).first().waitFor();
    const row = publishPanel().locator('.publish-relays li', { hasText: relay.url });
    await row.locator('.badge', { hasText: 'La tiene' }).waitFor();

    const status = await publication(freshUrl);
    assert.equal(status.state, 'published');
    assert.deepEqual(status.relays.map((item) => [item.url, item.outcome]), [[relay.url, 'accepted']]);
    // What reached the relay is the agreed event: kind 30078, the card's own address and the signed card inside.
    const events = relay.published();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, 30078);
    assert.deepEqual(event.tags, [['d', 'mostro-community-card']]);
    assert.equal(event.id, status.event_id);
    assert.equal(event.created_at, status.card_changed_at);
    const connection = await (await page.request.get(`${freshUrl}/api/connection`, { headers: API_HEADERS })).json();
    assert.equal(event.pubkey, connection.pubkey_hex);
    const card = JSON.parse(event.content);
    assert.equal(card.pubkey, event.pubkey);
    assert.equal(card.name, 'Comunidad de prueba');
    assert.deepEqual(card.payment_methods, ['Transferencia bancaria']);
    assert.match(card.signature, /^[0-9a-f]{128}$/);
    assert.equal(/nsec1/.test(JSON.stringify([event, status])), false);
    await shot(page, 'fresh-03b-card-published');

    // It is still on after a reload, and nothing new was sent for it.
    await page.reload({ waitUntil: 'networkidle' });
    await publishPanel().locator('.callout', { hasText: 'Publicada en el relay del nodo' }).waitFor();
    assert.equal(relay.published().length, 1);
    await navLink(page, 'Resumen').click();
    await marketTitle(page).waitFor();
    assert.equal(await page.getByText('La tarjeta de la comunidad no está publicada').count(), 0);
    await navLink(page, 'Conexión de apps').click();
  });

  await step('connection: turning the switch off asks first and withdraws the card', async () => {
    dialogs.seen.length = 0;
    await publishSwitch().click();
    assert.equal(dialogs.seen.length, 1, 'withdrawing must ask for confirmation');
    assert.match(dialogs.seen[0], /^¿Dejar de publicar la tarjeta\?/);
    assert.match(dialogs.seen[0], /las apps que ya la leyeron la conservan/);
    await publishPanel().locator('.callout', { hasText: 'Tarjeta retirada el' }).waitFor({ timeout: 15000 });
    assert.equal(await publishSwitch().getAttribute('aria-checked'), 'false');
    await publishPanel().locator('.publish-relays li', { hasText: relay.url }).locator('.badge', { hasText: 'Borrado aceptado' }).waitFor();
    assert.equal((await publication(freshUrl)).state, 'withdrawn');
    const events = relay.published();
    assert.equal(events.length, 2);
    // A deletion request for the card's address, and for no other event of the node.
    assert.equal(events[1].kind, 5);
    assert.deepEqual(events[1].tags, [['a', `30078:${events[0].pubkey}:mostro-community-card`], ['e', events[0].id], ['k', '30078']]);
    await shot(page, 'fresh-03c-card-withdrawn');
  });

  await step('configuration: an unsaved draft survives leaving the page, and removing a relay counts as a change', async () => {
    await navLink(page, 'Configuración').click();
    await page.getByPlaceholder('Ej. Bitcoin Quito').fill('Nombre a medias');
    await navLink(page, 'Resumen').click();
    await page.getByText('Tienes cambios de configuración sin guardar').waitFor();
    await navLink(page, 'Configuración').click();
    assert.equal(await page.getByPlaceholder('Ej. Bitcoin Quito').inputValue(), 'Nombre a medias');
    dialogs.answer = true;
    await page.getByRole('button', { name: 'Recargar', exact: true }).click();
    await page.locator('.save-state', { hasText: 'Guardado · revisión 1' }).waitFor();
    assert.equal(await page.getByPlaceholder('Ej. Bitcoin Quito').inputValue(), 'Comunidad de prueba');

    await page.locator('.relay-chip').first().click();
    await page.locator('.save-state', { hasText: 'Cambios sin guardar' }).waitFor();
    await page.getByRole('button', { name: 'Recargar', exact: true }).click();
    await page.locator('.save-state', { hasText: 'Guardado · revisión 1' }).waitFor();
    assert.equal(await page.locator('.relay-chip').count(), 1);
  });

  await step('configuration: a name the signed card cannot carry is refused, with the field to change', async () => {
    await page.getByPlaceholder('Ej. Bitcoin Quito').fill('Compra & venta');
    await page.getByRole('button', { name: 'Guardar configuración' }).click();
    await page.locator('.form-message.error', { hasText: 'El nombre de la comunidad no puede contener «&»' }).waitFor();
    await page.locator('.save-state', { hasText: 'Cambios sin guardar' }).waitFor();
    dialogs.answer = true;
    await page.getByRole('button', { name: 'Recargar', exact: true }).click();
    await page.locator('.save-state', { hasText: 'Guardado · revisión 1' }).waitFor();
    assert.equal(await page.getByPlaceholder('Ej. Bitcoin Quito').inputValue(), 'Comunidad de prueba');
  });

  await step('node: activating and deactivating both ask first and report the result', async () => {
    await navLink(page, 'Nodo Mostro').click();
    const activate = page.getByRole('button', { name: 'Activar Mostro', exact: true });
    dialogs.answer = false;
    dialogs.seen.length = 0;
    await activate.click();
    assert.equal(dialogs.seen.length, 1, 'activation must ask for confirmation');
    assert.match(dialogs.seen[0], /^¿Activar Mostro/);
    await page.locator('.side-status', { hasText: 'Sin iniciar' }).waitFor();

    dialogs.answer = true;
    await activate.click();
    await page.locator('.flash', { hasText: 'Mostro activado' }).waitFor();
    // Activated settings without a daemon announcing itself are not an open market.
    await page.locator('.side-status', { hasText: 'Sin confirmar' }).waitFor();
    await page.getByRole('button', { name: 'Aplicar y reiniciar' }).waitFor();

    const deactivate = page.getByRole('button', { name: 'Desactivar Mostro' });
    dialogs.answer = false;
    dialogs.seen.length = 0;
    await deactivate.click();
    assert.equal(dialogs.seen.length, 1, 'deactivation must ask for confirmation');
    assert.match(dialogs.seen[0], /^¿Desactivar Mostro\?/);
    // The question says what the panel cannot see, not only what it counts.
    assert.match(dialogs.seen[0], /puede estar ya tomada|no está al día con los relays/);
    await page.locator('.side-status', { hasText: 'Sin confirmar' }).waitFor();

    dialogs.answer = true;
    await deactivate.click();
    await page.locator('.flash', { hasText: 'Mostro desactivado' }).waitFor();
    await page.locator('.side-status', { hasText: 'Sin iniciar' }).waitFor();
    await shot(page, 'fresh-04-node');
  });

  // ------------------------------------------------------------------
  // B. A node that follows the mock relay: the order book and every page.
  // ------------------------------------------------------------------
  const seededDir = tempDir('mostro-smoke-seeded-');
  fs.mkdirSync(path.join(seededDir, 'identity'), { mode: 0o700 });
  fs.writeFileSync(path.join(seededDir, 'identity', 'mostro.pub'), `${relay.npub}\n`, { mode: 0o600 });
  const seededConfig = {
    community: { name: 'Comunidad con órdenes', about: 'Pruebas del libro de órdenes', website: 'https://test.community', contact: 'https://t.me/test', language: 'es' },
    market: { fiat_currencies: ['EUR', 'USD'], min_trade_sats: 1000, max_trade_sats: 1000000, fee_bps: 60, dev_fee_bps: 0, max_routing_fee_bps: 10 },
    safety: { bond_enabled: true, bond_bps: 300, base_bond_sats: 1000, bond_apply_to: 'both', automatic_timeout_slash: true, pow: 0, pow_first_contact: 0 },
    nostr: { relays: [relay.url] },
    payment_methods: [{ id: 'cash_test', label: 'Efectivo', category: 'cash', active: true }],
  };
  fs.writeFileSync(path.join(seededDir, 'community.json'), JSON.stringify({ revision: 1, config: seededConfig }, null, 2), { mode: 0o600 });
  // Settings on disk with no daemon behind them: the panel must not call that an open market.
  fs.mkdirSync(path.join(seededDir, 'active'), { mode: 0o700 });
  fs.writeFileSync(path.join(seededDir, 'active', 'settings.toml'), '[mostro]\n', { mode: 0o600 });
  const seededUrl = await startPanel(seededDir);

  await step('summary: settings without a running daemon are not an open market', async () => {
    await page.goto(seededUrl, { waitUntil: 'networkidle' });
    await heading(page).filter({ hasText: 'Comunidad con órdenes' }).waitFor();
    await marketTitle(page).filter({ hasText: 'Mostro está activado, pero el nodo no se anuncia' }).waitFor();
    assert.equal(await page.getByText('Tu mercado está abierto').count(), 0);
    assert.equal(await page.locator('.market-pill', { hasText: 'Mercado abierto' }).count(), 0);
    // Out of the setup, the summary lists what needs attention instead of the steps.
    assert.equal(await page.locator('#setup').count(), 0);
    await page.locator('#attention').waitFor();
    await page.locator('.service-tile', { hasText: 'Relays' }).getByText('1 de 1 responden').waitFor({ timeout: 15000 });
    await shot(page, 'seeded-01-summary');
  });

  await step('summary: each activity figure opens the page that lists it', async () => {
    await page.locator('#activity .stat', { hasText: 'Ofertas publicadas' }).getByText('1', { exact: true }).waitFor({ timeout: 15000 });
    const targets = [
      ['Ofertas publicadas', '#/ordenes/pending', 'Publicadas'],
      ['En curso', '#/ordenes/in-progress', 'En curso'],
      ['Completadas', '#/ordenes/success', 'Completadas'],
      ['Canceladas', '#/ordenes/canceled', 'Canceladas'],
      ['Disputas abiertas', '#/disputas', null],
    ];
    for (const [label, hash, chip] of targets) {
      await navLink(page, 'Resumen').click();
      await page.locator('#activity .stat', { hasText: label }).click();
      await page.waitForFunction((expected) => window.location.hash === expected, hash);
      if (chip) await page.locator('.orders-filters .filter-chip.active', { hasText: new RegExp(`^${chip}`) }).waitFor();
      else await heading(page).filter({ hasText: 'Disputas' }).waitFor();
    }
  });

  await step('orders: the order of the relay is listed with its amounts', async () => {
    await page.goto(`${seededUrl}/#/ordenes/pending`, { waitUntil: 'networkidle' });
    const row = page.locator('.data-table tbody tr', { hasText: 'd3b07384' });
    await row.waitFor({ timeout: 15000 });
    await row.getByText('100 EUR').waitFor();
    await row.getByText(/250\s?000/).waitFor();
    await row.getByText('Publicada', { exact: true }).waitFor();
    await shot(page, 'seeded-02-orders');
  });

  await step('orders: the status filter lives in the address and the type filter narrows the list', async () => {
    await page.locator('.orders-filters .filter-chip', { hasText: 'En curso' }).click();
    await page.getByText('Ninguna orden con ese filtro').waitFor();
    assert.equal(currentHash(page), '#/ordenes/in-progress');
    // The menu entry always opens the whole book.
    await navLink(page, 'Órdenes').click();
    await page.locator('.data-table tbody tr', { hasText: 'd3b07384' }).waitFor();
    assert.equal(currentHash(page), '#/ordenes');
    await page.locator('.orders-filters .filter-chip.active', { hasText: /^Todas/ }).waitFor();
    const kind = page.locator('.orders-filters select');
    await kind.selectOption('buy');
    await page.getByText('Ninguna orden con ese filtro').waitFor();
    await kind.selectOption('sell');
    await page.locator('.data-table tbody tr', { hasText: 'd3b07384' }).waitFor();
  });

  await step('orders: the messages of an order open in the disputes page, and Back returns', async () => {
    await page.locator('.data-table tbody tr', { hasText: 'd3b07384' }).getByRole('button', { name: 'Mensajes' }).click();
    await heading(page).filter({ hasText: 'Disputas' }).waitFor();
    assert.equal(currentHash(page), '#/disputas/d3b07384-d113-4001-a111-a8e0f1112222');
    await page.goBack();
    await heading(page).filter({ hasText: 'Órdenes' }).waitFor();
  });

  await step('simulator: a trade is walked through with its amounts', async () => {
    await navLink(page, 'Simulador').click();
    await heading(page).filter({ hasText: 'Simulador de operaciones' }).waitFor();
    await page.getByRole('button', { name: 'Simular', exact: true }).click();
    await page.getByText(/Secuencia, paso a paso/).waitFor();
    // 50 000 sats at the seeded rules: 0,6 % in total, a 3 % bond for each side.
    const figures = (await page.locator('.sim-financials').textContent()).replace(/\s/g, ' ');
    for (const expected of ['50 000 sats', '300 sats', '1 500 sats', '50 150 sats', '49 850 sats']) {
      assert.ok(figures.includes(expected), `the simulator does not show ${expected}: ${figures}`);
    }
    await page.locator('.sim-complete-banner', { hasText: 'Termina completada' }).waitFor();
    await shot(page, 'seeded-03-simulator');
  });

  await step('lightning: without access the page says so and can show an example', async () => {
    await navLink(page, 'Lightning').click();
    await page.getByText('El panel no tiene acceso de lectura a LND').waitFor();
    await page.getByText('Sin datos de liquidez').waitFor();
    assert.equal(await page.locator('#lnd-channels .data-table').count(), 0);
    await page.getByRole('button', { name: 'Ejemplo', exact: true }).click();
    await page.getByText('Estás viendo un ejemplo').waitFor();
    await page.locator('#lnd-channels .data-table tbody tr').first().waitFor();
    await shot(page, 'seeded-04-lightning');
  });

  await step('every page opens from the menu with its own heading and address', async () => {
    for (const target of PAGES) {
      await navLink(page, target.nav).click();
      await page.waitForFunction((hash) => window.location.hash === hash || (hash === '#/' && window.location.hash === ''), target.hash);
      if (target.heading) await heading(page).filter({ hasText: target.heading }).waitFor();
      // The address changes first and the page follows on the next tick: wait for it instead of reading at once.
      await page.locator('.side-nav a.side-link[aria-current="page"]', { hasText: new RegExp(`^${target.nav}`) }).waitFor();
      await page.waitForFunction((label) => document.title.startsWith(label), target.nav);
    }
  });

  await step('a page chosen from the menu starts at the top with the keyboard in its content', async () => {
    await navLink(page, 'Configuración').click();
    await heading(page).filter({ hasText: 'Configuración' }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 1200));
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
    await navLink(page, 'Nodo Mostro').click();
    await heading(page).filter({ hasText: 'Nodo Mostro' }).waitFor();
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.waitForFunction(() => document.activeElement?.id === 'contenido');
    // The address is still a real link, so it can be opened in another tab.
    assert.equal(await navLink(page, 'Respaldos').getAttribute('href'), '#/respaldos');
  });

  await step('the skip link stays on the page it was used from', async () => {
    await page.goto(`${seededUrl}/#/configuracion`, { waitUntil: 'networkidle' });
    await heading(page).filter({ hasText: 'Configuración' }).waitFor();
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'contenido');
    assert.equal(currentHash(page), '#/configuracion');
    await heading(page).filter({ hasText: 'Configuración' }).waitFor();
  });

  await step('an unknown or malformed address does not leave a blank page', async () => {
    await page.goto(`${seededUrl}/#/no-existe`, { waitUntil: 'networkidle' });
    await marketTitle(page).waitFor();
    await page.locator('.side-nav a.side-link[aria-current="page"]', { hasText: /^Resumen/ }).waitFor();
    await page.goto(`${seededUrl}/#/ordenes/50%`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await heading(page).filter({ hasText: 'Órdenes' }).waitFor();
    // Only a real order id is sent to the server.
    const asked = [];
    const record = (request) => { if (request.url().includes('/api/chat/')) asked.push(request.url()); };
    page.on('request', record);
    await page.goto(`${seededUrl}/#/disputas/..%2Fnotifications%2Fsse`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('La dirección no lleva el identificador de una orden').waitFor();
    assert.deepEqual(asked, []);
    page.off('request', record);
  });

  await step('connection: rules the signed card cannot carry are named, not reported as missing', async () => {
    // Rules as an earlier version accepted them, and an identity created through the API.
    const earlierDir = tempDir('mostro-smoke-earlier-');
    const earlierConfig = { ...seededConfig, community: { ...seededConfig.community, name: 'Compra & venta' } };
    fs.writeFileSync(path.join(earlierDir, 'community.json'), JSON.stringify({ revision: 3, config: earlierConfig }, null, 2), { mode: 0o600 });
    const earlierUrl = await startPanel(earlierDir);
    const created = await page.request.post(`${earlierUrl}/api/identity/generate`, { headers: API_HEADERS, data: {} });
    assert.ok(created.ok(), 'the identity of the test node was not created');
    const card = await page.request.get(`${earlierUrl}/api/community/card`, { headers: API_HEADERS });
    assert.equal(card.status(), 409);
    const reason = (await card.json()).error;
    assert.match(reason, /El nombre de la comunidad no puede contener «&»/);
    assert.doesNotMatch(reason, /identidad|necesita reglas/);
    await page.goto(`${earlierUrl}/#/conexion`, { waitUntil: 'networkidle' });
    await heading(page).filter({ hasText: 'Conexión de apps' }).waitFor();
    await page.locator('.qr-box-wrapper').getByText('El nombre de la comunidad no puede contener «&»').waitFor();
    assert.equal(await page.getByText('guarda la configuración de la comunidad').count(), 0);
    // The identity alone can still be shared.
    await page.getByRole('button', { name: 'Identidad', exact: true }).click();
    await page.locator('.qr-box-wrapper svg').waitFor();
    await shot(page, 'earlier-01-connection');
  });

  // ------------------------------------------------------------------
  // C. States the mock relay cannot produce, with stubbed API answers.
  // ------------------------------------------------------------------
  const realDaemon = await (await page.request.get(`${seededUrl}/api/daemon/status`, { headers: API_HEADERS })).json();
  const stubDaemon = async (overrides) => {
    await page.unroute('**/api/daemon/status');
    if (overrides) await page.route('**/api/daemon/status', (route) => route.fulfill({ json: { ...realDaemon, notices: [], warnings: [], ...overrides } }));
  };
  const announcement = { event_id: 'e'.repeat(64), created_at: Math.floor(Date.now() / 1000) - 20, mostro_version: '0.19.2', protocol_version: '2', tags: { fee: '0.006', maintenance_mode: 'false' } };

  await step('market status: open needs a running daemon here and a recent announcement', async () => {
    const cases = [
      [{ state: 'active_running', announced_fresh: true, announced: announcement, announced_age_secs: 20, running_for_secs: 900 }, 'Tu mercado está abierto', 'Mercado abierto'],
      [{ state: 'active_running', announced_fresh: false, announced: null, announced_age_secs: null, running_for_secs: 60 }, 'El nodo está arrancando', 'Arrancando'],
      // Hours without an announcement is not "starting" any more.
      [{ state: 'active_running', announced_fresh: false, announced: null, announced_age_secs: null, running_for_secs: 7200 }, 'El daemon está en ejecución, pero el panel no ve su anuncio', 'Sin confirmar'],
      // Just deactivated, or another instance with this key: announced, but not served from here.
      [{ state: 'configured_standby', active_revision: null, announced_fresh: true, announced: announcement, announced_age_secs: 20 }, 'Mostro no está activado aquí, pero el nodo aún se anuncia', 'Anuncio vigente'],
      [{ state: 'active_running', announced_fresh: true, announced: { ...announcement, tags: { ...announcement.tags, maintenance_mode: 'true' } }, announced_age_secs: 20, running_for_secs: 900 }, 'El nodo está en mantenimiento', 'En mantenimiento'],
    ];
    for (const [overrides, title, pill] of cases) {
      await stubDaemon(overrides);
      await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await marketTitle(page).filter({ hasText: title }).waitFor();
      await page.locator('.market-pill', { hasText: pill }).waitFor();
      assert.equal(await page.locator('.market-pill', { hasText: 'Mercado abierto' }).count(), pill === 'Mercado abierto' ? 1 : 0);
    }
    await stubDaemon(null);
  });

  await step('after a restart, what the previous process announced does not open the market', async () => {
    // The report while the relays still hold the announcement of the daemon that ran before this one.
    await stubDaemon({
      state: 'active_running',
      running_for_secs: 12,
      announced: { ...announcement, created_at: Math.floor(Date.now() / 1000) - 200, mostro_version: '0.19.0' },
      announced_age_secs: 200,
      announced_fresh: false,
      announced_before_start: true,
      mostro_version: '0.19.2',
      version_source: 'binary',
    });
    await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await marketTitle(page).filter({ hasText: 'El nodo está arrancando' }).waitFor();
    await page.locator('.market-pill', { hasText: 'Arrancando' }).waitFor();
    await page.locator('.status-hero', { hasText: 'es anterior a este arranque' }).waitFor();
    assert.equal(await page.locator('.market-pill', { hasText: 'Mercado abierto' }).count(), 0);
    assert.equal(await page.getByText('El daemon anuncia otra versión').count(), 0);
    await shot(page, 'stub-01-restart-summary');
    // The node page tells that announcement apart from one that has simply expired.
    await navLink(page, 'Nodo Mostro').click();
    await page.locator('#node-state .fact', { hasText: 'Último anuncio en los relays' }).getByText('Anterior a este arranque').waitFor();
    await page.locator('#node-rules').getByText('Anuncio anterior al arranque').waitFor();
    await page.locator('#node-state .fact', { hasText: 'Versión de Mostro' }).getByText('v0.19.2').waitFor();
    assert.equal(await page.getByText('las apps pueden darlo por inactivo').count(), 0);
    await shot(page, 'stub-02-restart-node');
    await stubDaemon(null);
  });

  await step('an open market with a Lightning notice is not shown as all well', async () => {
    const open = { state: 'active_running', announced_fresh: true, announced: announcement, announced_age_secs: 20, running_for_secs: 900 };
    const show = async (code, text) => {
      await stubDaemon({ ...open, notices: [{ code, text }], warnings: [text] });
      await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
    };
    const mostroTile = page.locator('.service-tile', { has: page.locator('strong', { hasText: /^Mostro$/ }) });
    const cases = [
      ['lnd_no_channels', 'LND reporta 0 canales activos.', 'Tu mercado está abierto, pero Lightning no tiene canales activos'],
      ['lnd_not_synced', 'LND no está sincronizado con la cadena de bloques.', 'Tu mercado está abierto, pero LND no está sincronizado'],
      ['lnd_unreadable', 'El panel no pudo leer LND.', 'Tu mercado está abierto, pero el panel no puede leer Lightning'],
    ];
    for (const [code, text, title] of cases) {
      await show(code, text);
      await marketTitle(page).filter({ hasText: title }).waitFor();
      await page.locator('.market-pill.tone-warn', { hasText: 'Abierto con avisos' }).waitFor();
      await page.locator('.status-hero.tone-warn').waitFor();
      assert.equal(await page.locator('.market-pill', { hasText: 'Mercado abierto' }).count(), 0, code);
      // The daemon itself is doing its part: its tile says so, and Lightning has its own.
      await mostroTile.locator('.badge.tone-good', { hasText: 'En marcha' }).waitFor();
    }
    await shot(page, 'stub-03-open-with-notice');
    // The longer label still fits the top bar of a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.market-pill', { hasText: 'Abierto con avisos' }).waitFor();
    assert.equal(await hasOverflow(page), false, 'the summary overflows at 390 px with the longer label');
    await page.setViewportSize({ width: 1280, height: 900 });
    // A panel that was never given access to LND is how this install is set up, not something that broke.
    await show('lnd_unconfigured', 'El panel no tiene acceso de lectura a LND.');
    await marketTitle(page).filter({ hasText: /^Tu mercado está abierto$/ }).waitFor();
    await page.locator('.market-pill.tone-good', { hasText: 'Mercado abierto' }).waitFor();
    await stubDaemon(null);
  });

  await step('a notice goes to the page its code names, whatever its sentence says', async () => {
    await stubDaemon({
      state: 'active_ready',
      notices: [
        { code: 'daemon_crash_loop', text: 'El daemon terminó con código 1 a los 4 s de arrancar y se está reiniciando. Revisa los registros del contenedor mostro: suele deberse a LND, a los relays o a la configuración.' },
        { code: 'lnd_no_channels', text: 'LND reporta 0 canales activos.' },
        { code: 'un_codigo_nuevo', text: 'Un aviso que este panel aún no conoce.' },
      ],
    });
    await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const item = (title) => page.locator('#attention .attention-item', { hasText: title });
    await item('El daemon se reinicia en bucle').getByRole('button', { name: 'Ver el nodo' }).waitFor();
    await item('Lightning necesita atención').getByRole('button', { name: 'Ver Lightning' }).waitFor();
    await item('Aviso del nodo').getByRole('button', { name: 'Ver el nodo' }).waitFor();
    // The crash loop mentions LND in its sentence and is still not a Lightning notice.
    assert.equal(await item('Lightning necesita atención').getByText('terminó con código').count(), 0);
    await stubDaemon(null);
  });

  await step('an unexpected exit of the daemon reaches the summary, and the node page tells it once', async () => {
    const text = 'El daemon terminó de forma inesperada hace 10 min, con código 137 (señal 9) y tras 2 h en marcha. El supervisor lo volvió a arrancar. Revisa los registros del contenedor mostro para ver la causa.';
    await stubDaemon({
      state: 'active_running',
      running_for_secs: 590,
      announced_fresh: true,
      announced: announcement,
      announced_age_secs: 20,
      last_exit: { at_unix: Math.floor(Date.now() / 1000) - 600, code: 137, uptime_secs: 7200 },
      notices: [{ code: 'daemon_unexpected_exit', text }],
      warnings: [text],
    });
    await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const item = page.locator('#attention .attention-item', { hasText: 'El daemon terminó de forma inesperada' });
    await item.getByText('con código 137 (señal 9)').waitFor();
    await item.getByRole('button', { name: 'Ver el nodo' }).click();
    await heading(page).filter({ hasText: 'Nodo Mostro' }).waitFor();
    // A code above 128 is a signal, and the page says which, in the words the summary uses.
    await page.locator('.callout', { hasText: 'El daemon terminó de forma inesperada' }).getByText('Terminó con código 137 (señal 9) tras 2 h en marcha').waitFor();
    assert.equal(await page.getByText('Revisa los registros del contenedor mostro').count(), 0, 'the same exit is told twice on the node page');
    // Once Mostro is deactivated, a record left on disk is nobody's news.
    await stubDaemon({ state: 'configured_standby', active_revision: null, active_settings_hash: null, active_settings_path: null, last_exit: { at_unix: Math.floor(Date.now() / 1000) - 600, code: 143, uptime_secs: 60 } });
    await page.reload({ waitUntil: 'networkidle' });
    await heading(page).filter({ hasText: 'Nodo Mostro' }).waitFor();
    await page.locator('#node-state .fact', { hasText: 'Proceso del daemon' }).getByText('Mostro no está activado').waitFor();
    assert.equal(await page.getByText('de forma inesperada').count(), 0);
    await stubDaemon(null);
  });

  await step('a failed read is shown as unknown, not as nothing there', async () => {
    await page.route('**/api/daemon/status', (route) => route.fulfill({ status: 500, json: { error: 'fallo de prueba' } }));
    await page.route('**/api/connection', (route) => route.fulfill({ status: 500, json: { error: 'fallo de prueba' } }));
    await page.goto(`${seededUrl}/#/nodo`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('El panel no ha podido leer el estado del nodo').first().waitFor();
    // Not knowing whether there is an identity is no reason to offer a new one.
    assert.equal(await page.getByRole('button', { name: 'Crear una identidad nueva' }).count(), 0);
    await navLink(page, 'Resumen').click();
    await marketTitle(page).filter({ hasText: 'No hay datos del nodo' }).waitFor();
    assert.equal(await page.getByText('Todo en orden').count(), 0);
    await navLink(page, 'Conexión de apps').click();
    await page.getByText('No se pudo leer la conexión').waitFor();
    assert.equal(await page.getByText('Créala o impórtala primero').count(), 0);
    await page.unroute('**/api/daemon/status');
    await page.unroute('**/api/connection');
  });

  await step('saved rules that have not been read yet are not "no saved rules"', async () => {
    // The answer is held back first, and then it is an error: reading and not having been able to read are told apart.
    let answer;
    const held = new Promise((resolve) => { answer = resolve; });
    await page.route('**/api/community', async (route) => { await held; await route.fulfill({ status: 500, json: { error: 'fallo de prueba' } }); });
    await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'load' });
    await page.getByText('Leyendo las reglas guardadas…').waitFor();
    assert.equal(await page.getByText('Aún no hay reglas guardadas').count(), 0);
    answer();
    const unread = 'El panel no ha podido leer las reglas guardadas';
    await page.getByText(unread).waitFor();
    assert.equal(await page.getByText('Aún no hay reglas guardadas').count(), 0);
    await navLink(page, 'Nodo Mostro').click();
    await page.locator('#node-rules').getByText(unread).waitFor();
    assert.equal(await page.getByText('Aún no hay reglas guardadas').count(), 0);
    await navLink(page, 'Lightning').click();
    await page.getByRole('button', { name: 'Ejemplo', exact: true }).click();
    await page.locator('#lnd-liquidity .stat', { hasText: 'Para recibir depósitos' }).getByText(unread).waitFor();
    assert.equal(await page.getByText('Sin reglas guardadas').count(), 0);
    // During the setup, the daemon report already says that there are rules: the list does not ask for them again.
    await stubDaemon({ state: 'configured_standby', identity_present: true, npub: relay.npub, can_activate: true, draft_revision: 1, active_revision: null, active_settings_hash: null, active_settings_path: null });
    await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.setup-step.is-done', { hasText: 'Define las reglas de la comunidad' }).waitFor();
    await page.locator('.status-hero', { hasText: 'Siguiente paso: guarda un respaldo cifrado.' }).waitFor();
    await stubDaemon(null);
    await page.unroute('**/api/community');
  });

  await step('a monitor that is still reading the relays is not an empty order book', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Everything else in order, so that only the relays stand between the summary and "all is well".
    const realBackups = await (await page.request.get(`${seededUrl}/api/backup/status`, { headers: API_HEADERS })).json();
    await page.route('**/api/backup/status', (route) => route.fulfill({ json: { ...realBackups, last_error: null, backups: [{ filename: 'respaldo.age', path: '/respaldos/respaldo.age', size_bytes: 2048, modified_timestamp: now - 60 }] } }));
    await stubDaemon({ state: 'active_running', announced_fresh: true, announced: announcement, announced_age_secs: 20, running_for_secs: 900 });
    let served = null;
    await page.route('**/api/orders', (route) => route.fulfill({ json: served }));
    const serve = async (state) => {
      served = { state, is_stale: state !== 'live', last_update: now, source_npub: relay.npub, relays: [{ url: relay.url, state }], orders: [], disputes: [] };
      await page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await marketTitle(page).filter({ hasText: 'Tu mercado está abierto' }).waitFor();
    };
    for (const state of ['connecting', 'syncing']) {
      await serve(state);
      await page.locator('#activity').getByText('Leyendo las órdenes en los relays…').waitFor();
      assert.equal(await page.locator('#activity .stat').count(), 0, `${state}: figures shown before the relays were read`);
      await page.locator('#attention').getByText('Aún no se puede comprobar').waitFor();
      await page.locator('#attention').getByText('todavía no sabe si hay disputas abiertas').waitFor();
      assert.equal(await page.getByText('Todo en orden').count(), 0, state);
    }
    await shot(page, 'stub-04-relays-reading');
    // The pages that read the monitor themselves follow the same rule: no counts, and no "none open".
    await page.goto(`${seededUrl}/#/ordenes`, { waitUntil: 'networkidle' });
    await page.getByText('Leyendo los relays…').waitFor();
    await page.locator('.orders-filters .filter-chip', { hasText: 'Publicadas' }).waitFor();
    assert.equal(await page.locator('.orders-filters .filter-chip span').count(), 0, 'the filters count orders before the relays were read');
    await page.goto(`${seededUrl}/#/disputas`, { waitUntil: 'networkidle' });
    await page.locator('#disputes-list .badge', { hasText: 'Sin comprobar' }).waitFor();
    assert.equal(await page.getByText('Ninguna abierta').count(), 0);
    // No relay answers and nothing is in memory: that is not zero orders either.
    await serve('disconnected');
    await page.locator('#activity').getByText('Ningún relay responde ahora').waitFor();
    assert.equal(await page.locator('#activity .stat').count(), 0);
    assert.equal(await page.getByText('Todo en orden').count(), 0);
    // Once the relays have been read, an empty book is an empty book.
    await serve('live');
    await page.locator('#activity .stat', { hasText: 'Ofertas publicadas' }).getByText('0', { exact: true }).waitFor();
    await page.locator('#attention').getByText('Todo en orden').waitFor();
    await shot(page, 'stub-05-relays-read');
    await page.goto(`${seededUrl}/#/ordenes`, { waitUntil: 'networkidle' });
    await page.locator('.orders-filters .filter-chip', { hasText: 'Publicadas' }).locator('span', { hasText: /^0$/ }).waitFor();
    await page.goto(`${seededUrl}/#/disputas`, { waitUntil: 'networkidle' });
    await page.locator('#disputes-list .badge', { hasText: 'Ninguna abierta' }).waitFor();
    await stubDaemon(null);
    await page.unroute('**/api/orders');
    await page.unroute('**/api/backup/status');
  });

  await step('alerts: when the stream ends, the log is read again and the stream reopened', async () => {
    const now = Math.floor(Date.now() / 1000);
    const alert = (id, title) => ({ id, level: 'warning', category: 'relay', title, message: 'Mensaje de prueba.', timestamp: now });
    let log = [alert('relay-prueba-1', 'Primera alerta de prueba')];
    let streams = 0;
    // The browser retries a stream that drops, but not one the server answers with an error,
    // which is what the application does while it restarts.
    await page.route('**/api/notifications/sse', (route) => { streams += 1; return route.fulfill({ status: 503, body: '' }); });
    await page.route('**/api/notifications', (route) => route.fulfill({ json: log }));
    await page.goto(`${seededUrl}/#/alertas`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Primera alerta de prueba').waitFor();
    const opened = streams;
    assert.ok(opened >= 1, 'the alert stream was never opened');
    log = [alert('relay-prueba-2', 'Segunda alerta de prueba'), ...log];
    // The panel reads again every 20 s and whenever its tab comes back into view.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('Segunda alerta de prueba').waitFor();
    await page.getByText('Primera alerta de prueba').waitFor();
    for (let waited = 0; waited < 50 && streams === opened; waited += 1) await page.waitForTimeout(100);
    assert.ok(streams > opened, 'the alert stream was not opened again');
    await page.unroute('**/api/notifications/sse');
    await page.unroute('**/api/notifications');
  });

  await step('orders: an order without a readable amount is not an order of 0', async () => {
    const now = Math.floor(Date.now() / 1000);
    const order = { id: 'cccccccc-3333-4333-8333-cccccccccccc', event_id: 'c'.repeat(64), kind: 'sell', status: 'pending', fiat_code: 'EUR', fiat_amount_range: [], amount_sats: 0, amount_sats_str: '0', payment_methods: ['SEPA'], premium: 0, created_at: now - 60, expires_at: now + 3600, published_at: now - 60 };
    const snapshot = { state: 'live', is_stale: false, last_update: now, source_npub: relay.npub, relays: [{ url: relay.url, state: 'live' }], orders: [order], disputes: [] };
    await page.route('**/api/orders', (route) => route.fulfill({ json: snapshot }));
    await page.goto(`${seededUrl}/#/ordenes`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const row = page.locator('.data-table tbody tr', { hasText: 'cccccccc' });
    await row.getByText('Importe no legible · EUR').waitFor();
    assert.equal(await row.getByText(/^0 EUR$/).count(), 0);
    await page.unroute('**/api/orders');
  });

  await step('connection: with the switch on and no key to sign with, nothing is published and the panel says why', async () => {
    await assertOnlyTheMockRelay(seededUrl);
    const before = relay.published().length;
    await page.goto(`${seededUrl}/#/conexion`, { waitUntil: 'networkidle' });
    await publishSwitch().click();
    const callout = publishPanel().locator('.callout', { hasText: 'No se publica nada' });
    await callout.waitFor({ timeout: 15000 });
    await callout.getByText('El nodo no tiene identidad').waitFor();
    assert.equal(await publishSwitch().getAttribute('aria-checked'), 'true');
    const status = await publication(seededUrl);
    assert.equal(status.state, 'blocked');
    assert.equal(status.reason, 'no_identity');
    assert.deepEqual(status.relays, []);
    assert.equal(relay.published().length, before);
    // The summary sends the operator here, and from here to where it is fixed.
    await navLink(page, 'Resumen').click();
    await page.locator('#attention .attention-item', { hasText: 'La tarjeta de la comunidad no se puede publicar' }).getByRole('button', { name: 'Ver conexión' }).click();
    await heading(page).filter({ hasText: 'Conexión de apps' }).waitFor();
    await publishPanel().locator('.callout', { hasText: 'No se publica nada' }).getByRole('button', { name: 'Ir al nodo' }).click();
    await heading(page).filter({ hasText: 'Nodo Mostro' }).waitFor();
    await shot(page, 'seeded-04b-card-blocked');
  });

  await step('connection: a relay that refuses the card is shown as such, and none accepting is not "published"', async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = { enabled: true, working: false, reason: null, reason_text: null, event_id: 'c'.repeat(64), card_changed_at: now - 3600, withdrawn_at: null, last_attempt_at: now - 30, next_attempt_at: now + 240, resend_every_secs: 21600 };
    const taken = { url: 'wss://uno.example', outcome: 'accepted', detail: null, at: now - 30 };
    const refused = { url: 'wss://dos.example', outcome: 'rejected', detail: 'blocked: solo miembros', at: now - 30 };
    const silent = { url: 'wss://tres.example', outcome: 'no_answer', detail: 'El relay no respondió dentro del plazo', at: now - 30 };
    const stub = async (status) => {
      await page.unroute('**/api/community/card/publication');
      await page.route('**/api/community/card/publication', (route) => route.fulfill({ json: status }));
      await page.goto(`${seededUrl}/#/conexion`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
    };
    const row = (item) => publishPanel().locator('.publish-relays li', { hasText: item.url });

    await stub({ ...base, state: 'failed', relays: [refused, silent] });
    await publishPanel().locator('.callout', { hasText: 'La tarjeta no está publicada' }).getByRole('button', { name: 'Reintentar ahora' }).waitFor();
    await row(refused).locator('.badge', { hasText: 'La rechazó' }).waitFor();
    await row(refused).getByText('blocked: solo miembros').waitFor();
    await row(silent).locator('.badge', { hasText: 'Sin respuesta' }).waitFor();
    assert.equal(await publishPanel().getByText(/^Publicada/).count(), 0, 'a card no relay accepted is shown as published');
    await shot(page, 'seeded-04c-card-refused');
    await navLink(page, 'Resumen').click();
    await page.locator('#attention .attention-item', { hasText: 'La tarjeta de la comunidad no está publicada' }).getByRole('button', { name: 'Ver conexión' }).waitFor();
    await page.locator('.side-nav a.side-link', { hasText: /^Conexión de apps/ }).locator('.side-badge').waitFor();

    await stub({ ...base, state: 'partial', relays: [taken, refused], former_relays: ['wss://viejo.example'] });
    await publishPanel().locator('.callout', { hasText: 'Publicada en 1 de 2 relays' }).waitFor();
    await row(taken).locator('.badge', { hasText: 'La tiene' }).waitFor();
    // A relay taken out of the configuration may still serve an earlier card: the panel names it.
    await publishPanel().getByText(/pueden conservar una versión anterior de la tarjeta: wss:\/\/viejo\.example/).waitFor();
    await navLink(page, 'Resumen').click();
    await page.locator('#attention .attention-item', { hasText: 'Un relay no aceptó la tarjeta de la comunidad' }).waitFor();

    // A withdrawal that could not even be signed yet says why, and shows no relay as having deleted anything.
    const waiting = { url: 'wss://uno.example', outcome: 'pending', detail: null, at: now - 30 };
    await stub({ ...base, enabled: false, state: 'withdrawing', event_id: null, reason: 'identity_unreadable', reason_text: 'No se pudo leer la clave del nodo para firmar la petición de borrado.', relays: [waiting] });
    await publishPanel().locator('.callout', { hasText: 'La tarjeta aún no se ha podido retirar' }).getByText('No se pudo leer la clave del nodo').waitFor();
    await row(waiting).locator('.badge', { hasText: 'Pendiente' }).waitFor();
    assert.equal(await publishPanel().getByText('Borrado aceptado').count(), 0);

    // While the server is still talking to the relays, the last result is not shown as current.
    await stub({ ...base, working: true, state: 'published', relays: [taken] });
    await publishPanel().locator('.callout', { hasText: 'Hablando con los relays' }).waitFor();
    assert.equal(await publishPanel().locator('.publish-relays').count(), 0);
    await page.unroute('**/api/community/card/publication');
  });

  await step('disputes: after Back the guide never pairs a dispute with another order', async () => {
    const orderA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const orderB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const now = Math.floor(Date.now() / 1000);
    const dispute = (id, orderId) => ({ id, event_id: id.replace(/-/g, '').padEnd(64, '0'), status: 'initiated', initiator: 'buyer', published_at: now - 600, updated_at: now - 600, is_open: true, order_id: orderId });
    const disputeA = dispute('d1d1d1d1-aaaa-4aaa-8aaa-d1d1d1d1d1d1', orderA);
    const disputeB = dispute('d2d2d2d2-bbbb-4bbb-8bbb-d2d2d2d2d2d2', orderB);
    const loose = dispute('d3d3d3d3-cccc-4ccc-8ccc-d3d3d3d3d3d3', null);
    const order = (id) => ({ id, event_id: id.replace(/-/g, '').padEnd(64, '0'), kind: 'sell', status: 'in-progress', fiat_code: 'EUR', fiat_amount_range: ['50'], amount_sats: 60000, amount_sats_str: '60000', payment_methods: ['cash'], premium: 0, created_at: now - 900, expires_at: now + 3600, published_at: now - 900 });
    const snapshot = { state: 'live', is_stale: false, last_update: now, source_npub: relay.npub, relays: [{ url: relay.url, state: 'live' }], orders: [order(orderA), order(orderB)], disputes: [disputeA, disputeB, loose] };
    await page.route('**/api/disputes', (route) => route.fulfill({ json: [disputeA, disputeB, loose] }));
    await page.route('**/api/orders', (route) => route.fulfill({ json: snapshot }));
    await page.route('**/api/chat/*', (route) => route.fulfill({ json: { order_id: decodeURIComponent(route.request().url().split('/api/chat/')[1]), messages: [], count: 0, dispute_id: null } }));

    await page.goto(`${seededUrl}/#/disputas`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const row = (item) => page.locator('.mediation-page .data-table tbody tr', { hasText: item.id.slice(0, 8) });
    const guide = page.locator('.dispute-card');
    const shows = async (item, orderId) => {
      await page.waitForFunction((expected) => window.location.hash === expected, `#/disputas/${orderId || `disputa-${item.id}`}`);
      await guide.getByText(`admtakedispute -d ${item.id}`).waitFor();
      const text = (await guide.locator('code').allTextContents()).join('\n');
      assert.ok(text.includes(`admsettle -o ${orderId || '<id-de-la-orden>'}`), text);
      assert.ok(text.includes(`admcancel -o ${orderId || '<id-de-la-orden>'}`), text);
      for (const other of [disputeA, disputeB, loose]) if (other !== item) assert.ok(!text.includes(other.id), `the guide mixes in ${other.id}: ${text}`);
      for (const other of [orderA, orderB]) if (other !== orderId) assert.ok(!text.includes(other), `the guide mixes in order ${other}: ${text}`);
    };

    await row(disputeA).click();
    await shows(disputeA, orderA);
    await row(disputeB).click();
    await shows(disputeB, orderB);
    await page.goBack();
    await shows(disputeA, orderA);
    await page.goForward();
    await shows(disputeB, orderB);
    // A dispute the panel cannot tie to an order is addressed by its own id and names no order. Back restores the pair it came from.
    await row(loose).click();
    await shows(loose, null);
    await page.goBack();
    await shows(disputeB, orderB);
    // When the panel learns the order of such a dispute, its address moves on to the order without a stop on the way back.
    await row(loose).click();
    await shows(loose, null);
    await page.unroute('**/api/disputes');
    await page.route('**/api/disputes', (route) => route.fulfill({ json: [disputeA, disputeB, { ...loose, order_id: orderA }] }));
    await page.waitForFunction((expected) => window.location.hash === expected, `#/disputas/${orderA}`, { timeout: 20000 });
    await page.goBack();
    await page.waitForFunction((expected) => window.location.hash === expected, `#/disputas/${orderB}`);
    await page.unroute('**/api/disputes');
    await page.route('**/api/disputes', (route) => route.fulfill({ json: [disputeA, disputeB, loose] }));
    await page.reload({ waitUntil: 'networkidle' });
    await shows(disputeB, orderB);

    // The menu entry opens the page with nothing selected, also after a dispute without an order.
    await row(loose).click();
    await shows(loose, null);
    await navLink(page, 'Disputas').click();
    await page.waitForFunction(() => window.location.hash === '#/disputas');
    await guide.getByText('admtakedispute -d <id-de-la-disputa>').waitFor();
    await guide.getByText('admsettle -o <id-de-la-orden>').waitFor();
    await shot(page, 'seeded-05-disputes');

    // With work the relays report, stopping the daemon says so before asking.
    await navLink(page, 'Nodo Mostro').click();
    dialogs.answer = false;
    dialogs.seen.length = 0;
    await page.getByRole('button', { name: 'Desactivar Mostro' }).click();
    assert.equal(dialogs.seen.length, 1);
    assert.match(dialogs.seen[0], /2 órdenes en curso y 3 disputas abiertas/);
    dialogs.answer = true;
    await page.unroute('**/api/disputes');
    await page.unroute('**/api/orders');
    await page.unroute('**/api/chat/*');
  });

  // ------------------------------------------------------------------
  // D. A phone: nothing wider than the screen, and the menu as a drawer.
  // ------------------------------------------------------------------
  const phone = await openPage({ width: 390, height: 844 });
  for (const [label, baseUrl] of [['seeded', seededUrl], ['fresh', freshUrl]]) {
    await step(`phone, ${label} node: a reload keeps the page and none is wider than the screen`, async () => {
      for (const target of PAGES) {
        await phone.page.goto(`${baseUrl}/${target.hash}`, { waitUntil: 'networkidle' });
        await phone.page.reload({ waitUntil: 'networkidle' });
        if (target.heading) await heading(phone.page).filter({ hasText: target.heading }).waitFor();
        else await marketTitle(phone.page).waitFor();
        assert.equal(currentHash(phone.page), target.hash);
        assert.equal(await hasOverflow(phone.page), false, `${target.nav} overflows horizontally at 390 px`);
        await shot(phone.page, `phone-${label}-${target.hash.replace(/[^a-z]/g, '') || 'resumen'}`);
      }
    });
  }

  await step('phone: the menu is a drawer that takes the keyboard and closes on Escape or a choice', async () => {
    await phone.page.goto(`${seededUrl}/#/`, { waitUntil: 'networkidle' });
    const drawer = phone.page.locator('.shell');
    const closed = () => drawer.evaluate((el) => !el.classList.contains('menu-open'));
    assert.equal(await closed(), true);
    // Closed, the drawer is out of the keyboard's way.
    assert.equal(await navLink(phone.page, 'Órdenes').isVisible(), false);
    await phone.page.getByRole('button', { name: 'Abrir el menú' }).click();
    assert.equal(await closed(), false);
    assert.ok(await phone.page.evaluate(() => Boolean(document.activeElement?.closest('.side'))), 'focus did not move into the drawer');
    await phone.page.keyboard.press('Escape');
    assert.equal(await closed(), true);
    assert.equal(await phone.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Abrir el menú');
    await phone.page.getByRole('button', { name: 'Abrir el menú' }).click();
    await navLink(phone.page, 'Órdenes').click();
    await heading(phone.page).filter({ hasText: 'Órdenes' }).waitFor();
    assert.equal(await closed(), true);
    // Choosing the page that is already open closes the drawer as well, from any link of the menu.
    await phone.page.getByRole('button', { name: 'Abrir el menú' }).click();
    await navLink(phone.page, 'Órdenes').click();
    assert.equal(await closed(), true);
    await phone.page.goto(`${seededUrl}/#/nodo`, { waitUntil: 'networkidle' });
    await phone.page.getByRole('button', { name: 'Abrir el menú' }).click();
    await phone.page.locator('.side-status').click();
    assert.equal(await closed(), true);
  });

  assert.deepEqual(errors, [], `Errors in the browser console:\n${errors.join('\n')}`);
  await browser.close();
  console.log(`\nPASS: ${stepNumber} steps, no console errors.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('\nFAIL:', error);
    process.exit(1);
  },
);
