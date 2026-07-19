import type { ReactElement } from 'react';
import { useState } from 'react';
import { Box, Button, Text, TextInput } from '@mantine/core';
import { IconServer } from '@tabler/icons-react';
import { LoreLogo } from './LoreLogo';

interface ConnectPageProps {
  readonly initialAddress: string;
  readonly onConnect: (address: string) => void;
}

export function ConnectPage({ initialAddress, onConnect }: ConnectPageProps): ReactElement {
  const [address, setAddress] = useState(initialAddress);
  const canConnect = address.trim().length > 0;

  const handleConnect = (): void => {
    if (canConnect) {
      onConnect(address);
    }
  };

  return (
    <>
      <Box style={{ textAlign: 'center', marginBottom: 40 }}>
        <LoreLogo variant='type' width='260px' style={{ margin: '0 auto 24px' }} />
        <Text size='xs' c='dimmed' opacity={0.6}>
          Enter your Lore server address — lores:// for TLS, or lore:// for local servers without
          TLS
        </Text>
      </Box>
      <TextInput
        size='md'
        leftSection={<IconServer size={18} />}
        placeholder='lores://lore.example.com'
        value={address}
        onChange={event => setAddress(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            handleConnect();
          }
        }}
        radius='md'
        styles={{
          input: {
            backgroundColor: 'transparent',
            border: '1px solid var(--hair)',
          },
        }}
      />
      <Button
        fullWidth
        size='lg'
        onClick={handleConnect}
        disabled={!canConnect}
        radius='md'
        styles={{
          root: {
            height: '48px',
            fontWeight: 600,
            fontSize: '16px',
          },
        }}
      >
        Connect
      </Button>
    </>
  );
}
