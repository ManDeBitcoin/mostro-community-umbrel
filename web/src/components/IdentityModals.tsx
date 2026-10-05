import { useRef } from 'react';
import type { Identity } from '../hooks/useIdentity';
import { useDialogFocus } from '../hooks/useDialogFocus';

/**
 * The two dialogs of the node identity: the one-time view of a freshly
 * generated key, and the form to import an existing one.
 */
export function IdentityModals({ identity, onContinue }: { identity: Identity; onContinue: () => void }) {
  return (
    <>
      {identity.generatedIdentity && <NewKeyDialog identity={identity} generated={identity.generatedIdentity} onContinue={onContinue} />}
      {identity.isImportModalOpen && <ImportKeyDialog identity={identity} />}
    </>
  );
}

function NewKeyDialog({ identity, generated, onContinue }: { identity: Identity; generated: { nsec: string; npub: string }; onContinue: () => void }) {
  const { setGeneratedIdentity, hasBackedUpNsec, setHasBackedUpNsec, copiedField, copyText } = identity;
  const dialog = useRef<HTMLDivElement>(null);
  // Closing is the only way to lose the key for good, so it asks first.
  const close = () => {
    if (hasBackedUpNsec || window.confirm('¿Cerrar sin guardar la clave privada?\n\nEl panel no volverá a mostrarla.')) setGeneratedIdentity(null);
  };
  useDialogFocus(dialog, true, close);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="custody-title" ref={dialog}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3 id="custody-title">Guarda la clave privada de tu nodo</h3>
          <button type="button" className="modal-close-btn" aria-label="Cerrar" onClick={close}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="security-warning-box">
            <strong>Es la única vez que la verás</strong>
            Esta clave es la identidad de tu comunidad: quien la tenga puede hacerse pasar por tu nodo. Cópiala ahora y guárdala en un gestor de contraseñas. El panel no vuelve a mostrarla.
          </div>

          <div className="key-display-group">
            <label>Clave privada (nsec). Secreta</label>
            <div className="copy-box">
              <code style={{ color: '#ffd993', fontWeight: 600 }}>{generated.nsec}</code>
              <button type="button" className="copy-button" data-autofocus onClick={() => copyText(generated.nsec, 'modal_nsec')}>
                {copiedField === 'modal_nsec' ? 'Copiado ✓' : 'Copiar nsec'}
              </button>
            </div>
          </div>

          <div className="key-display-group">
            <label>Clave pública (npub). Se puede compartir</label>
            <div className="copy-box">
              <code>{generated.npub}</code>
              <button type="button" className="copy-button" onClick={() => copyText(generated.npub, 'modal_npub')}>
                {copiedField === 'modal_npub' ? 'Copiado ✓' : 'Copiar npub'}
              </button>
            </div>
          </div>

          <label className="custody-checklist">
            <input type="checkbox" checked={hasBackedUpNsec} onChange={(e) => setHasBackedUpNsec(e.target.checked)} />
            <span>He copiado la clave privada y la he guardado en un lugar seguro.</span>
          </label>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button button-primary"
            disabled={!hasBackedUpNsec}
            onClick={() => {
              setGeneratedIdentity(null);
              onContinue();
            }}
          >
            Continuar con la configuración
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportKeyDialog({ identity }: { identity: Identity }) {
  const { importNsec, setImportNsec, showImportNsec, setShowImportNsec, importError, isImporting, closeImport, handleImportIdentity } = identity;
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, true, () => {
    if (!isImporting) closeImport();
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-title" ref={dialog}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3 id="import-title">Usar una clave que ya tienes</h3>
          <button type="button" className="modal-close-btn" aria-label="Cerrar" onClick={closeImport}>
            ✕
          </button>
        </div>
        <form onSubmit={handleImportIdentity}>
          <div className="modal-body">
            <p style={{ margin: 0, fontSize: '13.5px', color: '#a3b4ab', lineHeight: 1.5 }}>
              Pega la clave privada de la identidad Nostr que quieres para tu nodo. Empieza por <code>nsec1</code>. Se guarda solo en este equipo y el panel no vuelve a mostrarla.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="import-nsec">Clave privada (nsec)</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="import-nsec"
                  data-autofocus
                  type={showImportNsec ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={importNsec}
                  onChange={(e) => setImportNsec(e.target.value)}
                  placeholder="nsec1…"
                  required
                  style={{ paddingRight: '80px', fontFamily: 'monospace' }}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ position: 'absolute', right: '4px', top: '4px', height: '30px', padding: '0 8px', fontSize: '11px' }}
                  aria-pressed={showImportNsec}
                  onClick={() => setShowImportNsec(!showImportNsec)}
                >
                  {showImportNsec ? 'Ocultar' : 'Ver'}
                </button>
              </div>
            </div>
            {importError && (
              <div className="form-message error" role="alert" style={{ margin: 0 }}>
                {importError}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="button button-secondary" onClick={closeImport} disabled={isImporting}>
              Cancelar
            </button>
            <button type="submit" className="button button-primary" disabled={isImporting || !importNsec.trim()}>
              {isImporting ? 'Comprobando…' : 'Importar la clave'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
