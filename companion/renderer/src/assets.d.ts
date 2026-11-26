/** A picture imported by a part (the app icon in the title row): Vite hands back its URL in the build. */
declare module '*.png' {
  const src: string;
  export default src;
}
