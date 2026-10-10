/**
 * Asset module declarations.
 *
 * Metro bundles these extensions as assets and `require()`/import resolves to
 * a numeric asset id. Declared here so TypeScript accepts the import.
 */

declare module '*.mp4' {
  const asset: number;
  export default asset;
}

declare module '*.png' {
  const asset: number;
  export default asset;
}

declare module '*.jpg' {
  const asset: number;
  export default asset;
}
