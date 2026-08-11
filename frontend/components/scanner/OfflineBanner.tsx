'use client'

/**
 * Offline banner component conforming to NFR-A11Y-002 and check-in offline specs.
 * Uses amber background with distinct diagonal stripes so colour is never the only signal.
 */
export function OfflineBanner({ pendingCount }: { pendingCount: number }) {
  return (
    <div 
      className="w-full bg-amber-500 text-black px-4 py-2 flex items-center justify-between shadow-md z-50 relative overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <div 
        className="absolute inset-0 opacity-20 pointer-events-none" 
        style={{
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, #000 10px, #000 20px)'
        }}
        aria-hidden="true"
      />
      
      <div className="relative font-bold flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
        </svg>
        <span>Offline — {pendingCount} pending sync</span>
      </div>
    </div>
  )
}
