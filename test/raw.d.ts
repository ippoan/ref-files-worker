// `?raw` import suffix is a vite/vitest convention — load the file as a string.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
