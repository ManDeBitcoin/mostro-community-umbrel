#!/usr/bin/env node
const { chromium } = require('/tmp/mostro-browser-check/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHROME_PATH = '/home/umbrel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

async function main() {
  console.log('=== Starting Playwright End-to-End Smoke Verification ===');

  // 1. Setup isolated temporary directory
  const tempConfigDir = fs.mkdtempSync('/tmp/mostro-pw-e2e-');
  fs.chmodSync(tempConfigDir, 0o700);
  console.log(`[Setup] Config dir: ${tempConfigDir}`);

  let mockRelayProc = null;
  let apiProc = null;

  function cleanup() {
    console.log('[Cleanup] Terminating temporary processes...');
    if (mockRelayProc) {
      try { mockRelayProc.kill('SIGTERM'); } catch (_) {}
    }
    if (apiProc) {
      try { apiProc.kill('SIGTERM'); } catch (_) {}
    }
    try {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    } catch (_) {}
  }
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });

  // 2. Start mock relay
  console.log('[1/6] Launching local mock relay...');
  mockRelayProc = spawn(`${REPO_ROOT}/target/debug/mostro-community-api`, ['mock-relay', '127.0.0.1:0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const relayInfo = await new Promise((resolve, reject) => {
    let buf = '';
    mockRelayProc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const match = buf.match(/MOCK_RELAY_READY npub=(\S+) url=(\S+)\r?\n/);
      if (match) {
        resolve({ npub: match[1], url: match[2] });
      }
    });
    mockRelayProc.on('error', reject);
    setTimeout(() => reject(new Error('Timeout waiting for mock relay to be ready')), 10000);
  });

  console.log(`✓ Mock relay ready at ${relayInfo.url} with npub: ${relayInfo.npub}`);

  // 3. Write initial community config & public identity sidecar
  const identityDir = path.join(tempConfigDir, 'identity');
  fs.mkdirSync(identityDir, { mode: 0o700 });
  const pubPath = path.join(identityDir, 'mostro.pub');
  fs.writeFileSync(pubPath, relayInfo.npub + '\n', { mode: 0o600 });

  // Start with unreachable relay so we can observe the empty/disconnected state first
  const initialConfig = {
    revision: 1,
    config: {
      community: {
        name: 'Comunidad Playwright E2E',
        about: 'Pruebas E2E de monitor y simulación',
        website: 'https://test.community',
        contact: 'https://t.me/test',
        language: 'es'
      },
      market: {
        fiat_currencies: ['EUR', 'USD'],
        min_trade_sats: 1000,
        max_trade_sats: 1000000,
        fee_bps: 60,
        dev_fee_bps: 0,
        max_routing_fee_bps: 10
      },
      safety: {
        bond_enabled: true,
        bond_bps: 300,
        base_bond_sats: 1000,
        bond_apply_to: 'both',
        automatic_timeout_slash: true,
        pow: 0,
        pow_first_contact: 0
      },
      nostr: {
        relays: ['ws://127.0.0.1:59999'] // Initially disconnected
      },
      payment_methods: [
        {
          id: 'cash_test',
          label: 'Efectivo',
          category: 'cash',
          active: true
        }
      ]
    }
  };

  const configPath = path.join(tempConfigDir, 'community.json');
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), { mode: 0o600 });

  // A prepared configuration must not make the UI claim a live market.
  const activeDir = path.join(tempConfigDir, 'active');
  fs.mkdirSync(activeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(activeDir, 'settings.toml'), '[mostro]\n', { mode: 0o600 });

  // 4. Start API server serving built static UI and API on ephemeral port
  console.log('[2/6] Launching Community API + UI server...');
  apiProc = spawn(`${REPO_ROOT}/target/debug/mostro-community-api`, [], {
    env: {
      ...process.env,
      CONFIG_DIR: tempConfigDir,
      API_BIND: '127.0.0.1:0',
      STATIC_DIR: `${REPO_ROOT}/web/dist`,
      MOSTRO_PUBLIC_KEY: relayInfo.npub,
      RUST_LOG: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const apiBaseUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      const str = chunk.toString();
      buf += str;
      const match = buf.match(/Community API listening on ([0-9.:]+)\r?\n/);
      if (match) {
        resolve(`http://${match[1]}`);
      }
    };
    apiProc.stdout.on('data', onData);
    apiProc.stderr.on('data', onData);
    apiProc.on('exit', (code, sig) => {
      reject(new Error(`API process exited unexpectedly with code ${code} and sig ${sig}. Output: ${buf}`));
    });
    apiProc.on('error', reject);
    setTimeout(() => reject(new Error(`Timeout waiting for API server to bind. Output: ${buf}`)), 10000);
  });

  console.log(`✓ Community API listening at ${apiBaseUrl}`);

  // 5. Launch Playwright Chromium
  console.log('[3/6] Launching Playwright browser...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on('pageerror', err => {
    console.error('Browser PageError:', err.message);
    errors.push(`PageError: ${err.message}`);
  });
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      if (txt.includes('favicon') || txt.includes('Failed to load resource') || txt.includes('script-src')) {
        return;
      }
      console.error('Browser Console Error:', txt);
      errors.push(`ConsoleError: ${txt}`);
    }
  });

  // Navigate to Dashboard
  console.log('[4/6] Navigating to Dashboard & testing Simulation (TypeError check)...');
  await page.goto(apiBaseUrl, { waitUntil: 'networkidle' });
  await page.getByText('Comunidad Playwright E2E').waitFor();

  await page.getByText('MERCADO SIN VERIFICAR', { exact: true }).waitFor();
  await page.getByText('Ejecución sin verificar', { exact: true }).waitFor();
  assert.equal(await page.getByText('MERCADO ACTIVO', { exact: true }).count(), 0);
  await page.getByText('Cómo resolver «Invalid parameters»', { exact: true }).click();
  await page.getByText('Importe fijo:', { exact: true }).waitFor();
  await page.getByText('Precio de mercado:', { exact: true }).waitFor();
  console.log('✓ Prepared settings stay unverified; Mostrix order guidance is available.');

  // Test Quick Simulation in Dashboard
  const runSimButton = page.getByRole('button', { name: 'Ejecutar Simulación' }).first();
  await runSimButton.waitFor();
  await runSimButton.click();

  // Verify financial results in Dashboard render without TypeError
  await page.getByText('Comisión Mostro').first().waitFor();
  await page.getByText('Fianza Vendedor').first().waitFor();
  await page.getByText('Fianza Comprador').first().waitFor();
  console.log('✓ Quick Simulation card rendered successfully without TypeError.');

  // Navigate to Simulation Tab
  await page.getByRole('button', { name: 'Simulador P2P' }).click();
  await page.getByRole('heading', { name: 'Simulador Sintético de Protocolo P2P' }).waitFor();

  // Execute simulation in dedicated tab
  const execSimBtn = page.getByRole('button', { name: 'Ejecutar Simulación' }).first();
  await execSimBtn.click();
  await page.getByText('Bloqueado Vendedor').waitFor();
  await page.getByText('Bloqueado Comprador').waitFor();
  await page.getByText('Secuencia Simulada de Pasos').waitFor();
  console.log('✓ Full Simulation tab executed and rendered all steps without error.');

  // 6. Test Orders Monitor tab - Stage A: Empty/Disconnected State
  console.log('[5/6] Testing Orders Monitor - Stage A: Empty state with disconnected relay...');
  await page.getByRole('button', { name: 'Órdenes públicas' }).click();
  await page.getByRole('heading', { name: 'Órdenes públicas' }).waitFor();

  // Verify empty state hint
  await page.getByText('No se encontraron órdenes publicadas para este autor.').waitFor();
  console.log('✓ Correctly displayed empty orders state.');

  // 7. Update community configuration to add the local mock relay
  console.log('[6/6] Updating configuration with local mock relay & testing live order feed...');
  const updatedConfig = {
    ...initialConfig.config,
    nostr: {
      relays: [relayInfo.url]
    }
  };

  // Update via API PUT
  const updateResp = await fetch(`${apiBaseUrl}/api/community`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'mostro-community',
      'origin': apiBaseUrl,
    },
    body: JSON.stringify({
      revision: 1,
      config: updatedConfig,
    }),
  });
  assert.equal(updateResp.status, 200, await updateResp.text());
  console.log('✓ Configuration updated with mock relay.');

  // Wait for monitor worker to sync and UI poll (interval: 3s) to pick up the order
  await page.waitForTimeout(4000);

  // Verify order table appears
  await page.getByText('d3b07384').waitFor({ timeout: 10000 });
  await page.getByText(/250,?000 sats/).waitFor();
  await page.getByText('100 EUR').waitFor();
  await page.getByText('pending').first().waitFor();
  console.log('✓ Live order event from local relay rendered with exact sats, fiat, and status!');

  // Test Filters
  const kindFilter = page.locator('.sim-control-group select').first();
  await kindFilter.selectOption('buy');
  await page.getByText('No hay órdenes que coincidan con los filtros seleccionados.').waitFor();
  console.log('✓ Empty filter state verified when selecting Compras.');

  await kindFilter.selectOption('sell');
  await page.getByText('d3b07384').waitFor();
  console.log('✓ Order row reappears when selecting Ventas.');

  // Test Mobile Viewport (390px x 844px)
  console.log('[Responsive] Testing mobile viewport at 390px width...');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);

  const isOverflowing = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth;
  });
  assert.equal(isOverflowing, false, 'Page horizontally overflows on mobile viewport');

  await page.screenshot({ path: '/tmp/mostro-orders-mobile.png', fullPage: true });
  console.log('✓ Mobile viewport verified without horizontal overflow.');

  // Verify no JavaScript errors occurred during entire test
  assert.deepEqual(errors, [], `JavaScript errors detected during session: ${errors.join(', ')}`);

  await browser.close();
  cleanup();
  console.log('\n=== PLAYWRIGHT PASS: All UI flows, calculations, local relay orders, and mobile layouts verified with 0 errors! ===');
}

main().catch(err => {
  console.error('\n❌ PLAYWRIGHT TEST FAILED:', err);
  process.exit(1);
});
