/// <reference types="electron-vite/node" />

// Vite's `?raw` suffix: the file's text, inlined into the bundle at build time (main/news/feed.ts).
declare module '*?raw' {
  const text: string
  export default text
}
