import { useCallback, useState } from 'react';

// The Lore server address is provided by the user on the connect page and
// persisted locally so it survives restarts
export const SERVER_ADDRESS_STORAGE_KEY = 'lore-server-address';

export interface ServerConnection {
  readonly serverUrl: string | null;
  readonly isConnected: boolean;
  readonly lastKnownAddress: string;
  readonly connect: (address: string) => void;
  readonly disconnect: () => void;
}

export function useServerConnection(): ServerConnection {
  const [serverUrl, setServerUrl] = useState<string | null>(() =>
    localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY)
  );

  const connect = useCallback((address: string): void => {
    const trimmed = address.trim();
    if (!trimmed) {
      return;
    }
    // Default bare addresses to the TLS scheme (secure by default); the
    // transport treats scheme-less hosts as TLS anyway, this makes it
    // visible. Explicit schemes (e.g. lore:// for plaintext local servers)
    // are kept as entered.
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const normalized = hasScheme ? trimmed : `lores://${trimmed}`;
    localStorage.setItem(SERVER_ADDRESS_STORAGE_KEY, normalized);
    setServerUrl(normalized);
  }, []);

  // Returns to the connect page; the stored address is kept as the prefill
  const disconnect = useCallback((): void => {
    setServerUrl(null);
  }, []);

  return {
    serverUrl,
    isConnected: serverUrl !== null,
    lastKnownAddress: serverUrl ?? localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY) ?? '',
    connect,
    disconnect,
  };
}
