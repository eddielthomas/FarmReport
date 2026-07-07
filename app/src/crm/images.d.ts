// Ambient module declarations so TS treats bundled image imports as URL strings
// (Vite resolves `import url from './x.jpg'` to the emitted asset URL at build time).
declare module '*.jpg' { const src: string; export default src; }
declare module '*.jpeg' { const src: string; export default src; }
declare module '*.png' { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.svg' { const src: string; export default src; }
