import { useEffect, useState } from 'react';
import { api, copyToClipboard } from '../lib/api';

/**
 * Creating or importing the node's Nostr identity. The private key is shown
 * once, right after it is generated, and is never read back from the server.
 */
export function useIdentity({ onChanged, onError, onImported }: { onChanged: () => void | Promise<void>; onError: (message: string) => void; onImported: (npub: string) => void }) {
  const [isGeneratingIdentity, setIsGeneratingIdentity] = useState(false);
  const [generatedIdentity, setGeneratedIdentity] = useState<{ nsec: string; npub: string } | null>(null);
  const [hasBackedUpNsec, setHasBackedUpNsec] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importNsec, setImportNsec] = useState('');
  const [showImportNsec, setShowImportNsec] = useState(false);
  const [importError, setImportError] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // A reload while the new key is on screen would lose its only display.
  useEffect(() => {
    if (!generatedIdentity) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [generatedIdentity]);

  const copyText = (text: string, label: string) => {
    copyToClipboard(text, () => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    });
  };

  const handleGenerateIdentity = async () => {
    setIsGeneratingIdentity(true);
    try {
      const res = await api<{ nsec: string; npub: string; status: string }>('/api/identity/generate', {
        method: 'POST',
        body: JSON.stringify({})
      });
      setGeneratedIdentity({ nsec: res.nsec, npub: res.npub });
      setHasBackedUpNsec(false);
      void onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'No se pudo crear la identidad.');
    } finally {
      setIsGeneratingIdentity(false);
    }
  };

  const openImport = () => {
    setImportError('');
    setImportNsec('');
    setShowImportNsec(false);
    setIsImportModalOpen(true);
  };
  const closeImport = () => {
    setIsImportModalOpen(false);
    setImportNsec('');
    setImportError('');
  };

  const handleImportIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importNsec.trim()) return;
    setIsImporting(true);
    setImportError('');
    try {
      const res = await api<{ npub: string; status: string }>('/api/identity/import', {
        method: 'POST',
        body: JSON.stringify({ nsec: importNsec.trim() })
      });
      setIsImportModalOpen(false);
      setImportNsec('');
      onImported(res.npub);
      void onChanged();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'No se pudo importar la clave.');
    } finally {
      setIsImporting(false);
    }
  };

  return {
    isGeneratingIdentity, generatedIdentity, setGeneratedIdentity, hasBackedUpNsec, setHasBackedUpNsec,
    isImportModalOpen, importNsec, setImportNsec, showImportNsec, setShowImportNsec, importError, isImporting,
    copiedField, copyText, handleGenerateIdentity, openImport, closeImport, handleImportIdentity,
  };
}

export type Identity = ReturnType<typeof useIdentity>;
