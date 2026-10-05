import { useState } from 'react';
import type { PanelData } from '../hooks/usePanelData';
import type { Navigate } from '../lib/navigation';
import { copyToClipboard } from '../lib/api';
import { Icon } from '../components/ui';
import { CopyField, EmptyState, LinkButton, PageHeader, Panel } from '../components/layout';

type QrFormat = 'card' | 'uri' | 'json';

const GUIDE_URL = 'https://github.com/ManDeBitcoin/mostro-community-umbrel/blob/main/docs/INTEGRACION-APPS.md';

const FORMATS: { id: QrFormat; label: string; caption: string }[] = [
  { id: 'card', label: 'Tarjeta', caption: 'La tarjeta de la comunidad firmada por el nodo: nombre, relays, moneda y métodos de pago. Es la opción recomendada.' },
  { id: 'uri', label: 'Identidad', caption: 'La clave pública y los relays (nprofile). La app no recibe moneda ni métodos de pago.' },
  { id: 'json', label: 'JSON', caption: 'La misma tarjeta firmada, como texto JSON para copiar y pegar.' },
];

export function ConnectPage({ data, navigate }: { data: PanelData; navigate: Navigate }) {
  const { connection, settled } = data;
  const [qrFormat, setQrFormat] = useState<QrFormat>('card');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const copy = (text: string, label: string) =>
    copyToClipboard(text, () => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    });

  const ready = connection?.status === 'ready';
  const format = FORMATS.find((item) => item.id === qrFormat) ?? FORMATS[0];
  const svg = !connection ? null : qrFormat === 'card' ? connection.qr_card_svg : qrFormat === 'uri' ? connection.qr_svg : connection.qr_json_svg;
  const link = !connection ? null : qrFormat === 'card' ? connection.card_uri : qrFormat === 'uri' ? connection.nostr_uri : connection.json_uri;
  const linkLabel = qrFormat === 'card' ? 'Enlace de la tarjeta firmada' : qrFormat === 'uri' ? 'Enlace con la identidad y los relays' : 'Tarjeta firmada en JSON';

  return (
    <section className="content connect-page">
      <PageHeader
        group="Nodo"
        title="Conexión de apps"
        description="Lo que una app necesita para operar con tu comunidad: la clave pública del nodo y sus relays."
        actions={
          connection?.app_download_url ? (
            <a href={connection.app_download_url} target="_blank" rel="noreferrer" className="button button-secondary">
              Mostro App <Icon name="external" size={14} />
            </a>
          ) : undefined
        }
      />

      {!ready ? (
        <Panel>
          {connection ? (
            <EmptyState icon="qr" title="Aún no hay nada que compartir" action={<LinkButton onClick={() => navigate('node')}>Ir al nodo</LinkButton>}>
              La conexión se genera a partir de la identidad del nodo. Créala o impórtala primero.
            </EmptyState>
          ) : (
            // Not read yet, or not readable: neither means the node has no identity.
            <EmptyState icon="qr" title={settled ? 'No se pudo leer la conexión' : 'Consultando…'}>
              {settled ? 'El panel no ha recibido los datos de conexión de su servidor. Lo vuelve a intentar solo.' : 'Leyendo la identidad del nodo.'}
            </EmptyState>
          )}
        </Panel>
      ) : (
        <Panel id="connect-share" title="Compartir con una app" description="Muestra el código para escanearlo o copia el enlace. La tarjeta lleva la comisión y el porcentaje de garantía como referencia; los valores vigentes y los límites los lee la app del propio nodo. Si cambias la comisión o la garantía, vuelve a compartirla.">
          <div className="connection-body">
            <div className="connection-qr-pane">
              <div className="qr-toggle-group" role="group" aria-label="Formato del código">
                {FORMATS.map((item) => (
                  <button key={item.id} type="button" aria-pressed={qrFormat === item.id} className={`qr-toggle-btn ${qrFormat === item.id ? 'active' : ''}`} onClick={() => setQrFormat(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="qr-box-wrapper">
                {svg ? (
                  <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} title="Código QR de conexión" />
                ) : (
                  <span className="empty-hint">Sin tarjeta: guarda la configuración de la comunidad. El nombre, la web y el contacto no pueden contener «&», ni los relays y métodos de pago «&» o «,».</span>
                )}
              </div>
              <span className="qr-hint-caption">{format.caption}</span>
            </div>

            <div className="connection-details">
              {link && <CopyField label={linkLabel} value={link} copied={copiedField === 'link'} onCopy={() => copy(link, 'link')} />}
              <CopyField label="Clave pública del nodo (npub)" value={connection.npub || ''} copied={copiedField === 'npub'} onCopy={() => copy(connection.npub || '', 'npub')} />
              <CopyField label="La misma clave en hexadecimal" value={connection.pubkey_hex || ''} copied={copiedField === 'hex'} onCopy={() => copy(connection.pubkey_hex || '', 'hex')} />
              <div className="connection-relays-row">
                <span className="field-label">Relays</span>
                {connection.relays.length > 0 ? (
                  <div className="chips">
                    {connection.relays.map((relay) => (
                      <span key={relay} className="chip">{relay}</span>
                    ))}
                  </div>
                ) : (
                  <span className="empty-hint">Sin relays guardados. Añádelos en Configuración.</span>
                )}
              </div>
            </div>
          </div>
        </Panel>
      )}

      <Panel id="connect-how" title="Cómo se conecta una app" description="El panel no habla con las apps. Todo pasa por los relays de Nostr.">
        <ol className="step-list">
          <li>
            <strong>La app recibe la clave del nodo y sus relays.</strong>
            <span>Con el código, el enlace o pegando la clave a mano.</span>
          </li>
          <li>
            <strong>Lee en los relays lo que el nodo anuncia.</strong>
            <span>Versión, comisión, límites, monedas y garantía. Puedes ver lo mismo en la página del nodo.</span>
          </li>
          <li>
            <strong>Publica y toma órdenes con mensajes cifrados al nodo.</strong>
            <span>El nodo responde por los mismos relays. Si app y nodo no comparten ninguno, no se ven.</span>
          </li>
        </ol>
        <p className="panel-note">
          <LinkButton onClick={() => navigate('node')}>Ver lo que anuncia el nodo</LinkButton>
        </p>
      </Panel>

      <Panel id="connect-rules" title="Reglas para crear órdenes" description="Valen para cualquier app. Si una orden se rechaza, casi siempre es por una de estas.">
        <p className="panel-note">Una orden lleva un importe fijo en sats o un precio de mercado con prima, nunca ambos. Mostro rechaza la combinación con «invalid_parameters».</p>
        <details className="help-details">
          <summary>Cómo resolver «Invalid parameters» o «prima no válida»</summary>
          <ul>
            <li><strong>Precio de mercado:</strong> Amount = 0, Fiat = 5 USD y Premium = 10 para +10 %. Mostro calcula los sats con su cotización cuando alguien toma la orden.</li>
            <li><strong>Importe fijo:</strong> Amount = 10000, Fiat = 5 USD y Premium = 0.</li>
            <li><strong>Rango:</strong> mínimo y máximo en fiat, Amount = 0 y Fiat = 0. La prima es opcional.</li>
          </ul>
          <p>El importe fiat y la prima son números enteros. Los sats resultantes deben estar entre el mínimo y el máximo del nodo y la moneda debe estar admitida. La prima de una orden no es la comisión del nodo.</p>
          <p>Si una app envía los sats estimados junto con una prima, el fallo está en la app: debe enviar Amount = 0.</p>
          <p>Si la app muestra otra versión o límites distintos de los configurados aquí, compara la clave pública y los relays, y revisa el anuncio en la página del nodo.</p>
        </details>
        <p className="panel-note">
          Para quien desarrolla una app:{' '}
          <a className="text-link" href={GUIDE_URL} target="_blank" rel="noreferrer">
            guía técnica de integración <Icon name="external" size={12} />
          </a>
        </p>
      </Panel>
    </section>
  );
}
