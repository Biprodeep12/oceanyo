"use client";

export default function Logo() {
  return (
    <div className="ze-panel flex items-center gap-2.5 px-3 py-2.5">
      <div
        className="grid h-9 w-9 flex-none place-items-center rounded-full"
        style={{
          background:
            "radial-gradient(circle at 32% 28%, #7fe3ff 0%, #2f8fd6 38%, #1b3f8f 72%, #10204a 100%)",
          boxShadow: "0 0 12px rgba(60,150,220,0.45) inset",
        }}
        aria-hidden
      >
        {/* A depth profile through a water column: the thing the app is for. */}
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="#eaf6ff" strokeWidth={1.8} strokeLinecap="round">
          <path d="M6 4v16" />
          <path d="M6 7c4 0 3 4 6 4s3 5 6 5" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold tracking-[0.14em] text-[color:var(--ze-text)]">
          OCEAN
        </div>
        <div className="text-[10.5px] font-medium tracking-[0.1em] text-[color:var(--ze-text-dim)]">
          MODEL &middot; OBSERVATION
        </div>
      </div>
    </div>
  );
}
