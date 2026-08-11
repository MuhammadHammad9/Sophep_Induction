import type { Config } from 'tailwindcss'

/**
 * Design tokens — Architecture spec §18.2.
 *
 * Two of these are deliberate overrides of the design skill's output, and the reasons matter:
 *
 *  - Body text is #0F172A, NOT the navy #1E3A8A the skill returned. Blue body text fails the
 *    skill's own contrast rules and is measurably harder to read at 14px on a phone in a bright
 *    hall — which is exactly where volunteers use this.
 *  - The primary CTA is blue, NOT amber. Amber is reserved for WARNING semantics. This product
 *    is a state machine; one amber meaning both "primary button" and "you are offline" would
 *    create precisely the confusion the state colours exist to eliminate.
 *
 * State colours are the core of the interface (§18.3). Every state also carries an icon and a
 * shape — colour is never the sole signal (rules.md R-060, NFR-A11Y-002).
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#1E40AF', hover: '#1D4ED8' },
        secondary: '#3B82F6',
        background: '#F8FAFC',
        surface: '#FFFFFF',
        border: { DEFAULT: '#E2E8F0', strong: '#CBD5E1' },
        text: { DEFAULT: '#0F172A', muted: '#475569' },

        // §18.3 — state colours. Pair every one with an icon and a shape.
        state: {
          waiting:  { DEFAULT: '#64748B', fill: '#F1F5F9' }, // hollow dot
          live:     { DEFAULT: '#2563EB', fill: '#EFF6FF' }, // pulsing dot
          called:   { DEFAULT: '#D97706', fill: '#FFFBEB' }, // solid 4px left bar
          complete: { DEFAULT: '#059669', fill: '#ECFDF5' }, // check
          blocked:  { DEFAULT: '#DC2626', fill: '#FEF2F2' }, // cross
          offline:  { DEFAULT: '#B45309', fill: '#FFFBEB' }, // banner + diagonal stripes
        },
      },
      fontFamily: {
        // Fira Sans for ALL interface text. Fira Mono reserved for applicant IDs, clock times
        // and counts — monospace stops digits jittering as counters tick, and makes
        // SPH-SP26-0042 instantly scannable across a noisy hall.
        sans: ['"Fira Sans"', 'system-ui', 'sans-serif'],
        mono: ['"Fira Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        display: ['32px', { lineHeight: '40px', fontWeight: '600' }],
        h1:      ['24px', { lineHeight: '32px', fontWeight: '600' }],
        h2:      ['20px', { lineHeight: '28px', fontWeight: '600' }],
        body:    ['16px', { lineHeight: '24px', fontWeight: '400' }],
        small:   ['14px', { lineHeight: '20px', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '500', letterSpacing: '0.04em' }],
        'id-xl': ['28px', { fontWeight: '500' }],
        'id-md': ['18px', { fontWeight: '500' }],
        'id-sm': ['14px', { fontWeight: '500' }],
      },
      spacing: {
        // 44px minimum touch target, 8px minimum gap (R-061, NFR-A11Y-003)
        touch: '44px',
      },
      borderRadius: { card: '12px', control: '8px', pill: '999px' },
      transitionDuration: { fast: '150ms', DEFAULT: '250ms' },
    },
  },
  plugins: [],
}

export default config
