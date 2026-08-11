import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SOPHEP Induction',
  description: 'SOPHEP recruitment and induction management',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // NFR-A11Y: never block zoom. maximumScale=1 is a WCAG failure and this is used on phones
  // by people trying to read a small ID in bad light.
  maximumScale: 5,
  themeColor: '#1E40AF',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only-focusable absolute left-4 top-4 z-50 rounded-control bg-primary px-4 py-2 text-white"
        >
          Skip to main content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  )
}
