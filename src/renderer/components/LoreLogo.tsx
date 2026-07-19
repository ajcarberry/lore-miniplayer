import type { CSSProperties, ReactElement } from 'react';
import { Image, useComputedColorScheme } from '@mantine/core';
import LogotypeBlack from '/Lore_Black_V1.svg';
import LogotypeWhite from '/Lore_White_V1.svg';
import LogomarkBlack from '/Lore_Icon_Black_V1.svg';
import LogomarkWhite from '/Lore_Icon_White_V1.svg';

interface LoreLogoProps {
  // 'mark' is the square logomark icon; 'type' is the full logotype wordmark.
  readonly variant: 'mark' | 'type';
  // Size along one axis; the other stays 'auto'. Pass exactly one.
  readonly height?: string;
  readonly width?: string;
  // Extra styles merged over the size (e.g. the connect page's margins).
  readonly style?: CSSProperties;
}

// The theme-aware Lore logo: picks the white asset on dark parchment and the
// black asset on light, tagging the rendered variant via data-variant so the
// choice stays observable in tests.
export function LoreLogo({ variant, height, width, style }: LoreLogoProps): ReactElement {
  const colorScheme = useComputedColorScheme('light');
  const isDark = colorScheme === 'dark';
  const src =
    variant === 'mark'
      ? isDark
        ? LogomarkWhite
        : LogomarkBlack
      : isDark
        ? LogotypeWhite
        : LogotypeBlack;
  const sizeStyle: CSSProperties =
    width !== undefined ? { width, height: 'auto' } : { height, width: 'auto' };

  return (
    <Image
      src={src}
      alt='Lore'
      data-variant={isDark ? 'white' : 'black'}
      style={{ ...sizeStyle, ...style }}
    />
  );
}
