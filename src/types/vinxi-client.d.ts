/// <reference types="vite/client" />

// 本地垫片：vinxi 0.5.11 发布包缺少 dist/types/runtime/client.d.ts，
// 这里提供与 vinxi/client 等价的全局类型，供 tsconfig 的 types 引用。

declare interface Window {
  MANIFEST: {
    readonly [key: string]: {
      readonly [symbol: string]: unknown;
    };
  };
  manifest: any;
}

interface ImportMetaEnv {
  readonly MANIFEST: {
    readonly [key: string]: {
      readonly [symbol: string]: unknown;
    };
  };
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
